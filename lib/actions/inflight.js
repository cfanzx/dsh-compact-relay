/**
 * 进行中动作登记表（M6）—— 让 HTTP 层能取消正在跑的压缩。
 *
 * 与 actions/lock.js 的单飞锁分工：
 *   - lock：防并发，决定「能不能开始」；
 *   - inflight：登记 AbortController，决定「正在跑的这个能不能被取消」。
 *
 * 取消只是 abort；事务层会补一条 compaction/end(error)，历史不变。
 */
import { actionError } from '../core/errors.js';

const keyOf = (sessionId) => (typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null);

export function createInflight() {
  /** @type {Map<string, {controller:AbortController, kind:string}>} */
  const entries = new Map();

  return {
    /**
     * 登记一次动作；同会话已有登记则抛 busy（外层锁会再兜一层）。
     * @param {string|undefined} sessionId
     * @param {string} [kind]
     * @returns {AbortController|null}
     */
    begin(sessionId, kind = 'compact') {
      const key = keyOf(sessionId);
      if (key === null) return null;
      if (entries.has(key)) throw actionError('busy', '这个会话已经有压缩/交接在跑');
      const controller = new AbortController();
      entries.set(key, { controller, kind: typeof kind === 'string' && kind.length > 0 ? kind : 'compact' });
      return controller;
    },
    /**
     * 结束登记（只清自己那一份，避免误清后来的一轮）。
     * @param {string|undefined} sessionId
     * @param {AbortController|null} controller
     */
    finish(sessionId, controller) {
      const key = keyOf(sessionId);
      if (key === null) return;
      const entry = entries.get(key);
      if (entry !== undefined && entry.controller === controller) entries.delete(key);
    },
    /**
     * 请求取消；返回是否真的找到了在跑的动作。
     * @param {string|undefined} sessionId
     * @returns {boolean}
     */
    cancel(sessionId) {
      const key = keyOf(sessionId);
      if (key === null) return false;
      const entry = entries.get(key);
      if (entry === undefined) return false;
      entry.controller.abort();
      return true;
    },
    /**
     * @param {string|undefined} sessionId
     * @returns {boolean}
     */
    isActive(sessionId) {
      const key = keyOf(sessionId);
      return key !== null && entries.has(key);
    },
    /**
     * @param {string|undefined} sessionId
     * @returns {string|null}
     */
    kindOf(sessionId) {
      const key = keyOf(sessionId);
      const entry = key === null ? undefined : entries.get(key);
      return entry === undefined ? null : entry.kind;
    },
  };
}
