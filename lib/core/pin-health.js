/**
 * 0.5.1 批 2：pin 失效判定（C 方案）—— 纯函数，零依赖。
 *
 * 背景：DSH 原生自动压缩（compaction-basic）按自己的保留尾部策略选段，
 * 不认本插件的 pin；被它压掉的锁定消息会从 surface 消失。过去的实现用
 * `livePinnedSeqs` 把「快照里有、surface 上没有」的 pin 直接过滤掉 —— 界面上
 * 这些 pin 就**凭空消失**了，用户以为锁还生效，其实原文已经被压走。
 *
 * C 方案：不假装还在（不画到环上、不算进 live 计数），也不消失 ——
 * 用 `pins.stale = { count, seqs }` 在悬停卡/菜单里明确写「已失效」。
 *
 * 失效原因只读日志判定（不猜）：
 *   - 找到覆盖该 seq 的 `user/message(replace)` 事件；
 *   - 顺着它的 `sourceEventSeqs[0]` 找 `compaction/start`；
 *   - 原生自动压缩的 start 带 `turn`（非 null，宿主 compaction-basic 的
 *     automatic pressure 路径 `owner = entryState.openTurn`）；
 *   - 其它压缩（本插件 /bc、宿主 /compact、compactNow）的 start `turn: null`，
 *     不论有没有 sourceCommandId 都归到 other（可以确定「被压缩带走」，只是不冒充原生）；
 *   - 没有 replace 证据（撤销/分支/历史被改写）→ unknown，不冒充压缩。
 *
 * @module core/pin-health
 */
import { normalizePinnedSeqs } from './pins.js';

/** 失效原因枚举（mixed = 多条 pin 的原因不一致）。 */
export const PIN_STALE_CAUSES = Object.freeze(['native', 'other', 'unknown']);

function isSeq(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * 扫描日志：被 replace 覆盖的 seq → replace 事件；compaction/start seq → data。
 * @param {object[]} log
 * @returns {{replaceByCoveredSeq:Map<number,object>, startBySeq:Map<number,object>}}
 */
function scanCompactionEvidence(log) {
  const replaceByCoveredSeq = new Map();
  const startBySeq = new Map();
  for (const event of Array.isArray(log) ? log : []) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'compaction/start' && Number.isInteger(event.seq)) {
      startBySeq.set(event.seq, event.data);
      continue;
    }
    if (event.type !== 'user/message' || !Array.isArray(event.sourceEventSeqs)) continue;
    for (const seq of event.sourceEventSeqs) {
      if (typeof seq === 'number' && Number.isFinite(seq)) replaceByCoveredSeq.set(seq, event);
    }
  }
  return { replaceByCoveredSeq, startBySeq };
}

/**
 * 一条失效 pin 的归因。
 * @param {number} seq
 * @param {{replaceByCoveredSeq:Map<number,object>, startBySeq:Map<number,object>}} evidence
 * @returns {'native'|'other'|'unknown'}
 */
function staleCauseOf(seq, evidence) {
  const replace = evidence.replaceByCoveredSeq.get(seq);
  if (replace === undefined) return 'unknown';
  const startSeq = Array.isArray(replace.sourceEventSeqs) ? replace.sourceEventSeqs[0] : undefined;
  const start = Number.isInteger(startSeq) ? evidence.startBySeq.get(startSeq) : undefined;
  if (start === undefined || start === null || typeof start !== 'object') return 'unknown';
  // 原生自动压缩：宿主 compaction-basic 把事件包在 turn 里（turn = openTurn 的 seq）。
  if (typeof start.turn === 'number' && Number.isInteger(start.turn)) return 'native';
  // 其它压缩：turn=null（插件菜单动作 / 宿主手动压缩 / compactNow）。
  // 有 start 证据就说明「被压缩带走」，不因为缺 sourceCommandId 退化成 unknown。
  return 'other';
}

/**
 * 计算 pin 快照相对当前 surface 的健康状态。
 *
 * @param {object} input
 * @param {number[]} input.pinnedSeqs pin 快照集合（latestPinnedSeqs(日志)）
 * @param {number[]} input.surfaceSeqs 当前 surface 的 seq（升序）
 * @param {object[]} [input.log] 会话事件日志（用于归因；缺失时全部算 unknown）
 * @returns {{live:number[], stale:number[], cause:'native'|'other'|'unknown'|'mixed'|null, causes:{native:number,other:number,unknown:number}}}
 */
export function pinHealthOf({ pinnedSeqs, surfaceSeqs, log } = {}) {
  const pinned = normalizePinnedSeqs(pinnedSeqs);
  const liveSet = new Set((Array.isArray(surfaceSeqs) ? surfaceSeqs : []).filter(isSeq));
  const live = pinned.filter((seq) => liveSet.has(seq));
  const stale = pinned.filter((seq) => !liveSet.has(seq));
  const causes = { native: 0, other: 0, unknown: 0 };
  if (stale.length === 0) return { live, stale, cause: null, causes };

  const evidence = scanCompactionEvidence(log);
  for (const seq of stale) causes[staleCauseOf(seq, evidence)] += 1;

  const present = PIN_STALE_CAUSES.filter((cause) => causes[cause] > 0);
  const cause = present.length === 1 ? present[0] : 'mixed';
  return { live, stale, cause, causes };
}

/**
 * 失效原因的展示文案（宿主与客户端共用一份口径；客户端只传 counts）。
 *
 * @param {{native?:number, other?:number, unknown?:number}} [causes]
 * @returns {string}
 */
export function staleCauseTextOf(causes) {
  const native = Number.isInteger(causes?.native) ? causes.native : 0;
  const other = Number.isInteger(causes?.other) ? causes.other : 0;
  const unknown = Number.isInteger(causes?.unknown) ? causes.unknown : 0;
  if (native > 0 && other === 0 && unknown === 0) return '随原生压缩移除';
  if (native === 0 && other > 0 && unknown === 0) return '随压缩移除';
  if (native === 0 && other === 0 && unknown > 0) return '随历史变化失效';
  return '随压缩或历史变化失效';
}
