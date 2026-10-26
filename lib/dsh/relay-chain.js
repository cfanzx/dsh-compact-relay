/**
 * 完整交接链的服务端读取（0.5.1 DCR-05）。
 *
 * 背景：0.5.1 批 3 的「完整交接链」由客户端逐级 GET `/api/compact-relay-state?sessionId=父id`。
 * 宿主对**没加载进内存**的会话返回 `sessionId:null`（readState 的 target 为 null），
 * 客户端只能停在断点。重启后祖先会话通常都没加载，因此「只显示 1 层」是常态而非例外。
 *
 * 宿主实证（DeepSeek Harness 0.2.1-rc.3 app.asar）：
 *   - `@deepseek-ai/dsh-session-persistence`：根服务 `ctx.sessionPersistence`
 *     - `stat(id)` → `{header, revision, sizeBytes?}`，**不读事件日志**；
 *     - `open(id, 'read')` → 只读 handle（不创建 live Session、不写任何状态），
 *       `handle.read()` → `{events, eventState}`，`handle.close()` 释放。
 *   - `@deepseek-ai/dsh-session-persistence-jsonl` 对**已归档**会话同样可读：归档只改
 *     Workspace registry 的集合，不动持久化文件。
 *
 * 所以整条链可以完全在服务端按「header + 日志尾部」读出来，不需要加载祖先会话。
 * 这里只是只读读取：不 append、不 open 写句柄、不改归档/置顶/标题。
 *
 * 链接形状与客户端原逐级逻辑一致：
 *   - 每一行（祖先）的 ordinal/baseTitle/scheme 来自**子会话的入站 relay 记录**；
 *   - 交接单 path 优先用这条入站记录自己的 path，缺了再向父会话日志里找
 *     `childId===子id && ordinal===该跳序号` 的出站记录补（0.3/0.4 老记录没写 path）；
 *   - 父会话自己的入站记录（或 DCR-02 老链的 header+标题兜底）继续往更早走。
 */
import { RELAY_RECORD_TYPE } from '../core/relay.js';
import { legacyRelayChainOf, normalizeRelayRecord, relayChainOf, relayInboundRecordOf } from './relay.js';
import { liveSessionOf, sessionLog } from './session-view.js';
import { sourceTitleOf } from './sessions.js';

/** 最多回看 8 层（与客户端 MAX_CHAIN_HOPS 同口径：防成环、防无限链）。 */
export const MAX_CHAIN_HOPS = 8;

/** 取宿主 sessionPersistence 服务；旧宿主/headless 测试没有 → null。 */
function sessionPersistenceOf(ctx) {
  try {
    const service =
      typeof ctx?.get === 'function' ? ctx.get('sessionPersistence') : ctx?.sessionPersistence;
    if (service === null || service === undefined) return null;
    if (typeof service.open !== 'function') return null;
    return service;
  } catch {
    return null;
  }
}

function isNotFoundError(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error.name === 'SessionPersistenceNotFoundError' || error.code === 'session/persistence-not-found')
  );
}

/** 只读打开一个**未加载**的会话；返回 header + 完整事件日志（不进入 ctx.sessions）。 */
async function readStoredSession(ctx, sessionId) {
  const persistence = sessionPersistenceOf(ctx);
  if (persistence === null) return { unsupported: true };
  let handle = null;
  try {
    let snapshot;
    if (typeof persistence.stat === 'function') {
      snapshot = await persistence.stat(sessionId);
      if (snapshot === null || snapshot === undefined) return { missing: true };
    }
    handle = await persistence.open(sessionId, 'read');
    const result = await handle.read();
    const events = Array.isArray(result?.events) ? result.events : [];
    const header =
      snapshot !== null && typeof snapshot === 'object' && snapshot.header !== null && typeof snapshot.header === 'object'
        ? snapshot.header
        : handle?.header;
    return { id: sessionId, header: header ?? null, events, live: false };
  } catch (error) {
    if (isNotFoundError(error)) return { missing: true };
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        /* 只读句柄释放失败不影响读取结果 */
      }
    }
  }
}

/**
 * 会话的链读取素材：优先 live（内存里最新，刚写入未落盘的记录也在），
 * 否则只读持久化日志。
 * @returns {Promise<{id:string, header:object|null, events:Array, live:boolean, session?:object}|{missing:true}|{error:string}|{unsupported:true}>}
 */
async function sessionInfoOf(ctx, sessionId) {
  const live = liveSessionOf(ctx, sessionId);
  if (live !== undefined && live !== null) {
    return {
      id: sessionId,
      header: live.header !== null && typeof live.header === 'object' ? live.header : null,
      events: sessionLog(live),
      live: true,
      session: live,
    };
  }
  return readStoredSession(ctx, sessionId);
}

/** 会话当前标题（老链兜底合成用）：live 走标题服务，持久化日志取最后一条 session/title。 */
function titleOf(ctx, info) {
  if (info.live === true && info.session !== undefined) {
    const title = sourceTitleOf(ctx, info.session);
    if (title !== undefined) return title;
  }
  const events = Array.isArray(info.events) ? info.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.length > 0) {
      return event.data.title;
    }
  }
  return undefined;
}

