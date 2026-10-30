/**
 * 状态快照 —— 唯一的「当前上下文怎么样」。
 *
 * 指示灯、菜单、命令前置检查都读这一份；交接单的现场信息由 actions/handoff
 * 直接调 dsh/pressure + dsh/session-view（不走这里）。客户端不再自己算阈值。
 */
import { paletteForBothSchemes } from '../core/colors.js';
import { favoriteStateOf } from '../dsh/favorites-file.js';
import { adviceFor, mergeValveOf, ratioOf, thresholdsForWindow } from '../core/policy.js';
import { nativePinnedRiskOf } from '../core/native-pin-risk.js';
import { pinHealthOf } from '../core/pin-health.js';
import { latestPinnedSeqs } from '../core/pins.js';
import { tokenOf } from '../core/tokens.js';
import { measurePressure, routeBudgetOf } from '../dsh/pressure.js';
import { selectCompactableRange } from '../dsh/select-range.js';
import { compressHint as compressHintOf, countSummaries, firstCompactableIdx, lastCheckpointSurfaceSeq, liveSessionOf, pickAgent, sessionLog, surfaceSeqs } from '../dsh/session-view.js';
import { compressHintIsActive } from '../core/compress-hint.js';
import { readNativeCompaction, resolveNativePolicy } from '../dsh/native-compaction.js';
import { nativeLineOf, nativeRetainTokensOf } from '../core/native-line.js';
import { legacyChainParentIdOf, legacyRelayChainOf, relayChainOf, relayInboundRecordOf, relayOutboundRecordOf, relayRecordOf } from '../dsh/relay.js';
import { isSessionArchived, isSessionPinned, workspaceRegistryOf } from '../dsh/handoff-archive.js';
import { sourceTitleOf } from '../dsh/sessions.js';

/**
 * 动作层统一解析「这次动作作用在哪个 agent」：只认显式 sessionId，
 * 找不到就是 null（不允许退化成「最后一个 agent」压错会话）。
 * A9：HTTP 适配层不再直接 import dsh/session-view.pickAgent。
 * @param {{ctx:object}} deps
 * @param {{sessionId?:string}} [input]
 * @returns {object|null}
 */
export function resolveTarget(deps, { sessionId } = {}) {
  return pickAgent(deps.ctx, sessionId);
}

/**
 * 状态帧的单调版本号（P3-12）。
 *
 * 轮询响应与 SSE 帧走同一个 readState，网络乱序时旧响应可能晚到并覆盖新状态。
 * 这里给每帧一个进程内单调递增的 revision：浏览器端只接受更大的那一帧。
 * 只加字段（不破坏既有 HTTP 契约），旧客户端忽略它即可。
 */
let stateRevision = 0;

/**
 * 把 live session 包成 readState 认识的「类 agent」（只需要 id + session）。
 * @param {object|undefined} session
 * @returns {object|null}
 */
function passivized(session) {
  return session === undefined || session === null ? null : { id: session.id, session };
}

/**
 * @param {{ctx:object, cfg:object, lock:object}} deps
 * @param {{sessionId?:string, agent?:object}} [target]
 */
