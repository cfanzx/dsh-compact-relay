/**
 * 手动动作的 idle 准入 —— 与 DSH 手动压缩同语义。
 *
 * 所有会改历史的手动动作（压缩旧会话、交接新会话、/bctest）都从这里进，
 * 保证和 agent 的 turn / 自动压缩互斥。
 */
import { actionError } from '../core/errors.js';

/**
 * @param {object} agent
 * @param {(signal: AbortSignal) => Promise<any>} job
 */
export async function runIdle(agent, job) {
  if (agent === undefined || agent === null || typeof agent.runMaintenance !== 'function') {
    throw actionError('unsupported', '当前 DSH 版本不支持这个操作');
  }
  try {
    return await agent.runMaintenance((agentSignal) => job(agentSignal));
  } catch (error) {
    if (error !== null && typeof error === 'object' && typeof error.code === 'string') throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/already has active work|not idle|open turn/i.test(message)) {
      throw actionError('busy', message, error);
    }
    throw error;
  }
}
