/**
 * 压缩旧会话（/bc，内部代号「精压」/BC）—— 唯一实现（M2 正式版 / M6 预览 + 确认 + 取消）。
 *
 * 不再包装原生 compactNow，走自建事务：
 *   选段（跳过旧摘要 = 不二压）→ 摘要（结构化 prompt）→ 替换历史。
 *
 * 泄压阀：摘要份数到 thresholds.maxSummaries 后，选段不再受「最后 checkpoint 之后」
 * 约束（core/policy.compactionPolicy → dsh/select-range 的 afterSeq=undefined），
 * 旧摘要会被新摘要一并覆盖（合并），防止摘要无限堆积。
 *
 * M6 起分三步走：
 *   1. previewBetterCompact —— 只算「能压多少」，不写任何东西（/bc 与菜单先走它）；
 *   2. betterCompact —— 真正执行（/bc confirm 或确认卡按钮）；
 *   3. cancelBetterCompact —— 执行中取消（HTTP cancel → deps.inflight 里的 AbortController）。
 * 预览与执行共用 planCompact，保证两边口径一致。
 */
import { createHash } from 'node:crypto';
import { actionError } from '../core/errors.js';
import { livePinnedSeqs } from '../dsh/session-view.js';
import { mergeValveOf } from '../core/policy.js';
import { suggestPinCandidates } from '../core/pin-suggest.js';
import { ROLE_LABELS, roleLabelOf } from '../core/pin-anchors.js';
import { DIRECTORY_MAX, buildFavoriteTitle, favoriteSeqsOf } from '../core/favorites.js';
import { favoriteMapOf } from '../dsh/favorites-file.js';
import { SUMMARY_INSTRUCTION } from '../core/prompts.js';
import { sumShadowedTokens, tokenOf } from '../core/tokens.js';
import { selectCompactableRange } from '../dsh/select-range.js';
import { measurePressure } from '../dsh/pressure.js';
import { countSummaries } from '../dsh/session-view.js';
import { actorOfTrigger } from '../core/attribution.js';
import { attributionLabelOf } from '../core/attribution-label.js';
import { runCompaction } from './compact-run.js';
import { withLock } from './lock.js';
import { beginInflight, cancelErrorOf, combinedSignal, finishInflight } from './support.js';
import { withActionEvent } from './evented.js';

/** 范围小于这个 token 数时，摘要大概率比原文大：预览阶段就提示、前端据此禁用确认（0.3.1）。 */
const MIN_MEANINGFUL_TOKENS = 800;

/**
 * 无正文条目的占位标题（与 core/favorites.buildFavoriteTitle 的占位一致）。
 * 预览卡里替换成「第 <seq> 条」——不改 buildFavoriteTitle 本身，避免影响压缩摘要的收藏目录。
 */
const NO_TEXT_TITLE = '（无文本）';

/**
 * 预览「建议先收藏」只保留用户/助手消息：工具结果里的报错堆栈噪声太大（真机候选全是工具）。
 * 工具输出不进建议，但用户仍可手动点星收藏（favorited 列表不过滤）。
 */
const SUGGEST_ROLE_LABELS = new Set([ROLE_LABELS['user/message'], ROLE_LABELS['assistant/message']]);

