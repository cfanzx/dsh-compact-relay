/**
 * 模型入口（0.3.4）——「当前在可压缩区间」的动态提示。
 *
 * BUG-010：0.3.1 的 `mark_stage` 工具在 427 个真实会话里 0 次调用。根因不是模型
 * 不听话，而是工具描述承诺「系统会告诉你容量」但系统从没说过 —— 条件不可判断。
 * 现在宿主每轮把一条 runtime context 注入 system prompt，告诉模型当前容量落在
 * 可压缩区间；模型据此判断「刚完成一个自然节点」时该不该调 `mark_compress_point`。
 *
 * 约束：
 *  - `systemPrompt.context` 的 text 回调必须是**同步**函数 → 只读
 *    `dsh/state-hub.js` 维护的内存缓存，不 await、不 measure；
 *  - 拿不到会话/缓存/阈值就返回空串（宿主不会展示空 context）；
 *  - 全程 try/catch：提示是锦上添花，任何异常都不能影响宿主组装 prompt。
 */
import {
  COMPRESS_CUE_NAME,
  COMPRESS_CUE_ORDER,
  compressCueText,
} from '../core/compress-cue.js';
import { compressionMinRatio } from '../core/policy.js';

/** 供测试/文档引用的 context 名称。 */
export { COMPRESS_CUE_NAME };

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

    // 最小线是「配置值 vs 动态下限（保留尾部 + 最小可压 token）/窗口」的较大者（纯函数）。
    const minRatio = compressionMinRatio(thresholds, deps?.cfg?.retention, cached.window);
    return compressCueText({
      ratio: cached.ratio,
      minRatio,
      compactRatio: thresholds.compactRatio,
      compressHint: cached.compressHint ?? null,
    });
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
