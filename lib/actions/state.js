/**
 * 状态快照 —— 唯一的「当前上下文怎么样」。
 *
 * 指示灯、菜单、命令前置检查都读这一份；交接单的现场信息由 actions/handoff
 * 直接调 dsh/pressure + dsh/session-view（不走这里）。客户端不再自己算阈值。
 */
import { paletteForBothSchemes } from '../core/colors.js';
import { adviceFor, ratioOf, thresholdsForWindow } from '../core/policy.js';
import { tokenOf } from '../core/tokens.js';
import { measurePressure, routeBudgetOf } from '../dsh/pressure.js';
import { selectCompactableRange } from '../dsh/select-range.js';
import { compressHint as compressHintOf, countSummaries, lastCheckpointSurfaceSeq, livePinnedSeqs, liveSessionOf, pickAgent, surfaceSeqs } from '../dsh/session-view.js';
import { compressHintIsActive } from '../core/compress-hint.js';
import { readNativeCompaction, resolveNativePolicy } from '../dsh/native-compaction.js';
import { nativeLineOf } from '../core/native-line.js';
import { relayChainOf, relayRecordOf } from '../dsh/relay.js';

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
          : { nodes: compactRange.shadowedSeqs.length, tokens: compactRange.tokenCount, startSeq: compactRange.startSeq, endSeq: compactRange.endSeq };
    }
  }
  // 范围算出来了但没有活 agent：客户端据此区分「会话未激活（发一条消息唤醒 agent）」
  // 和「真的没有可压缩内容」。additive 字段，不破坏既有 HTTP 契约。
  const compactRangeReason = compactRange !== null && !hasLiveAgent ? 'no_agent' : null;

  // M6：钉住集合（菜单显示「清除钉住（N 条）」，也能在无 agent 时读 live session）。
  const pinnedSeqs = target === null ? [] : livePinnedSeqs(target.session);
  // 0.3.1：锁定消息在 surface 里的相对位置（0–1，方案 A：消息在历史中的位置），
  // 指示灯环上按位置画锁定块；多个锁定按位置从早到晚排序。
  const surface = target === null ? [] : surfaceSeqs(target.session);
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

  // A5 / 0.5.0 F4：接力链记录只读一次。`relay` 是旧字段（原样下发，一个不改）；
  // `chain` 是它的只读投影，链号/原题/父子/scheme/path 直接给出，客户端不再自己解析。
  // 没有记录 → 两者都是 null；旧记录没有的字段 → chain 里为 null（不猜）。
  const relay = target === null ? null : relayRecordOf(target.session);

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
    pins: { count: pinnedSeqs.length, seqs: pinnedSeqs.slice(-20), marks: pinMarks },
    compactRange,
    // 0.3.5：compactRange 非 null 但无活 agent 时为 'no_agent'，其它情况 null。
    compactRangeReason,
    busy: deps.lock.isBusy(target?.id),
    thresholds: thresholdLines,
    // A8：两套派生色板由 host 算好下发，浏览器半只按明暗挑一套（见 core/colors.js）。
    colors: { ...deps.cfg.colors, palette: paletteForBothSchemes(deps.cfg.colors) },
    // A4：设置文件有误时随状态下发，设置页/客户端可提示（正常为 null）。
    settingsError: deps.settings?.error ?? null,
    // A5：最近一次交接的接力链记录（没有就是 null）。0.5.0 F4：旧字段原样保留。
    relay,
    // 0.5.0 F4：同一条记录的只读链投影 {ordinal, baseTitle, parentId, childId, scheme, path?}；
    // 只加不改：老客户端忽略它，新客户端不再解析标题。没有记录 → null。
    chain: relay === null ? null : relayChainOf(relay),
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
