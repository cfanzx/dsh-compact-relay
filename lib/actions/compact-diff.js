/**
 * 压缩历史（只读动作）—— 给 HTTP / 面板用。
 *
 * A6：不做回滚，只展示「压了哪些条、摘要预览、省了多少容量、是否已提交」。
 */
import { actionError } from '../core/errors.js';
import { collectCompactions } from '../dsh/compaction-log.js';
import { pickAgent } from '../dsh/session-view.js';

/**
 * @param {object} deps
 * @param {{sessionId?:string, limit?:number}} [input]
 */
export function readCompactDiffs(deps, input = {}) {
  const sessionId = typeof input.sessionId === 'string' && input.sessionId.length > 0 ? input.sessionId : undefined;
  const agent = pickAgent(deps?.ctx, sessionId);
  if (agent === null) throw actionError('nosession', '当前没有活动会话。');
  const session = agent.session;
  if (session === undefined || session === null) throw actionError('nosession', '当前没有活动会话。');

  const limit = input.limit;
  const items = collectCompactions(session, { limit });
  return {
    ok: true,
    sessionId: typeof session.id === 'string' ? session.id : (sessionId ?? null),
    items,
    count: items.length,
    latest: items[0] ?? null,
  };
}
