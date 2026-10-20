/**
 * 从会话日志里收集「本会话写/改过的文件」（交接单程序段用）。
 *
 * 只读日志；不跑 git status（硬规矩：不跑 git 命令），也不根据猜测补路径。
 * 只认明确的文件写工具：write/edit/apply_patch 等；bash 里重定向的文件不追。
 */
import { sessionLog } from './session-view.js';

const FILE_WRITE_TOOLS = new Set([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'create_file',
  'str_replace',
  'str_replace_editor',
  'write_file',
]);

const FILE_KEYS = ['file_path', 'filePath', 'path', 'file'];
const FILES_KEYS = ['files', 'paths'];

/** tool/call.arguments 可能是 JSON 字符串，也可能是对象。 */
function parseArguments(raw) {
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} session
 * @param {{limit?:number}} [options]
 * @returns {string[]} 按首次出现顺序去重后的文件路径
 */
export function changedFilesOf(session, { limit = 40 } = {}) {
  const files = [];
  const seen = new Set();
  for (const entry of sessionLog(session)) {
    if (entry === null || entry.type !== 'tool/call') continue;
    const name = entry.data !== null && typeof entry.data === 'object' ? entry.data.name : undefined;
    if (typeof name !== 'string' || !FILE_WRITE_TOOLS.has(name)) continue;
    const args = parseArguments(entry.data.arguments);
    if (args === null) continue;
    const candidates = [];
    for (const key of FILE_KEYS) if (typeof args[key] === 'string') candidates.push(args[key]);
    for (const key of FILES_KEYS) {
      if (Array.isArray(args[key])) candidates.push(...args[key].filter((value) => typeof value === 'string'));
    }
    for (const file of candidates) {
      const normalized = file.trim();
      if (normalized.length === 0 || seen.has(normalized)) continue;
      seen.add(normalized);
      files.push(normalized);
      if (files.length >= limit) return files;
    }
  }
  return files;
}
