/**
 * 锁定重要消息（M6，内部代号「钉住」/pin）—— 用户指定「必须原样保留、不被压缩」的消息。
 *
 * 入口：
 *   - `/pin`（钉最近一轮）/ `/pin list`（列最近 10 条 + 已钉集合）
 *   - `/pin <序号>`（钉列表里的第 n 条）/ `/pin clear`
 *   - `/unpin`（清空全部）
 *   - 指示灯菜单「锁定重要消息 / 解锁消息（N 条）」（HTTP action pin-toggle）
 *
 * 只写 plugin record：不进模型上下文、不占 token；压缩选段会避开被锁定的消息。
 */
import { actionError } from '../core/errors.js';
import { messageSnippetOf, roleLabelOf } from '../core/pin-anchors.js';
import { PIN_RECORD_TYPE, latestPinnedSeqs, normalizePinnedSeqs } from '../core/pins.js';
import { livePinnedSeqs, sessionLog, surfaceSeqs } from '../dsh/session-view.js';

/**
 * 从事件里抠一段可读预览（消息 content 可能是数组或字符串）。
 * 0.4 P1-1/P1-2：摘要/角色判定抽到 core/pin-anchors.js，与「建议锁定」「交接单锚点」共用一份。
 * @param {object|undefined} event
 * @returns {string}
 */
function previewOf(event) {
  return messageSnippetOf(event) || '（无文本）';
}

/**
 * 最近 N 条 surface 消息（新→旧），编号 1 开始。
 * @param {object} session
 * @param {number} [limit]
 */
export function pinCandidates(session, limit = 10) {
  const seqs = surfaceSeqs(session);
  const picked = [];
  for (let index = seqs.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const seq = seqs[index];
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (event === undefined || event === null) continue;
    picked.push({
      index: picked.length + 1,
      seq,
      type: event.type,
      role: roleLabelOf(event.type),
      preview: previewOf(event),
    });
  }
  return picked;
}

function pinnedOf(session) {
  return latestPinnedSeqs(sessionLog(session));
}

function writePins(deps, session, seqs) {
  const normalized = normalizePinnedSeqs(seqs);
  deps.engine.appendPluginRecord(session, PIN_RECORD_TYPE, { seqs: normalized, at: Date.now() });
  // 0.4 P0-2：诊断计数只记「成功锁定」；/pin 与菜单 toggle 共用这里，toggle 锁一次记一次。
  if (normalized.length > 0) deps.diag?.bumpPin();
  return normalized;
}

/**
 * 锁定最近一轮对话（最后一条 user/message；没有就退回最后一条 surface 消息）。
 * @param {{engine:object}} deps
 * @param {{agent:object}} input
 */
export function pinLastTurn(deps, { agent } = {}) {
  const session = agent?.session;
  if (session === null || session === undefined) throw actionError('pin', '当前没有打开的会话，无法锁定消息');
  // P3-03：只把「还活着」的锁定带进新快照；过期的 seq 顺手清掉，不让快照越滚越脏。
  const current = livePinnedSeqs(session);

  let seq = null;
  const seqs = surfaceSeqs(session);
  // 优先锁「人真正说的上一句」：v4 里 runtime-context / time-context / checkpoint
  // 也是 user/message，直接取最后一条会锁到合成消息（2026-10-19 debug 实测）。
  for (let index = seqs.length - 1; index >= 0; index -= 1) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seqs[index]) : undefined;
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      seq = seqs[index];
      break;
    }
  }
  if (seq === null) {
    // 老会话/测试 mock 没有 source 信息：退回「最后一条 user/message」，再退回最后一条 surface。
    for (let index = seqs.length - 1; index >= 0; index -= 1) {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seqs[index]) : undefined;
      if (event?.type === 'user/message') {
        seq = seqs[index];
        break;
      }
    }
  }
  if (seq === null && seqs.length > 0) seq = seqs[seqs.length - 1];
  if (seq === null) throw actionError('pin', '当前会话还没有可锁定的消息');

  const pinned = writePins(deps, session, [...current, seq]);
  return {
    pinned,
    added: seq,
    message: `已锁定最近一轮会话（共 ${pinned.length} 条）；后续压缩将原样保留。`,
  };
}

