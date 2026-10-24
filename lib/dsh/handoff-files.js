/**
 * 交接单目录的只读访问 —— 给 GUI 的「查看交接单」列表/查看用。
 *
 * 安全边界：文件名只认 handoff-*.md，解析后必须仍在交接目录内；
 * 只读、不写、不删；单文件读取上限 512KB（防止误读大文件）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 交接单文件名（handoffFileName 生成：handoff-2026-10-19T12-31-42-001Z.md）。 */
const NAME_RE = /^handoff-[0-9A-Za-z][0-9A-Za-z.\-_]*\.md$/;
const MAX_READ_BYTES = 512 * 1024;
const HEADER_BYTES = 4096;

function headerField(text, label) {
  const match = new RegExp(`^- ${label}：(.*)$`, 'm').exec(text);
  return match === null ? null : match[1].trim();
}

/**
 * 交接单总数（0.3.4 BUG-006：列表端点要能报「共 N 份」，不能只回最近 20）。
 *
 * 只数合法文件名 + 普通文件，口径与 listHandoffFiles 一致；不读文件头，成本是
 * 一次 readdir + 每个文件的 stat（目录里通常几十份，可忽略）。
 * @param {string} dir
 * @returns {number}
 */
export function countHandoffFiles(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) total += 1;
    } catch {
      /* 读不到 stat 的文件不计入（与列表口径一致） */
    }
  }
  return total;
}

/**
 * 列交接单（新→旧）。
 * @param {string} dir
 * @param {{limit?:number}} [options]
 * @returns {{name:string,path:string,size:number,mtime:number,generated:string|null,sourceSessionId:string|null,sourceTitle:string|null}[]}
 */
export function listHandoffFiles(dir, { limit = 20 } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const items = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let head = '';
    let fd = null;
    try {
      fd = fs.openSync(full, 'r');
      const buffer = Buffer.alloc(HEADER_BYTES);
      const read = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
      head = buffer.subarray(0, read).toString('utf8');
    } catch {
      /* 读不动就只给文件属性 */
    } finally {
      // readSync/openSync 抛错也要关 fd，否则列表刷几次就漏 fd。
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }

    items.push({
      name,
      path: full,
      size: stat.size,
      mtime: stat.mtimeMs,
      generated: headerField(head, '生成时间'),
      sourceSessionId: headerField(head, '原会话'),
      sourceTitle: headerField(head, '原会话标题'),
    });
  }

  items.sort((a, b) => b.mtime - a.mtime);
  const max = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 20;
  return items.slice(0, max);
}

/**
 * 读一份交接单。
 * @param {string} dir
 * @param {string} name
 * @returns {{name:string,path:string,size:number,mtime:number,content:string}|null}
 */
export function readHandoffFile(dir, name) {
  if (typeof dir !== 'string' || dir.length === 0) return null;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;

  const root = path.resolve(dir);
  const resolved = path.resolve(path.join(root, name));
  if (resolved !== path.join(root, name) || !resolved.startsWith(`${root}${path.sep}`)) return null;

  try {
    // 文本路径检查挡不住软链接：realpath 后再确认没逃出交接目录（注释承诺的边界）。
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(resolved);
    if (!realFile.startsWith(`${realRoot}${path.sep}`)) return null;
    const stat = fs.statSync(realFile);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
    return {
      name,
      path: resolved,
      size: stat.size,
      mtime: stat.mtimeMs,
      content: fs.readFileSync(realFile, 'utf8'),
    };
  } catch {
    return null;
  }
}