/**
 * 这一层会话「自己的入站链」：优先 relay 记录；0.5.0 之前的老链没有记录时，
 * 用 header.parentSession + 标题（「交接第 N 次」/「历史 N」）兜底合成。
 * 合成条件与 readState 完全一致（排除 subagent / fork / 干净标题），见 relay.js。
 */
function chainCursorOf(ctx, info) {
  const inbound = relayInboundRecordOf({ id: info.id, log: info.events });
  if (inbound !== null) return relayChainOf(inbound);
  const legacy = legacyRelayChainOf({
    session: { id: info.id, header: info.header },
    title: titleOf(ctx, info),
  });
  return legacy === null ? null : relayChainOf(legacy);
}

/**
 * 父会话日志里「交给 childId 的那一跳」的出站记录（用于补交接单 path）。
 * 必须同时校验 childId + ordinal：父会话后来可能又交接给了下一代。
 */
function outboundRecordFor(info, childId, ordinal) {
  const events = Array.isArray(info.events) ? info.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== RELAY_RECORD_TYPE) continue;
    const record = normalizeRelayRecord(event.data);
    if (record !== null && record.childId === childId && record.ordinal === ordinal) return record;
  }
  return null;
}

/** 行投影：只下发客户端画一行需要的字段（与旧逐级 GET 的 row 形状一致）。 */
function rowOf(sessionId, cursor, path) {
  return {
    sessionId,
    ordinal: cursor.ordinal,
    baseTitle: cursor.baseTitle ?? null,
    scheme: cursor.scheme ?? null,
    path: path ?? null,
  };
}

/**
 * 一次读出整条交接链（最多 8 层）。
 *
 * 不加载任何祖先会话：未加载的会话从持久化日志读 header/事件；已加载的直接用内存日志。
 * 读不到某一层时返回**已读到的行** + `unreadable`（不是把整块清空），客户端据此显示
 * 「上一层会话未打开」+「打开并继续」入口。
 *
 * @param {object} ctx 根上下文
 * @param {{sessionId?:string, maxHops?:number}} [options]
 * @returns {Promise<{
 *   ok:true,
 *   sessionId:string,
 *   rows:Array<{sessionId:string, ordinal:number|null, baseTitle:string|null, scheme:string|null, path:string|null}>,
 *   done:boolean,
 *   capped:boolean,
 *   unreadable:{sessionId:string, reason:'not-found'|'error'}|null
 * } | {ok:false, code:string, message:string}>}
 */
export async function readRelayChain(ctx, { sessionId, maxHops = MAX_CHAIN_HOPS } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, code: 'bad-session', message: '缺少 sessionId' };
  }
  if (sessionPersistenceOf(ctx) === null) {
    return { ok: false, code: 'unsupported', message: '当前宿主没有 sessionPersistence，无法在不加载会话的情况下读取接力链' };
  }

  const start = await sessionInfoOf(ctx, sessionId);
  if (start?.unsupported === true) {
    return { ok: false, code: 'unsupported', message: '当前宿主没有 sessionPersistence，无法在不加载会话的情况下读取接力链' };
  }
  if (start?.missing === true) {
    return { ok: false, code: 'not-found', message: '宿主持久化里找不到这个会话' };
  }
  if (start?.error !== undefined) {
    return { ok: false, code: 'read-failed', message: `读取会话日志失败：${start.error}` };
  }

  const limit = Number.isInteger(maxHops) && maxHops > 0 ? Math.min(MAX_CHAIN_HOPS, maxHops) : MAX_CHAIN_HOPS;
  let cursor = chainCursorOf(ctx, start);
  let childId = sessionId;
  const rows = [];
  const seen = new Set([sessionId]);
  const partial = (unreadable) => ({
    ok: true,
    sessionId,
    rows,
    done: false,
    capped: false,
    unreadable,
  });

  while (cursor !== null && cursor.parentId !== null) {
    if (rows.length >= limit) {
      return { ok: true, sessionId, rows, done: true, capped: true, unreadable: null };
    }
    const parentId = cursor.parentId;
    // 链路成环/自指：去重后停在最后一条真实会话，不再重复列同一层。
    if (seen.has(parentId)) {
      return { ok: true, sessionId, rows, done: true, capped: false, unreadable: null };
    }
    const info = await sessionInfoOf(ctx, parentId);
    if (info?.missing === true) return partial({ sessionId: parentId, reason: 'not-found' });
    if (info?.error !== undefined) return partial({ sessionId: parentId, reason: 'error' });
    if (info?.unsupported === true) {
      return { ok: false, code: 'unsupported', message: '当前宿主没有 sessionPersistence，无法在不加载会话的情况下读取接力链' };
    }

    const outbound = outboundRecordFor(info, childId, cursor.ordinal);
    rows.push(rowOf(parentId, cursor, cursor.path ?? outbound?.path ?? null));
    seen.add(parentId);
    childId = parentId;
    cursor = chainCursorOf(ctx, info);
  }

  return { ok: true, sessionId, rows, done: true, capped: false, unreadable: null };
}
