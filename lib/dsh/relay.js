/**
 * 接力链的读写接缝（A5）。
 *
 * 读：从会话日志尾部找最近一条 `plugin:compact-relay/relay`；
 * 写：engine.appendPluginRecord（和压缩判断记录/pin 同一个宿主 API）。
 * 记录缺失/损坏一律当作没有（旧会话兼容），不阻断交接。
 */
import { RELAY_RECORD_TYPE, splitHandoffTitle } from '../core/relay.js';

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
 * 0.5.0 命名反转起，父/子记录都写 `scheme`（本次链 `history-n`/`handoff-n`）与 `titleSeq`；
 * 新链父记录另写 `historyTitle`（旧会话改名后的「历史 N」）。
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
    // 0.6：链根会话 id（收藏文件按链根定位）。老记录**不写这个键**，读侧回退 parentId——
    // 条件展开保持旧记录读取形状不变（0.3 记录字节契约）。
    ...(typeof data.rootId === 'string' && data.rootId.length > 0 ? { rootId: data.rootId } : {}),
  };
}

/**
 * 从日志尾部向前找第一条满足条件的 relay 记录（没有返回 null）。
 *
 * 拆出来给入站/出站两个读取器共用：只扫一遍日志，判定由调用方给（DCR-01）。
 * @param {object|undefined} session
 * @param {(record:object)=>boolean} predicate
 * @returns {object|null}
 */
function latestRelayRecordWhere(session, predicate) {
  const log = session?.log;
  if (!Array.isArray(log)) return null;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index];
    if (event?.type !== RELAY_RECORD_TYPE) continue;
    const record = normalizeRelayRecord(event.data);
    if (record !== null && predicate(record)) return record;
  }
  return null;
}

/**
 * 会话里最近一条接力链记录（没有返回 null）。
 *
 * **语义保持不变**（0.5.1 DCR-01 有意不改）：这是「最近一条记录」，出站/入站都可能。
 * `readState.relay` 与 `handoffTitlePlanOf` 的链号递增都依赖它（下一次交接要看最近
 * 一跳，可能是本会话交接出去的那条）。
 * @param {object|undefined} session
 * @returns {object|null}
 */
export function relayRecordOf(session) {
  return latestRelayRecordWhere(session, () => true);
}

/**
 * 本会话的**入站**接力记录：`childId === session.id` 的最新一条（没有返回 null）。
 *
 * 0.5.1 DCR-01：祖先会话再次交接后，日志最新一条变成出站记录（childId=下一代），
 * 旧实现把它当链信息下发给客户端 → 客户端的「是不是本会话的入站记录」判定不成立
 * → 接力条消失。接力条要看的永远是「我是被谁交接出来的」，所以按 childId 认。
 * @param {object|undefined} session
 * @returns {object|null}
 */
export function relayInboundRecordOf(session) {
  const id = session?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return latestRelayRecordWhere(session, (record) => record.childId === id);
}

/**
 * 本会话的**出站**接力记录：`childId !== session.id` 的最新一条（没有返回 null）。
 *
 * 0.5.1 DCR-01：作为 `readState.next` 下发（只加不改），供「父→子」入口与
 * 「子会话向父会话补交接单 path」使用；接力条本身不看它。
 * @param {object|undefined} session
 * @returns {object|null}
 */
export function relayOutboundRecordOf(session) {
  const id = session?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return latestRelayRecordWhere(session, (record) => record.childId !== id);
}

/**
 * 会话头是否具备「可能是一条老链」的血缘（DCR-02 的前置条件，不看标题）。
 *
 * 单独导出是为了让 `readState` 在**没有入站记录**时先做这道便宜的判断，只有可能
 * 是老链才去读标题服务（普通根会话占多数，不该为每条状态读多打一次标题查找）。
 *
 * @param {object|undefined} session
 * @returns {string|null} `header.parentSession`（合法时），否则 null
 */