export async function readState(deps, { sessionId, agent } = {}) {
  // 指定 agent 就用它；否则按 sessionId 找 agent，找不到但会话已加载 → 退化用 live session。
  // 后者修「刚重启、会话还没起 agent 时，指示灯数字为空/串会话」的坑。
  const picked = agent ?? pickAgent(deps.ctx, sessionId);
  const target = picked ?? passivized(liveSessionOf(deps.ctx, sessionId));

  const measured =
    target === null
      ? { tokens: null, surfaceTokens: null, window: deps.cfg.contextWindowFallback, ratio: 0, nodes: [] }
      : await measurePressure(deps.ctx, target, { windowFallback: deps.cfg.contextWindowFallback });

  const summaries = target === null ? 0 : countSummaries(target.session);
  // 阈值按「窗口比例」配置，这里换算成当前模型窗口的绝对 token 线；
  // 窗口从 resolveModelInfo 来（拿不到时 measurePressure 已回落到 contextWindowFallback）。
  const thresholdLines = thresholdsForWindow(deps.cfg.thresholds, measured.window);
  const advice = adviceFor({ pressure: measured.tokens, summaries, thresholds: thresholdLines });

  // 当前能不能精压（菜单里显示「可压 N 条 / 没有可压范围」，点击前就有明确反馈）。
  //
  // 0.3.5（外部用户报的「压缩按钮灰置」）：有 live session、但还没有活 agent
  // （target 是 passivized 的 live session）时也要算范围 —— selectCompactableRange
  // 只需要 session/nodes/engine/cfg，是纯显示信息；真实执行仍要求活 agent（preview
  // 需要 agent 去跑选段/事务）。否则会把「会话未激活」误显示成「没有可压缩内容」。
  const hasLiveAgent = picked !== undefined && picked !== null;
  let compactRange = null;
  if (target !== null) {
    const live = target.session ?? null;
    if (live !== null) {
      compactRange = selectCompactableRange({
        session: live,
        nodes: measured.nodes.filter((node) => Number.isInteger(node?.seq)),
        engine: deps.engine,
        cfg: deps.cfg,
        tokenOf,
      });
      compactRange =
        compactRange === null
          ? null
          : {
              nodes: compactRange.shadowedSeqs.length,
              tokens: compactRange.tokenCount,
              startSeq: compactRange.startSeq,
              endSeq: compactRange.endSeq,
              // 0.5.6-B：本次/之后的泄压阀状态（additive）。客户端据此显示「再压一次就到上限」
              // 与「本次就会全量合并」；口径与 preview.merge / compactionPolicy 同一份。
              merge: mergeValveOf({ summaries, thresholds: deps.cfg.thresholds }),
            };
    }
  }
  // 范围算出来了但没有活 agent：客户端据此区分「会话未激活（发一条消息唤醒 agent）」
  // 和「真的没有可压缩内容」。additive 字段，不破坏既有 HTTP 契约。
  const compactRangeReason = compactRange !== null && !hasLiveAgent ? 'no_agent' : null;

  // 0.5.6 D1：最近一次压缩归属 —— 从**同一份事件流**投影（不读第二份文件、不双写）。
  // 口径与 /api/compact-relay-attribution 完全一致（core/attribution）。
  // 没有目标会话 / 没有事件流 / 读失败 → null（不知道，不猜）。
  const lastCompaction = (() => {
    try {
      if (target === null || typeof deps.events?.compactions !== 'function') return null;
      const ids = [target.session?.id, target.id].filter((id) => typeof id === 'string' && id.length > 0);
      if (ids.length === 0) return null;
      return deps.events.compactions({ limit: 1, sessionIds: ids })[0] ?? null;
    } catch {
      return null;
    }
  })();

  // M6：钉住集合（菜单显示「清除钉住（N 条）」，也能在无 agent 时读 live session）。
  // 0.5.1 批 2（C 方案）：pin 快照 vs 当前 surface ——
  //   live  = 还在 surface 上（环/计数/解锁仍按这些）；
  //   stale = 快照里有、surface 上没了（原生压缩/其它压缩/历史变化带走）——
  //           单独下发，界面标「已失效」，既不假装还在，也不凭空消失。
  const surface = target === null ? [] : surfaceSeqs(target.session);
  const events = target === null ? [] : sessionLog(target.session);
  const pinHealth =
    target === null || surface.length === 0
      ? // 没有 surface（会话刚打开/尚未回放）时不能把全部 pin 判成失效：那是「还不知道」。
        { live: [], stale: [], cause: null, causes: { native: 0, other: 0, unknown: 0 } }
      : pinHealthOf({ pinnedSeqs: latestPinnedSeqs(events), surfaceSeqs: surface, log: events });
  const pinnedSeqs = pinHealth.live;
  // 0.3.1：锁定消息在 surface 里的相对位置（0–1，方案 A：消息在历史中的位置），
  // 指示灯环上按位置画锁定块；多个锁定按位置从早到晚排序。
  const surfaceIndex = new Map(surface.map((seq, index) => [seq, index]));
  const pinMarks = pinnedSeqs
    .filter((seq) => surfaceIndex.has(seq))
    .map((seq) => {
      const index = surfaceIndex.get(seq);
      const position = surface.length <= 1 ? 0 : index / (surface.length - 1);
      return { seq, ratio: Math.max(0, Math.min(1, position)) };
    })
    .sort((a, b) => a.ratio - b.ratio);

  // 0.3.1：模型的「这里适合压缩」判断（比最后一次压缩/交接 checkpoint 新才算数）。
  // 0.4 BUG-013：第二个参数（isCheckpointSource）以前漏传，session-view 里的
  // TypeError 被 try/catch 吞掉 → 永远找不到 checkpoint → 压缩/交接后旧 hint 不失效
  // （环上残留旧断点，还会用旧 ratio 抑制 cue）。这里显式传 engine 的判定函数。
  const checkpointSeq =
    target === null ? undefined : lastCheckpointSurfaceSeq(target.session, deps.engine?.isCompactCheckpointSource);
  const hint = target === null ? null : compressHintOf(target.session);
  const activeHint = compressHintIsActive(hint, checkpointSeq) ? { ratio: hint.ratio, at: hint.at, seq: hint.seq } : null;
  // 0.3.1：DSH 原生自动压缩配置（读 profile 的 cordis.patch.yml + DSH 默认值）。
  // 0.4 P2-3：deps.nativeConfig 仅给单测注入用；生产不传，仍读本机 profile。
  const nativeCfg = deps.nativeConfig ?? readNativeCompaction();

  // 0.4 P2-3：算「真实触发线」而不是窗口比例：
  //   thresholdTokens = floor(min(W × rate, W − 输出预留 − headroom))，触发点 = thresholdTokens / W。
  // 输出预留取 requestHeader.config.maxTokens（其次适配器 defaultMaxTokens），headroom 与
  // 路由级 thresholdRatio 来自 compaction-basic 配置（modelPolicies 按 provider+model 覆盖）。
  let nativePolicy = resolveNativePolicy(nativeCfg, null);
  let nativeLine = null;
  let nativeBudget = null;
  if (target !== null && target.session !== undefined) {
    try {
      nativeBudget = await routeBudgetOf(deps.ctx, target.session, picked ?? undefined, measured.window);
      nativePolicy = resolveNativePolicy(nativeCfg, nativeBudget.route);
      nativeLine = nativeLineOf({
        contextWindow: nativeBudget.contextWindow,
        reservedCompletionTokens: nativeBudget.reservedCompletionTokens,
        thresholdRatio: nativePolicy.thresholdRatio,
        headroomTokens: nativePolicy.headroomTokens,
      });
    } catch {
      nativeLine = null;
      nativeBudget = null;
    }
  }

  // 0.5.1 批 2：预判「下一次原生自动压缩会覆盖哪些锁定消息」——事前提示。
  //
  // 宿主信号：原生自动压缩只在 step boundary 触发（pressure ≥ 真实触发线后），
  // 选段 = `selectCompactableRange(session, measurement, retainTokens)`：从第一个非
  // system 节点起，逐字保留尾部 retainTokens，再按工具配对平衡回退。这里用同一份
  // 定价节点（measured.nodes）+ 同一套保留预算复刻该范围，只读、不触发任何压缩。
  //
  // 只在「自动压缩开着 + 已到真实触发线 + 节点定价与 surface 对齐」时预警；
  // 算不出/对不齐就返回 null（宁可不报，也不误报会覆盖）。
  let pinRisk = null;
  if (
    target !== null &&
    pinnedSeqs.length > 0 &&
    nativeCfg.autoEnabled !== false &&
    nativeLine !== null &&
    nativeLine.ok === true &&
    Number.isFinite(measured.tokens) &&
    measured.tokens >= nativeLine.thresholdTokens &&
    nativeBudget !== null &&
    Array.isArray(measured.nodes) &&
    measured.nodes.length === surface.length &&
    measured.nodes.every((node, index) => node?.seq === surface[index])
  ) {
    const retainTokens = nativeRetainTokensOf({
      contextWindow: nativeBudget.contextWindow,
      reservedCompletionTokens: nativeBudget.reservedCompletionTokens,
      retainRatio: nativePolicy.retainRatio,
      retainTokens: nativePolicy.retainTokens,
    });
    if (retainTokens !== null) {
      const risk = nativePinnedRiskOf({
        pinnedSeqs,
        nodes: measured.nodes,
        firstIdx: firstCompactableIdx(target.session),
        retainTokens,
        isBalancedBefore: (seq) => {
          try {
            return deps.engine?.toolPairingBalancedBefore?.(target.session, seq) === true;
          } catch {
            return true; // 判定失败时按「可切」处理：只影响预警范围，不会真的压
          }
        },
      });
      if (risk !== null) pinRisk = { count: risk.count, seqs: risk.seqs };
    }
  }

  //
  // `relay` 是旧字段：日志里**最近一条**记录（出站/入站都可能）——语义一个字节不改，
  // 下一次交接的链号递增（handoffTitlePlanOf）也依赖它。
  // `chain` 改成「本会话入站记录」（childId===本会话）的只读投影：祖先会话再次交接后，
  // 最近的记录变成出站（childId=下一代），旧实现照它下发 → 客户端「是不是本会话入站」
  // 判定不成立 → 接力条消失（DCR-01）。没有入站记录时（DCR-02）用会话头
  // header.parentSession + 标题兜底合成只读链（排除 subagent 会话与 fork 出来的会话），
  // 让 0.5.0 之前生成、子会话没有记录的老链也能显示接力条。
  const relay = target === null ? null : relayRecordOf(target.session);
  const inbound = target === null ? null : relayInboundRecordOf(target.session);
  // 0.5.6-C：本会话头是否**可能**有父会话（只读 `session.header`，零 IO、不读日志/标题）。
  // 用途：客户端只在「有父会话但没链」或「state 认不出本会话」时，才走整链端点
  // （读磁盘，可能几百 KB）兜底；普通根会话（false）因此零额外请求。
  //   口径 = legacyChainParentIdOf（排除 subagent / fork 血缘，与 DCR-02 完全一致）；
  //   null = 没有 target（宿主还没加载本会话）——「不知道」，客户端据此仍可尝试兜底。
  // 只加字段，不改 chain/relay/next 的任何语义。
  const parentHintId = target === null ? null : legacyChainParentIdOf(target.session);
  const hasParent = target === null ? null : parentHintId !== null;
  const chain =
    target === null
      ? null
      : inbound !== null
        ? relayChainOf(inbound)
        : // DCR-02：只有会话头看起来像老链时才去读标题（普通会话不付这次查找开销）。
          parentHintId === null
          ? null
          : legacyRelayChainOf({ session: target.session, title: sourceTitleOf(deps.ctx, target.session) });
  // DCR-01：`next` = 本会话最近一条**出站**记录的只读投影（只加不改）。接力条不看它，
  // 但「父→子入口」与「子会话向父会话补交接单 path」需要出站那一跳的信息。
  const next = target === null ? null : relayChainOf(relayOutboundRecordOf(target.session));
  // 0.5.0：旧会话是否已被自动归档（接力条据此显示「恢复旧会话」）。这是宿主
  // registry 的独立状态，不塞进 chain（chain 仍然只是链投影）。
  // 0.5.1 DCR-01：用**入站** parentId 查（出站记录里的父会话是本会话自己，会查错）。
  // 拿不到 registry/归档集合 → null（不知道，客户端按「可尝试恢复」处理）。
  const parentArchived =
    chain === null || chain.parentId === null ? null : isSessionArchived(deps.ctx, chain.parentId);
  // 0.5.1 批 3：出站记录的目标会话（下一代）是否已在归档集合里。父会话侧的「去新会话」
  // 用它决定要不要先 unarchive（宿主拒绝打开归档会话；unarchive 幂等）。
  // 和 parentArchived 完全对称：各查各的 id，读不到 → null（不猜 false）。
  const nextArchived = next === null || next.childId === null ? null : isSessionArchived(deps.ctx, next.childId);
  // 0.5.2 L 项：链上父会话（旧会话）是否在侧栏置顶 —— 强制归档的二次确认要提前说明
  // 「归档会取消置顶」（宿主在同一笔写盘里 unpin）。没有父会话/读不到 → null（不猜）。
  const parentPinned = chain === null || chain.parentId === null ? null : isSessionPinned(deps.ctx, chain.parentId);
  // 0.5.1 DCR-03：宿主有没有「恢复归档会话」的接缝（HTTP recover 动作调的就是它）。
  // 客户端拿不到 ctx.uiWorkspace.unarchiveSession 时据此隐藏「恢复旧会话」死入口。
  // 0.5.2 L 项：`forceArchive` = 宿主有没有 archiveSession（接力条据此显示「强制归档旧会话」；
  // 缺这个接缝时隐藏入口——点了必然失败）。
  const capabilities = {
    unarchive: typeof workspaceRegistryOf(deps.ctx)?.unarchiveSession === 'function',
    forceArchive: typeof workspaceRegistryOf(deps.ctx)?.archiveSession === 'function',
  };

  return {
    revision: ++stateRevision,
    sessionId: target?.id ?? null,
    pressure: measured.tokens,
    surfaceTokens: measured.surfaceTokens,
    window: measured.window,
    ratio: measured.ratio ?? ratioOf(measured.tokens, measured.window),
    summaries,
    advice,
    level: advice === 'none' ? 'idle' : advice,
    // 0.5.1 批 2：stale = 快照里有、surface 上已没有的 pin（被压缩/历史变化带走）。
    // `count` 仍是 live 集合（老客户端语义不变）；`stale` / `atRisk` 只加不改。
    pins: {
      count: pinnedSeqs.length,
      seqs: pinnedSeqs.slice(-20),
      marks: pinMarks,
      stale: {
        count: pinHealth.stale.length,
        seqs: pinHealth.stale.slice(-20),
        ...pinHealth.causes,
      },
      atRisk: pinRisk,
    },
    // 0.6：收藏（项目级 JSONL）→ 当前会话 seq 投影，守 32KB 帧预算。
    favorites: favoriteStateOf(deps.ctx, target?.session),
    // 0.5.3 P1-6：推荐收藏建议（模型打分后点亮星标，**不自动收藏**）。
    // 只下发 seq / messageId / 分数 / 原因；没有建议时是空数组（老客户端忽略）。
    favoriteSuggest: deps.favoriteWatch?.suggestionOf?.(target?.session?.id) ?? [],
    compactRange,
    // 0.3.5：compactRange 非 null 但无活 agent 时为 'no_agent'，其它情况 null。
    compactRangeReason,
    // 0.5.6 D1：最近一次压缩归属（事件流投影；形状见 core/attribution.ATTRIBUTION_ROW_KEYS）。
    // 没有记录 → null。只加字段，客户端按需消费。
    lastCompaction,
    busy: deps.lock.isBusy(target?.id),
    thresholds: thresholdLines,
    // A8：两套派生色板由 host 算好下发，浏览器半只按明暗挑一套（见 core/colors.js）。
    colors: { ...deps.cfg.colors, palette: paletteForBothSchemes(deps.cfg.colors) },
    // A4：设置文件有误时随状态下发，设置页/客户端可提示（正常为 null）。
    settingsError: deps.settings?.error ?? null,
    // A5：最近一次交接的接力链记录（没有就是 null）。0.5.0 F4：旧字段原样保留。
    relay,
    // 0.5.0 F4 / 0.5.1 DCR-01：本会话**入站**记录的只读链投影
    // {ordinal, baseTitle, parentId, childId, scheme, path?}；老链（无记录）可能是
    // header 兜底合成的（多一个 synthesized:true）。没有链信息 → null。
    chain,
    // 0.5.6-C：本会话头是否可能有父会话（true/false；没有 target 时 null = 不知道）。
    // 只读 header、零 IO；客户端据此决定要不要用整链端点（读磁盘）兜底接力条。
    hasParent,
    // 0.5.1 DCR-01：最近一条**出站**记录的只读投影（本会话交接给下一代那一跳）。
    // 只加不改：老客户端忽略；接力条不用它。没有出站记录 → null。
    next,
    // 0.5.0：链上父会话（入站 parentId）当前是否在 workspace 归档集合里（true/false）；
    // 没有父会话或宿主没有可读的归档状态 → null。只加不改。
    parentArchived,
    // 0.5.1 批 3：出站目标（next.childId）是否在同一归档集合里。父会话侧「去新会话」
    // 据此先恢复再切；没有出站记录或读不到归档集合 → null。只加不改。
    nextArchived,
    // 0.5.2 L 项：入站父会话（旧会话）是否在侧栏置顶。强制归档的二次确认用它在
    // 「会停止后台任务」之外再说明「归档会取消置顶」；没有父会话/读不到 → null（不猜）。
    parentPinned,
    // 0.5.1 批 2：本会话（agent.session，不是 agent.id）是否在侧栏置顶。
    // 交接前客户端据此弹「归档会取消置顶」确认；读不到置顶集合 → null（不猜）。
    sessionPinned: target === null || target.session === undefined ? null : isSessionPinned(deps.ctx, target.session.id),
    // 0.5.1 DCR-03：宿主能力位（能不能恢复归档会话 / 能不能强制归档）。老客户端忽略；
    // 新客户端在缺 `unarchive` 能力时隐藏恢复入口，缺 `forceArchive` 时隐藏强制归档入口。
    capabilities,
    // 0.3.1：模型判断的「适合压缩」断点位置（没有或已失效为 null）。
    compressHint: activeHint,
    // 0.3.1：DSH 原生自动压缩（环上的报警最高阈值 / 设置页开关的数据源）。
    // 0.4 P2-3：额外下发真实触发线（ratio 为 thresholdTokens / window；算不出时 null，
    // 客户端回落 thresholdRatio 的窗口比例，老客户端不受影响）。
    native: {
      autoEnabled: nativeCfg.autoEnabled,
      thresholdRatio: nativePolicy.thresholdRatio,
      ratio: nativeLine !== null && nativeLine.ok === true ? nativeLine.ratio : null,
      thresholdTokens: nativeLine !== null && nativeLine.ok === true ? nativeLine.thresholdTokens : null,
      contextWindow: nativeBudget?.contextWindow ?? null,
      reservedCompletionTokens: nativeBudget?.reservedCompletionTokens ?? null,
      headroomTokens: nativePolicy.headroomTokens,
      overridden: nativePolicy.overridden === true,
      route: nativeBudget?.route ?? null,
      unavailable: nativeLine !== null && nativeLine.ok !== true ? nativeLine.reason : null,
    },
  };
}
