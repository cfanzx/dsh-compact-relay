/**
 * 接力链的读写接缝（A5）。
 *
 * 读：从会话日志尾部找最近一条 `plugin:compact-relay/relay`；
 * 写：engine.appendPluginRecord（和压缩判断记录/pin 同一个宿主 API）。
 * 记录缺失/损坏一律当作没有（旧会话兼容），不阻断交接。
 */
import { RELAY_RECORD_TYPE } from '../core/relay.js';

/** relay 记录里允许的标题方案（0.5.0 命名反转的两种新标题；legacy 不写进记录）。 */
const RECORD_SCHEMES = new Set(['handoff-n', 'history-n']);

/**
 * 合法化一条 relay 记录；不合法返回 null。
 *
 * 0.4 P2-2（接力链元数据补全）：canonical 字段为 `parentId` / `childId` / `ordinal` / `at` / `atIso`；
 * 同时保留 0.3 的旧字段 `parentSessionId` / `index`（旧记录只读兼容，新写入两者都带）。
 *
 * 0.4.3 F2（无痕 handoff 地基）：白名单放行可选字段 `scheme` / `titleSeq` / `historyTitle`。
 * 旧记录没有这三个字段 → 一律读成 null；其余字段与旧记录读取语义完全不变。
 *
 * @param {unknown} data
 * @returns {{parentId:string, childId:string, ordinal:number, at:number, atIso:string|null, parentSessionId:string, index:number, path?:string, planId?:string|null, title?:string, baseTitle?:string, scheme:'handoff-n'|'history-n'|null, titleSeq:number|null, historyTitle:string|null}|null}
 */
export function normalizeRelayRecord(data) {
  if (data === null || typeof data !== 'object') return null;
  if (typeof data.childId !== 'string' || data.childId.length === 0) return null;
  const ordinal = Number.isInteger(data.ordinal) && data.ordinal > 0
    ? data.ordinal
    : Number.isInteger(data.index) && data.index > 0
      ? data.index
      : null;
  if (ordinal === null) return null;
  const parentId = typeof data.parentId === 'string'
    ? data.parentId
    : typeof data.parentSessionId === 'string'
      ? data.parentSessionId
      : '';
  return {
    parentId,
    childId: data.childId,
    ordinal,
    at: Number.isFinite(data.at) ? data.at : 0,
    atIso: typeof data.atIso === 'string' ? data.atIso : null,
    // 0.3 旧字段兼容（测试/旧读法仍按这些名字取）。
    parentSessionId: parentId,
    index: ordinal,
    ...(typeof data.path === 'string' ? { path: data.path } : {}),
    planId: typeof data.planId === 'string' ? data.planId : null,
    ...(typeof data.title === 'string' ? { title: data.title } : {}),
    ...(typeof data.baseTitle === 'string' ? { baseTitle: data.baseTitle } : {}),
    // 0.4.3 F2：新字段只做白名单放行，缺失/非法一律 null（不猜、不补默认值）。
    scheme: RECORD_SCHEMES.has(data.scheme) ? data.scheme : null,
    titleSeq: Number.isInteger(data.titleSeq) && data.titleSeq > 0 ? data.titleSeq : null,
    historyTitle: typeof data.historyTitle === 'string' && data.historyTitle.length > 0 ? data.historyTitle : null,
  };
}

/**
 * 会话里最近一条接力链记录（没有返回 null）。
 * @param {object|undefined} session
 * @returns {object|null}
 */
export function relayRecordOf(session) {
  const log = session?.log;
  if (!Array.isArray(log)) return null;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index];
    if (event?.type !== RELAY_RECORD_TYPE) continue;
    const record = normalizeRelayRecord(event.data);
    if (record !== null) return record;
  }
  return null;
}

/**
 * 写一条 relay 记录；失败只返回 false（交给调用方决定是否告警），不影响交接结果。
 * @param {{appendPluginRecord?: Function}} engine
 * @param {object} session 父会话
 * @param {object} record
 * @returns {boolean}
 */
export function writeRelayRecord(engine, session, record) {
  if (typeof engine?.appendPluginRecord !== 'function') return false;
  try {
    engine.appendPluginRecord(session, RELAY_RECORD_TYPE, record);
    return true;
  } catch {
    return false;
  }
}
