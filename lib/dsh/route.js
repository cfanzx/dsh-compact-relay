/**
 * 模型路由与 cache 对齐参数 —— 摘要器 / 交接单 / 新会话共用。
 *
 * 三处曾经各写一遍 route 判定，M3 收拢到这里：
 * 「用哪个 provider/model」只有这一个答案。
 */

/**
 * 合法化一条路由：provider/model 都必须是非空字符串。
 * @param {unknown} value
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null}
 */
function asRoute(value) {
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.provider !== 'string' || value.provider.length === 0) return null;
  if (typeof value.model !== 'string' || value.model.length === 0) return null;
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
  };
}

/**
 * 取当前会话真实使用的模型路由（P2-4）。
 *
 * 顺序：DSH 的 modelSelection 投影（pending = 刚切但还没发消息；lastUsed = 上次实际用过）
 *   → 最近一次请求头（旧宿主/投影不可用） → agent 选项。
 * 只读 requestHeader 会在「切了模型但还没发消息」时沿用旧模型；摘要/交接/子会话
 * 都该用用户当前选的模型，而不是上一轮的。
 *
 * @param {object} ctx
 * @param {object} session
 * @param {object} [agent]
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null}
 */
export function routeOf(ctx, session, agent) {
  try {
    const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined;
    const selection = projections?.stateOf?.(session, 'modelSelection');
    const picked = asRoute(selection?.pending ?? selection?.lastUsed);
    if (picked !== null) return picked;
  } catch {
    /* 投影不可用就退回请求头 */
  }
  const config = session?.requestHeader?.()?.config;
  const logged = asRoute(config);
  if (logged !== null) return logged;
  return asRoute(agent?.options);
}

/**
 * 复用上次真实请求的采样控制参数，让附带调用尽量贴近它的前缀缓存。
 * @param {object} session
 * @param {{provider: string, model: string}} target
 * @returns {object}
 */
export function cacheControls(session, target) {
  const config = session?.requestHeader?.()?.config;
  if (config === undefined || config.provider !== target.provider || config.model !== target.model) return {};
  const controls = {};
  if (config.reasoningEffort !== undefined) controls.reasoningEffort = config.reasoningEffort;
  if (config.temperature !== undefined) controls.temperature = config.temperature;
  if (Array.isArray(config.stop) && config.stop.length > 0) controls.stop = [...config.stop];
  return controls;
}
