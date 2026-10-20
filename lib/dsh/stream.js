/**
 * LLM 流终止状态 → 可读错误 —— 摘要与交接单共用。
 *
 * 两处都走 BlockAssembler 收集流，失败分类（超限/工具调用/中断）只定义一次。
 */
import { actionError } from '../core/errors.js';

/**
 * 把流终止原因映射成错误；正常结束返回 null。
 * @param {object} assembler BlockAssembler
 * @param {{code?: string, label?: string}} [options]
 * @returns {Error|null}
 */
export function finishProblem(assembler, { code = 'summary', label = '压缩摘要' } = {}) {
  const finish = assembler?.finish;
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    return actionError(code, finish?.failure?.message ?? `${label}失败`);
  }
  if (finish?.kind === 'max-tokens') return actionError(code, `${label}在输出上限处被截断，未提交`);
  if (finish?.kind === 'tool-calls') return actionError(code, `${label}尝试调用工具，已拒绝`);
  return null;
}