/**
 * 按 `/pin list` 的编号锁定某条消息（1 = 最新）。
 * @param {{engine:object}} deps
 * @param {{agent:object, index:number}} input
 */
export function pinByIndex(deps, { agent, index } = {}) {
  const session = agent?.session;
  if (session === null || session === undefined) throw actionError('pin', '没有活动会话，无法锁定消息');
  const wanted = Number(index);
  if (!Number.isInteger(wanted) || wanted < 1) throw actionError('pin', '序号须为正整数，例如 /pin 3');
  const candidates = pinCandidates(session, 10);
  const candidate = candidates.find((entry) => entry.index === wanted);
  if (candidate === undefined) {
    throw actionError('pin', `只能从最近 ${candidates.length} 条消息中选择（用 /pin list 查看序号）`);
  }
  const current = livePinnedSeqs(session);
  const pinned = writePins(deps, session, [...current, candidate.seq]);
  return {
    pinned,
    added: candidate.seq,
    message: `已锁定 1 条消息（${candidate.role}：${candidate.preview}）；当前共锁定 ${pinned.length} 条。`,
  };
}

/**
 * 清空全部锁定。
 * @param {{engine:object}} deps
 * @param {{agent:object}} input
 */
export function unpinAll(deps, { agent } = {}) {
  const session = agent?.session;
  if (session === null || session === undefined) throw actionError('pin', '当前没有打开的会话，无法解锁消息');
  const current = pinnedOf(session);
  // 本来就是空集合：不要为「清空空集合」再写一条记录（白触发 SSE/落盘）。
  if (current.length === 0) {
    return { pinned: [], cleared: 0, message: '当前没有锁定的消息。' };
  }
  // P3-03：和 readState 的展示口径对齐——只数「当前 surface 里还活着」的锁定。
  // 快照里的 seq 可能已被原生压缩/清屏带走，那些只是过期记录，不该算进「解锁了几条」。
  const live = livePinnedSeqs(session);
  writePins(deps, session, []);
  return {
    pinned: [],
    cleared: live.length,
    message:
      live.length === 0
        ? '已清理过期的锁定记录（原快照里的消息已不在当前会话中），后续压缩不受影响。'
        : `已全部解锁（原 ${live.length} 条），后续压缩可正常合并这些消息。`,
  };
}

/**
 * 列表：最近 10 条可钉消息 + 当前已钉集合。
 * @param {{}} deps
 * @param {{agent:object}} input
 */
export function listPins(deps, { agent } = {}) {
  const session = agent?.session;
  if (session === null || session === undefined) throw actionError('pin', '没有活动会话');
  const candidates = pinCandidates(session, 10);
  const pinned = pinnedOf(session);
  const lines = candidates.map((entry) => `${entry.index}. ${entry.role}：${entry.preview}`);
  return {
    pinned,
    candidates,
    message:
      (candidates.length === 0
        ? '当前会话还没有可锁定的消息。'
        : `最近 ${candidates.length} 条消息（输入 /pin <序号> 锁定指定消息）：\n${lines.join('\n')}`) +
      `\n当前已锁定：${pinned.length === 0 ? '无' : `${pinned.length} 条`}`,
  };
}

/**
 * 菜单用：有锁定（含全部已失效的快照）就清空，没有就锁最近一轮。
 *
 * 0.5.1 批 2：菜单在「全部 pin 已被原生压缩带走」时显示「解除失效锁定（N 条）」，
 * 所以这里必须按**快照**判定：快照非空 → unpinAll，不能因为 live=0 就反过来新锁
 * 一条（按钮文案与动作会完全相反）。`pinLastTurn`/`pinByIndex` 内部仍只带 live
 * 集合进新快照，顺手清掉过期 seq。
 * @param {{engine:object}} deps
 * @param {{agent:object}} input
 */
export function togglePin(deps, { agent } = {}) {
  const session = agent?.session;
  if (session === null || session === undefined) throw actionError('pin', '当前没有活动会话');
  return latestPinnedSeqs(sessionLog(session)).length > 0 ? unpinAll(deps, { agent }) : pinLastTurn(deps, { agent });
}
