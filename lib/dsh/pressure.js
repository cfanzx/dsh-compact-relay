/**
 * 上下文压力测量 —— 唯一测量入口。
 *
 * tokenMeter 的 totalTokens 是请求压力；contextWindow 从路由模型信息拿，
 * 拿不到就用配置兜底。所有入口（指示灯/命令/文档）读同一份结果。
 */
import { ratioOf } from '../core/policy.js';
import { routeOf } from './route.js';

/** provider/model → contextWindow 的进程内缓存（Promise，避免并发重复解析）。 */
const windowCache = new Map();

async function resolveWindow(ctx, session, agent, fallback) {
  const route = routeOf(ctx, session, agent);
  if (route === null) return fallback;
  const key = `${route.provider}/${route.model}`;
  let pending = windowCache.get(key);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
        const window = info?.context?.contextWindow;
        return Number.isInteger(window) && window > 0 ? window : null;
      } catch {
        return null;
      }
    })();
    windowCache.set(key, pending);
  }
  const window = await pending;
  // 失败（null）不留在缓存里：适配器还没就绪时第一次解析失败，不能永久用 fallback
  // 窗口算比例（2026-10-19 debug：指示灯百分比长期低估）。
  if (!(Number.isInteger(window) && window > 0)) windowCache.delete(key);
  return window ?? fallback;
}

/**
 * 测一次当前上下文压力。
 * @param {object} ctx
 * @param {object} agent
 * @param {{windowFallback: number}} options
 * @returns {Promise<{tokens:number|null, surfaceTokens:number|null, window:number, ratio:number, nodes:object[]}>}
 */
export async function measurePressure(ctx, agent, { windowFallback }) {
  const session = agent?.session;
  if (session === undefined) {
    return { tokens: null, surfaceTokens: null, window: windowFallback, ratio: 0, nodes: [] };
  }

  let measurement;
  try {
    measurement = ctx.tokenMeter.measure(session);
  } catch {
    return { tokens: null, surfaceTokens: null, window: windowFallback, ratio: 0, nodes: [] };
  }

  const total = measurement?.totalTokens;
  const surface = measurement?.surfaceTokens;
  const tokens = Number.isFinite(total) || Number.isFinite(surface) ? Math.max(total ?? 0, surface ?? 0) : null;
  const window = await resolveWindow(ctx, session, agent, windowFallback);
  const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : [];

  return {
    tokens,
    surfaceTokens: Number.isFinite(surface) ? surface : null,
    window,
    ratio: ratioOf(tokens, window),
    nodes,
  };
}
