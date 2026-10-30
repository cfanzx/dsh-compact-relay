/**
 * readState 快照投影（0.5.6 A）—— 诊断包 / state 快照文件 / 失败上下文共用的纯函数。
 *
 * 只保留白名单字段（数值 / 枚举 / 布尔），**绝不**带会话正文、路径、sessionId：
 *   - 诊断包 `dcr-diagnostics/v1` 的 `state` 块用它（形状与 0.4 完全一致）；
 *   - `$DSH_HOME/compact-relay-state.json` 快照也用它（sessionId 由外层单独加，
 *     便于 CLI `state` 显示；仍只落在本机文件里）。
 *
 * 纯函数、零 IO；无活动会话（sessionId 不是字符串）→ null。
 */

/**
 * @param {unknown} state readState 的返回值
 * @returns {null|{window:*, tokens:*, ratio:*, summaries:*, pins:*, advice:*,
 *   compactRange:null|{nodes:*,tokens:*}, nativeAuto:null|{enabled:*,lineRatio:*}}}
 */
export function stateSnapshotOf(state) {
  if (state === null || typeof state !== 'object' || typeof state.sessionId !== 'string') return null;
  const range = state.compactRange !== null && typeof state.compactRange === 'object' ? state.compactRange : null;
  const native = state.native !== null && typeof state.native === 'object' ? state.native : null;
  return {
    window: state.window,
    tokens: state.pressure,
    ratio: state.ratio,
    summaries: state.summaries,
    pins: state.pins !== null && typeof state.pins === 'object' ? state.pins.count : state.pins,
    advice: state.advice,
    compactRange: range === null ? null : { nodes: range.nodes, tokens: range.tokens },
    nativeAuto: native === null ? null : { enabled: native.autoEnabled, lineRatio: native.thresholdRatio },
  };
}
