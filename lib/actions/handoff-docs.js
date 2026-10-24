/**
 * 交接单读取动作（A9）—— 适配层不再直接 import dsh 能力层。
 *
 * HTTP 只关心「列最近 N 份 / 读一篇的 JSON」，目录白名单/防穿越/大小上限
 * 全部留在 dsh/handoff-files.js。
 *
 * 0.3.4（BUG-006）：列表额外返回 `total`（全量份数），客户端据此显示
 * 「共 N 份（显示最近 20）」并用「加载更多」把 limit 提到 50。
 */
import { countHandoffFiles, listHandoffFiles, readHandoffFile } from '../dsh/handoff-files.js';

/**
 * @param {{cfg:{handoffDir:string}}} deps
 * @param {{limit?:number}} [options]
 * @returns {{dir:string, items:object[], total:number}}
 */
export function listHandoffDocs(deps, { limit = 20 } = {}) {
  const dir = deps.cfg.handoffDir;
  return {
    dir,
    items: listHandoffFiles(dir, { limit }),
    total: countHandoffFiles(dir),
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
