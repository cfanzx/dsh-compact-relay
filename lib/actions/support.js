/**
 * 动作层胶水 —— 多个动作共用的「运行时细节」，不含业务判断。
 *
 * 以前这些片段在 actions/better-compact.js 与 actions/handoff.js 里各写一遍
 * （test-compact 也有一份信号组合），而且取消语义必须一致：
 * 用户取消 ↔ 网络错误 ↔ 已提交/落盘状态不明的错误，文案与错误码不能各说各话。
 *
 * 放 actions 层（不是 core/dsh）：这里要碰 deps.inflight（动作登记表）和
 * core/errors 的错误包装，是「动作怎么跑」的公共约定，不是纯函数能力。
 */
import { actionError } from '../core/errors.js';

/**
 * 组合两个 AbortSignal（任一为 undefined 时直接返回另一个）。
 *
 * 用途：用户取消信号（输入）与事务 idle 信号（runMaintenance 给的）合并；
 * 交接里是「inflight 取消信号」与「命令信号」合并。
 * @param {AbortSignal|undefined} a
 * @param {AbortSignal|undefined} b
 * @returns {AbortSignal|undefined}
 */
export function combinedSignal(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return AbortSignal.any([a, b]);
}

/**
 * 登记「进行中的动作」，拿 AbortController（取消按钮真正能 abort 模型调用）。
 * deps.inflight 是可选的（测试/旧装配没有就不登记）。
 * @param {{inflight?:object}} deps
 * @param {string} agentId
 * @param {'compact'|'handoff'} kind
 * @returns {AbortController|null}
 */
export function beginInflight(deps, agentId, kind) {
  return deps.inflight !== undefined && typeof deps.inflight.begin === 'function'
    ? deps.inflight.begin(agentId, kind)
    : null;
}

/**
 * 注销进行中的动作（必须放 finally，任何失败/取消都不能把登记漏在表里）。
 * @param {{inflight?:object}} deps
 * @param {string} agentId
 * @param {AbortController|null} controller
 */
export function finishInflight(deps, agentId, controller) {
  if (controller !== null && typeof deps.inflight.finish === 'function') {
    deps.inflight.finish(agentId, controller);
  }
}

/**
 * 取消收口：信号已中止、但错误不是「取消/已提交/落盘不明」时，统一包装成
 * cancelled（宿主 HTTP 层据此回「历史没改」）。
 *
 * P2-1：commit/persistence 表示历史可能已改或落盘状态不明，绝不能谎报「历史没改」；
 * 这类错误原样抛出。返回错误给调用方 throw（保持各自 try/catch 结构不变）。
 *
 * @param {unknown} error 原始错误
 * @param {AbortSignal|undefined} signal 合并后的信号
 * @param {string} message 该动作的取消文案（用户可见，调用方给）
 * @returns {unknown} 要抛出的错误
 */
export function cancelErrorOf(error, signal, message) {
  if (
    signal?.aborted === true &&
    error?.code !== 'cancelled' &&
    error?.code !== 'commit' &&
    error?.code !== 'persistence'
  ) {
    return actionError('cancelled', message, error);
  }
  return error;
}
