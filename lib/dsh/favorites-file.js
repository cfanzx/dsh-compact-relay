/**
 * 收藏的文件层 —— **一条交接链一个 JSONL**（照 dsh/ledger.js 的范式写）。
 *
 * 红线（与轻账本一致）：
 *  - **不影响本体**：所有 IO 都 try/catch 吞掉，写失败只返回 {ok:false}；
 *  - **损坏静默降级**：读侧跳过坏行，不让一行坏数据毁掉全部收藏；
 *  - **有界**：超过 FAVORITE_MAX 时整文件重写保留最近 N 条（先写 tmp 再 rename）。
 *
 * 文件按「工作」分（一项工作 = 一条交接链；交接不换文件）：
 * `$DSH_HOME/dcr-favorites/<工作名>-<根会话短id>.jsonl`。
 * 链根 = 入站 relay 记录的 rootId → 老链的 header.parentSession → 自己。
 * 交接产生新会话时 rootId 不变 → 天然同一个文件（转交不换文件、继承上一个）。
 *
 * 快照：每次压缩把「本段被压掉且被收藏」的消息原文追加到
 * `$DSH_HOME/dcr-favorites/snapshots/<根会话短id>.md`——日志被清理后仍可读回。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultDshHome } from '../core/config-schema.js';
import { FAVORITE_MAX, applyFavoriteOps, countFavorites, favoriteSeqsOf } from '../core/favorites.js';
import { legacyChainParentIdOf, relayInboundRecordOf } from './relay.js';
import { sourceTitleOf } from './sessions.js';

/** 收藏文件目录名（放 DSH_HOME 下，与 compact-relay.json 同级）。 */
export const FAVORITES_DIRNAME = 'dcr-favorites';

/** 压缩快照子目录。 */
export const SNAPSHOT_DIRNAME = 'snapshots';

/**
 * 一条交接链的根会话 id（同步可算）。
 * @param {object} session
 * @returns {string|null}
 */
