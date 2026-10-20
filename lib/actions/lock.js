/**
 * 每会话单飞锁 —— 压缩/交接/测试共用。
 *
 * 同一会话同时只允许一个改历史的动作；
 * 指示灯里的 busy 状态也从这里读，不各写一套。
 */
import { actionError } from '../core/errors.js';

/** @returns {{tryAcquire:(id:string)=>boolean, release:(id:string)=>void, isBusy:(id?:string|null)=>boolean}} */
export function createLock() {
  const active = new Set();
  return {
    tryAcquire(id) {
      if (active.has(id)) return false;
      active.add(id);
      return true;
    },
    release(id) {
      active.delete(id);
    },
    isBusy(id) {
      return typeof id === 'string' && id.length > 0 && active.has(id);
    },
  };
}

/**
 * @template T
 * @param {{tryAcquire:(id:string)=>boolean, release:(id:string)=>void}} lock
 * @param {string|undefined} sessionId
 * @param {() => Promise<T>} job
 * @returns {Promise<T>}
 */
export async function withLock(lock, sessionId, job) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return job();
  if (!lock.tryAcquire(sessionId)) {
    throw actionError('busy', '这个会话已经有压缩/交接在跑');
  }
  try {
    return await job();
  } finally {
    lock.release(sessionId);
  }
}