/** 容量数字的紧凑写法（与浏览器半 `20-format.js` 的 fmt 保持同一口径）。 */
function fmtTokens(tokens) {
  if (!Number.isFinite(tokens)) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

/**
 * 预览计划缓存（架构 A3）。
 *
 * 「用户看到的范围」与「点确认后实际压的范围」必须是同一份数据：
 * preview 记下 planId + 范围，confirm 带 planId 回来；宿主重算发现不一致就拒绝。
 * 按会话存，5 分钟过期；`/bc confirm` 从这里取（HTTP 客户端则显式带 expected）。
 */
const PREVIEW_TTL_MS = 5 * 60_000;
const previewPlans = new Map();

function planIdOf(range) {
  return createHash('sha256')
    .update(`${range.startSeq}:${range.endSeq}:${range.shadowedSeqs.join(',')}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 取出并消费一次预览计划；过期/不存在返回 null。
 * @param {string|undefined} sessionId
 * @returns {{planId:string,startSeq:number,endSeq:number,shadowedSeqs:number[]}|null}
 */
export function takePreviewPlan(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const entry = previewPlans.get(sessionId);
  if (entry === undefined) return null;
  if (entry.expiresAt < Date.now()) {
    previewPlans.delete(sessionId);
    return null;
  }
  return {
    planId: entry.planId,
    startSeq: entry.startSeq,
    endSeq: entry.endSeq,
    shadowedSeqs: [...entry.shadowedSeqs],
  };
}

/** 测试用：清空预览缓存。 */
export function clearPreviewPlans() {
  previewPlans.clear();
}

/**
 * 算一遍「这次能压什么」—— 预览与正式执行共用，保证两边口径一致。
 * @param {{ctx:object, cfg:object, engine:object}} deps
 * @param {object} agent
 */
async function planCompact(deps, agent) {
  const measured = await measurePressure(deps.ctx, agent, { windowFallback: deps.cfg.contextWindowFallback });
  const nodes = measured.nodes.filter((node) => Number.isInteger(node?.seq));

  const summaries = countSummaries(agent.session);
  // 0.5.6-B：泄压阀状态（merges 判据是压缩**开始时**的份数，单向棘轮）。
  // 选段仍由 selectCompactableRange 自己调 compactionPolicy，这里只负责把同一份
  // 结论透给预览/状态/文案；不改任何判定。
  const mergeValve = mergeValveOf({ summaries, thresholds: deps.cfg.thresholds });
  // 只把「当前 surface 上还在」的钉住消息算进去：过期 seq 不该再劝用户 /unpin。
  const pinned = livePinnedSeqs(agent.session);

  const range = selectCompactableRange({
    session: agent.session,
    nodes,
    engine: deps.engine,
    cfg: deps.cfg,
    tokenOf,
  });

  return { measured, nodes, summaries, mergeValve, range, pinned, planId: range === null ? null : planIdOf(range) };
}

function rememberPreviewPlan(sessionId, plan) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;
  previewPlans.set(sessionId, { ...plan, expiresAt: Date.now() + PREVIEW_TTL_MS });
}

/**
 * 没有可压范围时给用户的解释——被钉住挡住时要指出来，否则用户不知道去 /unpin。
 * @param {number[]|undefined} pinned
 */
function noRangeMessage(pinned) {
  return pinned !== undefined && pinned.length > 0
    ? `暂无可压缩内容：有 ${pinned.length} 条消息被「锁定」保护，请先解锁再试（/unpin）。`
    : '暂无可压缩内容（当前会话太短，或近期会话需保留原文）。';
}

/**
 * 压缩本体（不加锁、不登记）—— 交接要先压缩旧会话，复用这一份实现，不要各写一遍。
 * @param {{ctx:object, cfg:object, lock:object, engine:object}} deps
 * @param {{agent:object, signal?:AbortSignal, commandId?:string, trigger?:string,
 *   onPlan?:(info:object)=>void}} input
 *   trigger：0.5.6 D1 归属口径（省略 = 'unknown'，不猜）；
 *   onPlan：内部钩子，范围算完/执行前回调一次（菜单路径用它写失败时的归属上下文）。
 */
export async function betterCompactLocked(deps, {
  agent,
  signal,
  commandId,
  expected,
  ledgerRecord = true,
  trigger = 'unknown',
  onPlan,
}) {
  const startedAt = Date.now();
  if (agent === undefined || agent === null) throw actionError('nosession', '没有活动会话');
  const session = agent.session;

  const plan = await planCompact(deps, agent);
  const { nodes, mergeValve, summaries, range, pinned, planId } = plan;

  // 架构 A3：确认必须绑定同一段范围。重算后发现不是用户看过的那一段 → 拒绝，不写任何东西。
  if (range !== null && expected !== undefined && expected !== null) {
    if (typeof expected !== 'object' || typeof expected.planId !== 'string' || expected.planId !== planId) {
      throw actionError('changed', '会话在确认期间又更新了，压缩范围已变；请重新预览后再确认。');
    }
  }

  if (range === null) {
    return {
      ok: true,
      compacted: false,
      planId: null,
      message: noRangeMessage(pinned),
    };
  }

  const freshRange = { ...range, shadowedTokenCount: sumShadowedTokens(nodes, range.shadowedSeqs) };

  // 0.5.6 D1：执行前把「这次要压什么」交给入口（写事件 context 用）。
  // 失败（摘要不合格/取消/事务失败）时也能留下范围，不必等成功返回。
  try {
    onPlan?.({
      range: freshRange,
      summaries,
      merged: mergeValve.merges,
      pinned: pinned.length,
    });
  } catch {
    /* 归属钩子失败不影响压缩 */
  }

  const outcome = await runCompaction(deps, {
    agent,
    session,
    range: freshRange,
    instruction: SUMMARY_INSTRUCTION,
    signal,
    commandId,
    // 0.5.6 D1：trigger 由入口登记，缺省 'unknown'（不猜）。
    trigger,
    // 0.5.6 D2：checkpoint 归属行要写「是否合并了旧摘要」（内存里的泄压阀判定，不猜）。
    merged: mergeValve.merges === true,
    inputTokens: plan.measured.tokens,
    // 正式精压继承配置超时（/bctest 不传、保持 llm-call 的 180s 默认）。
    timeoutMs: deps.cfg.timeouts?.llmMs,
  });

  // 0.5.6-B：合并时把「从会话开头」升进主句；保留「同时合并了旧摘要」子串（e2e 契约）。
  const note = mergeValve.merges
    ? '，并从会话开头合并了此前全部旧摘要（同时合并了旧摘要，不可还原）'
    : summaries > 0
      ? '，旧摘要保持原样'
      : '';
  const pinNote = range.pinnedCut === true ? `，已跳过 ${range.pinnedKept} 条锁定的消息` : '';
  // 0.4 P1-3：轻账本（只记数值，不含消息/摘要/交接单正文）。任何异常静默——
  // 账本绝不能影响压缩本体。交接内部复用本函数时传 ledgerRecord=false，避免一次交接记两条。
  if (ledgerRecord === true) {
    try {
      const afterMeasured = await measurePressure(deps.ctx, agent, { windowFallback: deps.cfg.contextWindowFallback }).catch(() => null);
      deps.ledger?.record?.({
        kind: 'compact',
        durationMs: Date.now() - startedAt,
        beforeTokens: plan.measured.tokens,
        afterTokens: afterMeasured === null ? null : afterMeasured.tokens,
        beforeRatio: plan.measured.ratio,
        afterRatio: afterMeasured === null ? null : afterMeasured.ratio,
        pinHits: { inRange: range.pinnedCut === true ? range.pinnedKept : 0, total: pinned.length },
      });
    } catch {
      /* 账本静默降级：磁盘满/不可写都不影响压缩结果 */
    }
  }
  return {
    ok: true,
    compacted: true,
    // A3/A5：把被批准的范围 id 带出动作层（交接链记录/0.4 diff 可引用）。
    planId,
    // 0.5.6 D1：归属行要用（不传 = 不知道，不猜）。
    summariesBefore: summaries,
    merged: mergeValve.merges,
    // 0.4 P1-3：交接记录要复用「压缩时跳过了多少锁定消息」。
    ...(range.pinnedCut === true ? { pinnedKept: range.pinnedKept } : {}),
    ...outcome,
    // 0.5.6 D2：完成反馈里直接写清归属（HTTP action:'compact' 的 message 与 /bc confirm
    // 的命令卡共用这一句）；actor 由 trigger 推出，与事件流/投影同一口径。
    message: `压缩完成：${outcome.shadowedSeqs.length} 条旧会话 → 1 条摘要（腾出约 ${outcome.shadowedTokenCount} 容量${note}${pinNote}）。归属：${attributionLabelOf({ trigger, actor: actorOfTrigger(trigger) })}`,
  };
}

/**
 * 压缩预览：只算范围与 token，不写会话日志。
 * @param {{ctx:object, cfg:object, lock:object, engine:object}} deps
 * @param {{agent:object}} input
 */
export async function previewBetterCompact(deps, { agent, trigger } = {}) {
  if (agent === undefined || agent === null) throw actionError('nosession', '没有活动会话');
  return withActionEvent(deps, { action: 'preview', trigger, agent, phase: 'guard' }, async (event) => {
  if (typeof deps.lock?.isBusy === 'function' && deps.lock.isBusy(agent.id)) {
    throw actionError('busy', '当前会话正在压缩或交接，请等完成后再预览');
  }

  const { measured, nodes, range, pinned, planId, summaries, mergeValve } = await planCompact(deps, agent);
  if (range === null) {
    event.context = { pinned: pinned.length };
    return {
      ok: true,
      compacted: false,
      preview: null,
      message: noRangeMessage(pinned),
    };
  }

  const shadowedTokenCount = sumShadowedTokens(nodes, range.shadowedSeqs);
  event.context = {
    nodes: range.shadowedSeqs.length,
    tokens: measured.tokens,
    ratio: measured.ratio,
    shadowedTokens: shadowedTokenCount,
    summaries,
    allowMergeOldSummaries: mergeValve.merges,
    pinned: pinned.length,
  };
  // 0.4 P1-1 / 0.6：对「本次将被压掉的历史」做本地启发式，挑出值得先收藏的消息。
  // 只提示、绝不自动收藏：这里不写任何收藏记录，收藏动作仍由用户点星/点卡内按钮触发。
  // （字段名沿用 pinSuggest 只为不扩散契约；语义已从「建议锁定」转成「建议收藏」。）
  const suggestEvents = range.shadowedSeqs.map((seq) =>
    typeof agent.session?.eventAt === 'function' ? agent.session.eventAt(seq) : undefined,
  );
  const pinSuggestItems = suggestPinCandidates(suggestEvents);
  // 0.4 P1-2：pin 保留契约命中数——inRange = 本次候选范围里被锁定保护而跳过的条数；
  // total = 当前会话仍活着的锁定总数（范围外也可能有锁定）。
  const pinHits = { inRange: range.pinnedCut === true ? range.pinnedKept : 0, total: pinned.length };
  // 0.6 收藏提醒：压缩后被压掉的消息就点不了星了，预览时先把「本段已收藏多少条」摆出来。
  const favoriteSeqs = new Set(favoriteSeqsOf(favoriteMapOf(deps.ctx, agent.session), agent.session.id));
  // 0.6 预览卡收藏区：本段已收藏的「条目」（不只是个数）——角色复用 pin-anchors 的
  // roleLabelOf，标题复用 favorites 的 buildFavoriteTitle（与 /favorite list 同一口径）。
  // 只读：这里不写任何收藏记录；列表条数按 DIRECTORY_MAX 截断（favoritedCount 仍是全量数）。
  // 0.5.4 D2：无正文条目（图/纯工具输出等）的标题兜底成「第 <seq> 条」，让人能按序号找到；
  // 不改 core/favorites.buildFavoriteTitle（那里是摘要目录口径，动了会影响压缩摘要）。
  const favoriteItems = range.shadowedSeqs
    .filter((seq) => favoriteSeqs.has(seq))
    .map((seq) => {
      const event = typeof agent.session?.eventAt === 'function' ? agent.session.eventAt(seq) : undefined;
      const title = buildFavoriteTitle(event);
      return { seq, role: roleLabelOf(event?.type), title: title === NO_TEXT_TITLE ? `第 ${seq} 条` : title };
    });
  const favoriteInRange = favoriteItems.length;
  // 「建议补收藏」= 同一套 pinSuggest 识别，只去掉本段里已经收藏过的 seq（语义从
  // 「建议锁定」改成「建议收藏」，不新写启发式）。仍是只提示：收藏动作由用户点按钮触发。
  // 0.5.4 D1：只保留用户/助手——工具结果里的报错堆栈噪声太大（真机 5 条候选全是工具），
  // 工具输出仍可由用户手动收藏（favorited 列表不过滤，只过滤「建议」）。
  // 注意 suggestPinCandidates 的 limit 在角色过滤之前生效：工具候选可能占满 5 个名额，
  // 直接过滤会把本可入选的用户/助手候选挤掉。所以混进工具时，用**同一个函数**对
  // 「只看用户/助手的事件」再跑一遍拿足候选（不新写启发式；没有工具时不重跑，零额外开销）。
  const humanSuggestItems = pinSuggestItems.some((item) => !SUGGEST_ROLE_LABELS.has(item.role))
    ? suggestPinCandidates(suggestEvents.filter((event) => SUGGEST_ROLE_LABELS.has(roleLabelOf(event?.type))))
    : pinSuggestItems;
  const favoriteSuggestItems = humanSuggestItems.filter(
    (item) => !favoriteSeqs.has(item.seq) && SUGGEST_ROLE_LABELS.has(item.role),
  );
  rememberPreviewPlan(agent.id, {
    planId,
    startSeq: range.startSeq,
    endSeq: range.endSeq,
    shadowedSeqs: range.shadowedSeqs,
  });
  // 0.3.1：小范围压缩大概率「摘要比原文还大」被拒，预览阶段就提示并让前端禁用确认。
  const tooSmall = shadowedTokenCount < MIN_MEANINGFUL_TOKENS;
  return {
    ok: true,
    compacted: false,
    planId,
    preview: {
      nodes: range.shadowedSeqs.length,
      tokens: shadowedTokenCount,
      startSeq: range.startSeq,
      endSeq: range.endSeq,
      planId,
      tooSmall,
      // 0.5.6-B：本次泄压阀状态（additive；老客户端忽略）。
      //   merges = 本次是否从会话开头合并旧摘要；normalLeft = 还剩几次常规压缩（不限时 null）。
      merge: mergeValve,
      // 0.4 P1-1：建议锁定候选（客户端只渲染；不含原文全文，snippet ≤60 字符）。
      pinSuggest: { count: pinSuggestItems.length, items: pinSuggestItems },
      // 0.4 P1-2：pin 命中数（范围内/范围外分开说明）。
      pinHits,
      // 0.6：本段收藏命中数（inRange/total）——压缩后无法再收藏，提醒用户先点。
      favoriteHits: { inRange: favoriteInRange, total: range.shadowedSeqs.length },
      // 0.6+ 预览卡收藏区（additive，不改上面任何既有字段）：客户端只渲染，压缩事务不消费。
      //   total = 本段条数；favoritedCount = 本段已收藏全量条数（favorited 最多列 DIRECTORY_MAX 条）；
      //   favorited = [{seq, role, title}]；suggest = 本段未收藏、值得先收藏的候选（seq/role/reason/snippet）。
      // 红线：只提示，绝不自动收藏——本函数不写收藏记录、不调动作层。
      favoritePreview: {
        total: range.shadowedSeqs.length,
        favoritedCount: favoriteInRange,
        favorited: favoriteItems.slice(0, DIRECTORY_MAX),
        suggest: favoriteSuggestItems,
      },
      ...(range.pinnedCut === true ? { pinnedKept: range.pinnedKept } : {}),
    },
    message:
      // 0.5.6-B：合并时把「本次是合并压缩」放到句首，不能只让用户从条数跳变里猜。
      (mergeValve.merges
        ? `本次是合并压缩（已达到摘要上限 ${mergeValve.summaries}/${mergeValve.maxSummaries} 份）：从会话开头连同全部旧摘要一起压。`
        : '') +
      `压缩预估：将把 ${range.shadowedSeqs.length} 条旧会话压成 1 条摘要` +
      `（腾出约 ${fmtTokens(shadowedTokenCount)} tokens${range.pinnedCut === true ? `，已跳过 ${range.pinnedKept} 条锁定的消息` : ''}）。` +
      (favoriteSuggestItems.length > 0
        ? `建议先点星收藏：这 ${favoriteSuggestItems.length} 条还没收藏，看起来是关键决策/报错堆栈/明确要求别改（只提示，不会自动收藏）。`
        : '') +
      (favoriteInRange >= range.shadowedSeqs.length
        ? `本段 ${range.shadowedSeqs.length} 条已全部收藏（压缩会把原文留档）。`
        : `本段 ${range.shadowedSeqs.length} 条里已收藏 ${favoriteInRange} 条；压缩后被压掉的消息就点不了星了，重要的先点一下收藏。`) +
      (tooSmall
        ? `这段偏小，压了可能反而更大；建议再聊几轮或把「保留近期原文」调小后再压缩。`
        : '只估算范围和容量，摘要内容确认后才生成。') +
      (tooSmall ? '' : '确认执行：/bc confirm'),
  };
  });
}

/**
 * 请求取消正在跑的压缩。
 * @param {{inflight?:object}} deps
 * @param {{agent?:object}} [input]
 */
export function cancelBetterCompact(deps, { agent, trigger } = {}) {
  const kind = deps.inflight?.kindOf?.(agent?.id) ?? null;
  const found =
    deps.inflight !== undefined &&
    typeof deps.inflight.cancel === 'function' &&
    deps.inflight.cancel(agent?.id);
  const outcome = found
    ? {
        ok: true,
        cancelled: true,
        kind,
        message:
          kind === 'handoff'
            ? '已请求取消交接（已完成的压缩不会回滚）。'
            : '已请求取消压缩（会话记录不会改动）。',
      }
    : { ok: false, cancelled: false, kind: null, message: '当前没有正在进行的压缩/交接任务。' };
  // A 级动作留档：cancel 是同步动作，手工补 start/end（成对；永不抛）。
  try {
    const started = deps.events?.start?.({
      action: 'cancel',
      trigger,
      agent,
      context: kind === null ? undefined : { inflight: kind },
    });
    deps.events?.end?.({
      id: started?.id,
      action: 'cancel',
      outcome: 'ok',
      code: null,
      context: kind === null ? undefined : { inflight: kind },
    });
  } catch {
    /* 记录失败不影响取消结果 */
  }
  return outcome;
}

/**
 * 压缩动作入口：带每会话单飞锁 + 可取消登记。
 * @param {{ctx:object, cfg:object, lock:object, engine:object, inflight?:object}} deps
 * @param {{agent:object, signal?:AbortSignal, commandId?:string}} input
 */
export async function betterCompact(deps, input = {}) {
  if (input?.agent === undefined || input?.agent === null) throw actionError('nosession', '没有活动会话');
  const agent = input.agent;
  // 0.5.6 D1：缺省 'unknown'（HTTP 已归一；命令/交接入口显式传值）。
  const trigger = typeof input.trigger === 'string' && input.trigger.length > 0 ? input.trigger : 'unknown';
  return withActionEvent(deps, { action: 'compact', trigger, agent, phase: 'guard' }, async (event) => {
    const controller = beginInflight(deps, agent.id, 'compact');
    const signal = combinedSignal(controller?.signal, input.signal);

    try {
      const outcome = await withLock(deps.lock, agent.id, () =>
        betterCompactLocked(deps, {
          ...input,
          trigger,
          signal,
          // 执行前先写范围（失败也留档）；成功返回时再补 model 等字段。
          onPlan: ({ range, summaries, merged, pinned }) => {
            event.context = {
              nodes: range.shadowedSeqs.length,
              startSeq: range.startSeq,
              endSeq: range.endSeq,
              shadowedTokens: range.shadowedTokenCount,
              summaries,
              allowMergeOldSummaries: merged,
              merged,
              pinned,
            };
          },
        }),
      );
      if (outcome !== null && typeof outcome === 'object') {
        if (typeof outcome.planId === 'string') event.planId = outcome.planId;
        if (typeof outcome.compactionId === 'string') event.compactionId = outcome.compactionId;
        if (outcome.compacted === true) {
          event.context = {
            nodes: Array.isArray(outcome.shadowedSeqs) ? outcome.shadowedSeqs.length : undefined,
            startSeq: outcome.startSeq,
            endSeq: outcome.endSeq,
            shadowedTokens: outcome.shadowedTokenCount,
            summaries: outcome.summariesBefore,
            allowMergeOldSummaries: outcome.merged,
            merged: outcome.merged,
            // 0.5.6 D1：摘要模型（additive；拿不到就不写）。
            ...(typeof outcome.model === 'string' && outcome.model.length > 0 ? { model: outcome.model } : {}),
            ...(Number.isFinite(outcome.pinnedKept) ? { pinnedKept: outcome.pinnedKept } : {}),
          };
        }
      }
      return outcome;
    } catch (error) {
      // 取消 → 统一成 cancelled 文案（宿主 HTTP 层据此回「历史没改」）。
      throw cancelErrorOf(error, signal, '已取消，会话记录没有改动。');
    } finally {
      finishInflight(deps, agent.id, controller);
    }
  });
}