export function rootSessionIdOf(session) {
  if (session === null || session === undefined) return null;
  const inbound = relayInboundRecordOf(session);
  if (inbound !== null && typeof inbound.rootId === 'string' && inbound.rootId.length > 0) return inbound.rootId;
  const legacyParent = legacyChainParentIdOf(session);
  if (legacyParent !== null) return legacyParent;
  const id = session.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function titleOf(ctx, session) {
  try {
    const title = sourceTitleOf(ctx, session);
    if (typeof title === 'string' && title.trim().length > 0) return title.trim();
  } catch {
    /* 标题服务不可用就用兜底 */
  }
  return null;
}

/** 会话 id 的短形式：去掉 `session-` 前缀再取 8 位（否则所有文件都叫 `...-session-.jsonl`）。 */
function shortIdOf(id) {
  const text = typeof id === 'string' && id.length > 0 ? id : 'unknown';
  return text.replace(/^session-/, '').slice(0, 8) || 'unknown';
}

/** 文件名安全化：去路径分隔符与控制字符，折叠空白，截断。 */
function slugOf(text, max = 40) {
  if (typeof text !== 'string' || text.length === 0) return 'session';
  const cleaned = text
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned.length === 0) return 'session';
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/** 目录：`$DSH_HOME/dcr-favorites`（缺省 ~/.dsh）。 */
export function favoritesDirOf(dshHome = defaultDshHome()) {
  return path.join(dshHome, FAVORITES_DIRNAME);
}

/**
 * 某会话所属交接链的收藏文件路径。
 * @param {object} ctx
 * @param {object} session
 * @param {string} [dshHome]
 * @returns {string}
 */
export function favoritesFileOf(ctx, session, dshHome = defaultDshHome()) {
  const rootId = rootSessionIdOf(session) ?? 'unknown';
  const title = slugOf(titleOf(ctx, session) ?? 'session');
  return path.join(favoritesDirOf(dshHome), `${title}-${shortIdOf(rootId)}.jsonl`);
}

/**
 * 读文件里的全部记录（只做 JSON.parse，坏行由 core 的 normalize 过滤）。
 * @param {string} file
 * @returns {object[]}
 */
export function readFavoritesFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const records = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        continue;
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * 追加一条收藏记录；超过上限时重写保留最近 FAVORITE_MAX 条。永不抛。
 * @param {object} record normalizeFavoriteRecord 的产物
 * @param {string} file
 * @returns {{ok:boolean}}
 */
export function appendFavoriteRecord(record, file) {
  try {
    if (record === null || typeof record !== 'object') return { ok: false };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0);
    if (lines.length > FAVORITE_MAX * 2) {
      const kept = lines.slice(-FAVORITE_MAX).join('\n');
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${kept}\n`, 'utf8');
      fs.renameSync(tmp, file);
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * 某会话所在交接链的收藏集合。
 * @param {object} ctx
 * @param {object} session
 * @param {string} [dshHome]
 * @returns {Map<string, Set<number>>}
 */
export function favoriteMapOf(ctx, session, dshHome = defaultDshHome()) {
  if (ctx === undefined || session === null || session === undefined) return new Map();
  return applyFavoriteOps(readFavoritesFile(favoritesFileOf(ctx, session, dshHome)));
}

/**
 * readState 用的收藏投影：当前会话的 seq + messageId（只下发数字/短串，守 32KB 帧）。
 * @param {object} ctx
 * @param {object|null|undefined} session
 * @param {{max?:number}} [options]
 */
export function favoriteStateOf(ctx, session, { max = 200 } = {}) {
  if (ctx === undefined || session === null || session === undefined) {
    return { count: 0, seqs: [], messageIds: [], truncated: false };
  }
  const map = favoriteMapOf(ctx, session);
  const seqs = favoriteSeqsOf(map, session.id);
  const cap = Number.isInteger(max) && max > 0 ? max : 200;
  const messageIds = [];
  const wanted = new Set(seqs.slice(-100));
  const log = Array.isArray(session.log) ? session.log : [];
  for (const event of log) {
    if (wanted.size === 0) break;
    const seq = event !== null && typeof event === 'object' ? event.seq : undefined;
    if (!wanted.has(seq)) continue;
    const id = event.type === 'assistant/message' ? event.data?.message?.id : event.data?.id;
    if (typeof id === 'string' && id.length > 0) {
      messageIds.push(id);
      wanted.delete(seq);
    }
  }
  return {
    count: seqs.length,
    seqs: seqs.slice(-cap),
    messageIds,
    truncated: seqs.length > cap,
  };
}

/** 链总数（列表头部用）。 */
export function chainFavoriteTotal(ctx, session, dshHome = defaultDshHome()) {
  return countFavorites(favoriteMapOf(ctx, session, dshHome));
}

/** 快照文件：`dcr-favorites/snapshots/<根会话短id>.md`。 */
export function snapshotFileOf(ctx, session, dshHome = defaultDshHome()) {
  const rootId = rootSessionIdOf(session) ?? 'unknown';
  return path.join(favoritesDirOf(dshHome), SNAPSHOT_DIRNAME, `${shortIdOf(rootId)}.md`);
}

const SNAPSHOT_MARKER = (seq) => `<!-- dcr-fav seq:${seq} -->`;

/**
 * 把一批收藏原文追加进快照（按 seq 去重；已存在同 seq 标记则跳过）。永不抛。
 * @param {string} file
 * @param {{seq:number, role:string, title:string, text:string, at?:number}[]} entries
 * @returns {{ok:boolean, written:number}}
 */
export function appendSnapshotEntries(file, entries) {
  try {
    if (!Array.isArray(entries) || entries.length === 0) return { ok: true, written: 0 };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      existing = '';
    }
    const parts = [];
    let written = 0;
    for (const entry of entries) {
      if (existing.includes(SNAPSHOT_MARKER(entry.seq))) continue;
      const iso = new Date(Number.isFinite(entry.at) ? entry.at : Date.now()).toISOString();
      parts.push(
        `${SNAPSHOT_MARKER(entry.seq)}\n#### 收藏 · seq ${entry.seq} · ${entry.role} · ${iso}\n\n- 标题：${entry.title}\n\n${entry.text}\n\n---\n`,
      );
      written += 1;
    }
    if (written === 0) return { ok: true, written: 0 };
    const header =
      existing.length === 0
        ? '# 收藏快照\n\n> 每次压缩把「本段被压掉、且被收藏」的消息原文落到这里；原件日志被清理后仍可读回。\n\n'
        : '';
    fs.appendFileSync(file, header + parts.join('\n'), 'utf8');
    return { ok: true, written };
  } catch {
    return { ok: false, written: 0 };
  }
}

/**
 * 从快照里取某条 seq 的原文（没有返回 null）。
 * @param {string} file
 * @param {number} seq
 * @returns {string|null}
 */
export function snapshotTextFor(file, seq) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const marker = SNAPSHOT_MARKER(seq);
    const start = text.indexOf(marker);
    if (start === -1) return null;
    const rest = text.slice(start + marker.length);
    // 去掉本段头（#### 行 + 标题行 + 空行），截到下一个标记或结尾
    const nextMarker = rest.indexOf('<!-- dcr-fav seq:');
    const body = nextMarker === -1 ? rest : rest.slice(0, nextMarker);
    const lines = body.split('\n');
    const content = [];
    let skipping = true;
    for (const line of lines) {
      if (skipping) {
        if (line.startsWith('####') || line.startsWith('- 标题：') || line.trim().length === 0) continue;
        skipping = false;
      }
      if (line.trim() === '---') break;
      content.push(line);
    }
    const joined = content.join('\n').trim();
    return joined.length > 0 ? joined : null;
  } catch {
    return null;
  }
}
