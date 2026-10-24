/**
 * 接力链的读写接缝（A5）。
 *
 * 读：从会话日志尾部找最近一条 `plugin:compact-relay/relay`；
 * 写：engine.appendPluginRecord（和压缩判断记录/pin 同一个宿主 API）。
 * 记录缺失/损坏一律当作没有（旧会话兼容），不阻断交接。
 */
import { RELAY_RECORD_TYPE } from '../core/relay.js';

/**
 * 合法化一条 relay 记录；不合法返回 null。
 * @param {unknown} data
 * @returns {{parentSessionId:string, childId:string, index:number, path?:string, planId?:string|null, at:number, title?:string, baseTitle?:string}|null}
 */
export function normalizeRelayRecord(data) {
  if (data === null || typeof data !== 'object') return null;
  if (typeof data.childId !== 'string' || data.childId.length === 0) return null;
  const index = Number.isInteger(data.index) && data.index > 0 ? data.index : null;
  if (index === null) return null;
  return {
    parentSessionId: typeof data.parentSessionId === 'string' ? data.parentSessionId : '',
    childId: data.childId,
    index,
    ...(typeof data.path === 'string' ? { path: data.path } : {}),
    planId: typeof data.planId === 'string' ? data.planId : null,
    at: Number.isFinite(data.at) ? data.at : 0,
    ...(typeof data.title === 'string' ? { title: data.title } : {}),
    ...(typeof data.baseTitle === 'string' ? { baseTitle: data.baseTitle } : {}),
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
