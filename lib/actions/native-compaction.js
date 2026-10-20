/**
 * DSH 原生自动压缩开关（0.3.1）—— actions 层包装。
 *
 * 真正的读写逻辑在 dsh/native-compaction.js；这里只做参数校验与返回结构，
 * 让 adapters/http 不直接碰 dsh/（A9 架构守卫）。
 */
import { readNativeCompaction, setNativeAutoCompaction } from '../dsh/native-compaction.js';

/**
 * 读当前原生压缩配置（设置页/状态用）。
 * @returns {{autoEnabled:boolean, thresholdRatio:number}}
 */
export function nativeCompactionInfo() {
  const current = readNativeCompaction();
  return { autoEnabled: current.autoEnabled, thresholdRatio: current.thresholdRatio };
}

/**
 * 关闭/恢复 DSH 原生自动压缩。
 * @param {{enabled:boolean}} input
 * @returns {{autoEnabled:boolean, thresholdRatio:number, backup:string|null, file:string, message:string}}
 */
export function setNativeAutoCompactionEnabled({ enabled } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('缺少 enabled（true=恢复原生自动压缩，false=关闭）');
  const outcome = setNativeAutoCompaction(enabled);
  return {
    autoEnabled: outcome.autoEnabled,
    thresholdRatio: outcome.thresholdRatio,
    backup: outcome.backup,
    file: outcome.file,
    message: outcome.autoEnabled
      ? `已恢复 DSH 原生自动压缩（当前原生阈值 ${(outcome.thresholdRatio * 100).toFixed(0)}%）；重启 DSH 后生效`
      : `已关闭 DSH 原生自动压缩（备份：${outcome.backup ?? '无'}）；重启 DSH 后生效`,
  };
}
