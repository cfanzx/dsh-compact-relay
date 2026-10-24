/**
 * 上下文压力测量 —— 唯一测量入口。
 *
 * tokenMeter 的 totalTokens 是请求压力；contextWindow 从路由模型信息拿，
 * 拿不到就用配置兜底。所有入口（指示灯/命令/文档）读同一份结果。
 */
import { ratioOf } from '../core/policy.js';
import { routeOf } from './route.js';

/** provider/model → {window, defaultMaxTokens} 的进程内缓存（Promise，避免并发重复解析）。 */
const windowCache = new Map();

/**
 * 解析路由模型的容量信息（contextWindow + 适配器默认输出上限）。
 * 0.4 P2-3：输出预留要先看 requestHeader 的 maxTokens，其次才是这里的 defaultMaxTokens。
 */
async function resolveModelMeta(ctx, route) {
  const key = `${route.provider}/${route.model}`;
  let pending = windowCache.get(key);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
        const window = info?.context?.contextWindow;
        const def = info?.defaultMaxTokens;
        return {
          window: Number.isInteger(window) && window > 0 ? window : null,
          defaultMaxTokens: Number.isInteger(def) && def >= 0 ? def : null,
        };
      } catch {
        return { window: null, defaultMaxTokens: null };
      }
    })();
    windowCache.set(key, pending);
  }
  const meta = await pending;
  // 失败不留在缓存里：适配器还没就绪时第一次解析失败，不能永久用 fallback
  // 窗口算比例（2026-10-19 debug：指示灯百分比长期低估）。
  if (meta.window === null) windowCache.delete(key);
  return meta;
}

async function resolveWindow(ctx, session, agent, fallback) {
  const route = routeOf(ctx, session, agent);
  if (route === null) return fallback;
  const meta = await resolveModelMeta(ctx, route);
  return meta.window ?? fallback;
}

/**
 * 0.4 P2-3：解析「真实触发线」需要的路由预算。
 *   - contextWindow：路由模型窗口（失败回落测量窗口）；
 *   - reservedCompletionTokens = session.requestHeader().config.maxTokens ?? 适配器 defaultMaxTokens ?? 0
 *     （与 dsh-compaction-basic 的 reservedCompletionTokens 同一口径）。
 * @param {object} ctx
 * @param {object} session
 * @param {object} [agent]
 * @param {number} [fallbackWindow]
 * @returns {Promise<{route:object|null, contextWindow:number|null, reservedCompletionTokens:number, defaultMaxTokens:number|null, requestMaxTokens:number|null}>}
 */
export async function routeBudgetOf(ctx, session, agent, fallbackWindow) {
  const route = routeOf(ctx, session, agent);
  let meta = { window: null, defaultMaxTokens: null };
  if (route !== null) {
    try {
      meta = await resolveModelMeta(ctx, route);
    } catch {
      /* ignore */
    }
  }
  let headerMax = null;
  try {
    const value = session?.requestHeader?.()?.config?.maxTokens;
    if (Number.isInteger(value) && value >= 0) headerMax = value;
  } catch {
    /* 老宿主没有 requestHeader 就按未知处理 */
  }
  const reserved = headerMax ?? meta.defaultMaxTokens ?? 0;
  const window = meta.window ?? (Number.isFinite(fallbackWindow) && fallbackWindow > 0 ? fallbackWindow : null);
  return {
    route,
    contextWindow: window,
    reservedCompletionTokens: reserved,
    defaultMaxTokens: meta.defaultMaxTokens,
    requestMaxTokens: headerMax,
  };
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
