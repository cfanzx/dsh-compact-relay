/**
 * 交接单读取动作（A9）—— 适配层不再直接 import dsh 能力层。
 *
 * HTTP 只关心「列最近 N 份 / 读一篇的 JSON」，目录白名单/防穿越/大小上限
 * 全部留在 dsh/handoff-files.js。
 */
import { listHandoffFiles, readHandoffFile } from '../dsh/handoff-files.js';

/**
 * @param {{cfg:{handoffDir:string}}} deps
 * @param {{limit?:number}} [options]
 */
export function listHandoffDocs(deps, { limit = 20 } = {}) {
  return {
    dir: deps.cfg.handoffDir,
    items: listHandoffFiles(deps.cfg.handoffDir, { limit }),
  };
}

/**
 * 读一篇交接单；不存在/文件名非法返回 null。
 * @param {{cfg:{handoffDir:string}}} deps
 * @param {{file:string}} input
 */
export function readHandoffDoc(deps, { file } = {}) {
  return readHandoffFile(deps.cfg.handoffDir, file);
}
