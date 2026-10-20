/**
 * 从 Session 构造「模型上次看到的真前缀」—— 摘要与交接单共用。
 *
 * 摘要要回放到压缩范围末尾（cache 命中），交接单要回放整个 surface；
 * 两者都建立在「surface 节点 seq → 派生消息」这一层上，别再各写一遍。
 */

/**
 * 取 surface 从头到 endSeq（含）的派生消息，即上一次请求的真前缀。
 * @param {object} session
 * @param {number} endSeq
 * @returns {object[]}
 */
export function buildPrefix(session, endSeq) {
  const seqs = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  if (seqs.length === 0) return [];
  // 必须按 surface 位置切，不能按 seq 大小比较/提前 break：
  // 压缩后 surface = [旧头…, checkpoint(seq 最大), 旧尾部(seq 更小), 新消息…]，
  // 2026-10-19 debug 实测旧实现遇 checkpoint 就 break，长会话 /handoff 只回放 system 一条。
  const stop = seqs.indexOf(endSeq);
  const limit = stop === -1 ? seqs.length - 1 : stop;
  const messages = [];
  for (let index = 0; index <= limit; index += 1) {
    const event = session.eventAt(seqs[index]);
    if (event === undefined) continue;
    const message = session.deriveEventMessage(event);
    if (message !== null && message !== undefined) messages.push(message);
  }
  return messages;
}

/**
 * 取当前 surface 的全部派生消息（交接单用：让接手者看到完整上下文）。
 * @param {object} session
 * @returns {object[]}
 */
export function surfaceMessages(session) {
  const seqs = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  const messages = [];
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    const message = session.deriveEventMessage(event);
    if (message !== null && message !== undefined) messages.push(message);
  }
  return messages;
}
