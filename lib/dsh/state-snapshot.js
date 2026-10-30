/**
 * state 快照文件（0.5.6 A / D3）—— `$DSH_HOME/compact-relay-state.json`。
 *
 * 为什么需要：`dcr-debug state` 想读 `/api/compact-relay-state`，但宿主要求浏览器
 * cookie / launch token（裸 curl 必 401，且当前进程的 token 不在任何日志里）。
 * 插件在**能拿到 state 的地方**（state hub 每次刷新）顺手写一份白名单快照，
 * CLI 就能离线回答「当时压力/摘要数/原生线/可压范围」。
 *
 * 红线：
 *   - **≤8KB**（超过就不写，绝不把大对象落盘）；
 *   - **10s 节流**（state hub 很频繁；节流按文件路径记在进程内存里）；
 *   - **原子写**（tmp→rename）；
 *   - **永不抛**（写失败只返回 {ok:false}，不影响 state/SSE）；
 *   - 只写 `core/state-projection.stateSnapshotOf` 的白名单投影 + sessionId + 时间/版本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultDshHome } from '../core/config-schema.js';
import { stateSnapshotOf } from '../core/state-projection.js';
import { localIso } from './diag-counters.js';

/** 快照文件名。 */
export const STATE_SNAPSHOT_FILE = 'compact-relay-state.json';

/** 快照 schema 版本。 */
export const STATE_SNAPSHOT_SCHEMA = 'dcr-state-snapshot/v1';

/** 硬上限：8KB。 */
export const STATE_SNAPSHOT_BYTE_LIMIT = 8 * 1024;

/** 默认节流窗口（10s）。 */
export const STATE_SNAPSHOT_THROTTLE_MS = 10_000;

/** 默认快照路径。 */
export function defaultStateSnapshotPath() {
  return path.join(defaultDshHome(), STATE_SNAPSHOT_FILE);
}

/** 每个文件上次实际写入时间（进程内存；多进程各写各的，最后写者胜）。 */
const lastWrites = new Map();

/**
 * 写一份 state 快照（节流 + 原子写 + 永不抛）。
 *
 * @param {object|null} state readState 的返回值
 * @param {{file?:string, version?:string, now?:number, throttleMs?:number}} [options]
 * @returns {{ok:boolean, written:boolean, reason?:string}}
 */
export function writeStateSnapshot(
  state,
  { file = defaultStateSnapshotPath(), version, now = Date.now(), throttleMs = STATE_SNAPSHOT_THROTTLE_MS } = {},
) {
  try {
    const projection = stateSnapshotOf(state);
    // 没有活动会话（或形状不对）→ 不覆盖上一份有用快照。
    if (projection === null) return { ok: true, written: false, reason: 'nosession' };

    const last = lastWrites.get(file);
    if (typeof last === 'number' && now - last < throttleMs) {
      return { ok: true, written: false, reason: 'throttled' };
    }

    const payload = {
      schema: STATE_SNAPSHOT_SCHEMA,
      at: localIso(new Date(now)),
      v: typeof version === 'string' && version.length > 0 ? version : null,
      sessionId: state.sessionId,
      state: projection,
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > STATE_SNAPSHOT_BYTE_LIMIT) {
      return { ok: false, written: false, reason: 'toolarge' };
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${now}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    lastWrites.set(file, now);
    return { ok: true, written: true };
  } catch {
    return { ok: false, written: false, reason: 'io' };
  }
}

/**
 * 读快照（CLI `state` 用；读失败/损坏 → null，不抛）。
 * @param {string} [file]
 * @returns {object|null}
 */
export function readStateSnapshot(file = defaultStateSnapshotPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || parsed.schema !== STATE_SNAPSHOT_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}