export function legacyChainParentIdOf(session) {
  const header = session?.header;
  if (header === null || typeof header !== 'object') return null;
  const parentId = typeof header.parentSession === 'string' ? header.parentSession : '';
  if (parentId.length === 0) return null;
  // subagent 会话有 parentSession（指向派它的父会话），但它不在人看的接力链上。
  if (header.origin === 'subagent') return null;
  // fork（isSeeded=true）继承的是前缀快照，血缘也不是「交接」。
  if (header.isSeeded === true) return null;
  return parentId;
}

/**
 * 0.5.1 DCR-02：0.5.0 之前生成的老链没有 relay record —— 用会话头 + 标题合成只读 chain。
 *
 * 为什么需要：0.4.x 只在**父会话**日志里写记录，子会话自己没有记录；升级到 0.5.0 后
 * 这些老链会话 `chain=null`，接力条永远不显示。这里只做**只读兜底**（不写日志、
 * 不改任何记录），条件全部满足才合成：
 *   1. `header.parentSession` 是非空字符串（宿主血缘字段）；
 *   2. `header.origin !== 'subagent'`（subagent 会话不是交接链）；
 *   3. `header.isSeeded !== true`（宿主 `isSeeded` = fork 继承前缀，不是交接出来的）；
 *   4. 会话标题能解析出链号（`splitHandoffTitle(...).handedOff > 0`）——
 *      老链子会话标题是「交接第 N 次：X」；干净标题说明不是交接出来的会话，不猜。
 *
 * 合成链不带 `path`：老链的交接单路径只写在父会话记录里，客户端缺 path 时会按
 * 入站记录向父会话只读回查（`loadParentPath`）。带 `synthesized:true` 只是给
 * 调试/测试一个明确标记（客户端投影忽略未知字段）。
 *
 * @param {{session?:object, title?:string}} input session 会话；title 当前标题（读不到传 undefined）
 * @returns {{ordinal:number, baseTitle:string, parentId:string, childId:string, scheme:'handoff-n'|'history-n', synthesized:true}|null}
 */
export function legacyRelayChainOf({ session, title } = {}) {
  const parentId = legacyChainParentIdOf(session);
  if (parentId === null) return null;
  const childId = typeof session?.id === 'string' && session.id.length > 0 ? session.id : null;
  if (childId === null) return null;
  const split = splitHandoffTitle(title);
  if (!(split.handedOff > 0)) return null;
  return {
    ordinal: split.handedOff,
    baseTitle: split.baseTitle,
    parentId,
    childId,
    // 老链只有「交接第 N 次」；标题是「历史 N」时仍是新链形态（record 丢了）——
    // legacy 堆叠（「交接：」）按旧链展示（客户端文案只区分 history-n / 其它）。
    scheme: split.scheme === 'history-n' ? 'history-n' : 'handoff-n',
    synthesized: true,
  };
}

/**
 * 0.5.0 F4：把一条 relay 记录投影成只读的「接力链节点」（交给 readState 下发）。
 *
 * 只是投影，不是解析：字段全部取自记录本身，不读标题、不补默认序号、不猜 scheme。
 *   - 记录里没有的字段 → null（0.4 及更早的记录没有 scheme/baseTitle）；
 *   - path 与记录写法一致：有才带，没有就不出现这个键（不塞 null 占位）；
 *   - 不是对象 → null（表示「没有链信息」，客户端按无链接口处理）。
 *
 * @param {object|null|undefined} record normalizeRelayRecord 的返回值
 * @returns {{ordinal:number|null, baseTitle:string|null, parentId:string|null, childId:string|null, scheme:'handoff-n'|'history-n'|null, path?:string}|null}
 */
export function relayChainOf(record) {
  if (record === null || typeof record !== 'object') return null;
  const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
  const path = text(record.path);
  return {
    ordinal: Number.isInteger(record.ordinal) && record.ordinal > 0 ? record.ordinal : null,
    baseTitle: text(record.baseTitle),
    parentId: text(record.parentId),
    childId: text(record.childId),
    scheme: text(record.scheme),
    ...(path === null ? {} : { path }),
  };
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
