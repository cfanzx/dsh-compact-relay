/**
 * 模型入口（0.3.4 / 0.4 P0-1）——「当前可以记一个压缩节点」的动态提示。
 *
 * BUG-010：0.3.1 的 `mark_stage` 工具在 427 个真实会话里 0 次调用。根因不是模型
 * 不听话，而是工具描述承诺「系统会告诉你容量」但系统从没说过 —— 条件不可判断。
 * 0.3.4 起宿主每轮把一条 runtime context 注入 system prompt，告诉模型当前容量。
 *
 * 0.4 P0-1（Win 173 会话里 cue 注入 18 次、工具仍 0 调用）：
 *  1. 文案 v2 与区间 v2 在 core/compress-cue.js（4 类完成信号 + 被拒零副作用）；
 *  2. **注入门控**在本文件（方案 §3.2）：只有全部满足才注入——
 *     a) 容量落在 cue 区间（10%–40%，且不越过压缩线，见 cueBandOf）；
 *     b) 距上次注入 ≥ CUE_MIN_TURNS 轮（本轮按 text 回调调用次数计，纯内存不落盘）；
 *     c) 一轮内最多一次（连续调用时 b 天然保证）；
 *  3. 实际注入一次就 `deps.diag.bumpCueInjected()`（供 P0-2 诊断包看数），
 *     只记次数、不记提示原文（隐私口径与 P0-2 一致）。
 *
 * 约束：
 *  - `systemPrompt.context` 的 text 回调必须是**同步**函数 → 只读
 *    `dsh/state-hub.js` 维护的内存缓存，不 await、不 measure；
 *  - 拿不到会话/缓存/阈值就返回空串（宿主不会展示空 context）；
 *  - 全程 try/catch：提示是锦上添花，任何异常都不能影响宿主组装 prompt；
 *  - 本文件（adapters）不 import lib/dsh/：计数走 deps.diag 既有注入。
 */
import {
  COMPRESS_CUE_NAME,
  COMPRESS_CUE_ORDER,
  compressCueText,
  cueBandOf,
} from '../core/compress-cue.js';
import { CUE_MIN_TURNS, compressionMinRatio } from '../core/policy.js';

/** 供测试/文档引用的 context 名称。 */
export { COMPRESS_CUE_NAME };

/**
 * 每会话的注入节奏（进程内，不新增持久状态）：
 *   calls             text 回调被调用次数（≈轮数）
 *   lastInjectedCall  上次真正注入发生在第几次调用（null = 还没注入过）
 *
 * 进程内 Map 只服务宿主生命周期；上限 200 个会话，避免长期运行无限增长。
 */
const MAX_TRACKED_SESSIONS = 200;
const cueTurns = new Map();

/**
 * 取（并前移）某会话的注入节奏计数。
 * @param {string} sessionId
 * @returns {{calls:number, lastInjectedCall:number|null}}
 */
function cueTurnOf(sessionId) {
  let turn = cueTurns.get(sessionId);
  if (turn === undefined) {
    turn = { calls: 0, lastInjectedCall: null };
    cueTurns.set(sessionId, turn);
    if (cueTurns.size > MAX_TRACKED_SESSIONS) {
      const oldest = cueTurns.keys().next().value;
      cueTurns.delete(oldest);
    }
  }
  turn.calls += 1;
  return turn;
}

/**
 * 测试用：清空注入节奏（相当于宿主重启）。生产路径不需要调用。
 * @returns {void}
 */
export function resetCueTurns() {
  cueTurns.clear();
}

/**
 * 计算某个 agent 本轮该显示的动态提示（同步、异常安全）。
 * @param {{context?:object, deps?:object, hub?:object}} input
 *   context 是宿主传给 systemPrompt.context text 回调的对象（context.agent 是当前 agent）
 * @returns {string} 提示文本；不适用/异常返回 ''
 */
export function compressCueFor({ context, deps, hub } = {}) {
  try {
    // 只认会话 id（agent.id 与 session.id 不同，缓存也按 sessionId 键控）。
    const sessionId = context?.agent?.session?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return '';

    const cached = hub?.latestState?.(sessionId);
    if (cached === undefined || cached === null) return '';

    const thresholds = deps?.cfg?.thresholds;
    if (thresholds === null || typeof thresholds !== 'object') return '';
    if (!Number.isFinite(thresholds.compactRatio)) return '';
    if (!Number.isFinite(cached.ratio) || !Number.isFinite(cached.window) || cached.window <= 0) return '';

    // 每次 text 回调（≈一轮）都计数：即使本轮不注入，也要推进轮次，限频才有意义。
    const turn = cueTurnOf(sessionId);

    // 门控 a：区间 = max(10%, 动态最小线) ≤ ratio < min(40%, 压缩线)。
    const dynamicMinRatio = compressionMinRatio(thresholds, deps?.cfg?.retention, cached.window);
    const band = cueBandOf({ compactRatio: thresholds.compactRatio, dynamicMinRatio });
    if (!(cached.ratio >= band.minRatio && cached.ratio < band.maxRatio)) return '';

    // 门控 b/c：距上次注入 ≥ CUE_MIN_TURNS 轮（同一轮内多次调用必然不足）。
    if (turn.lastInjectedCall !== null && turn.calls - turn.lastInjectedCall < CUE_MIN_TURNS) return '';

    const text = compressCueText({
      ratio: cached.ratio,
      minRatio: band.minRatio,
      maxRatio: band.maxRatio,
      compressHint: cached.compressHint ?? null,
    });
    if (text === '') return '';

    turn.lastInjectedCall = turn.calls;
    deps?.diag?.bumpCueInjected?.();
    return text;
  } catch {
    return '';
  }
}

/**
 * 注册动态提示（root-scope，所有 agent 生效）。
 * @param {object} ctx 根上下文（需要 systemPrompt 服务）
 * @param {object} deps
 * @param {object} hub createStateHub 的返回值（要 latestState）
 * @returns {Function|undefined} disposer（没有 systemPrompt 服务时返回 undefined）
 */
export function registerCompressCue(ctx, deps, hub) {
  if (typeof ctx?.systemPrompt?.context !== 'function') return undefined;
  return ctx.systemPrompt.context({
    name: COMPRESS_CUE_NAME,
    order: COMPRESS_CUE_ORDER,
    text: (context) => compressCueFor({ context, deps, hub }),
  });
}
