/**
 * JSONL 公共读写件（0.5.6 D4）—— 事件流与既有轻账本共用，**永不抛**。
 *
 * 为什么抽出来：`dsh/ledger.js` 与 `dsh/events.js` 都要「mkdir → append → 超上限时
 * tmp→rename 整文件重写」。以前账本每次 append 都全量读一遍（`dsh/ledger.js:62`），
 * 事件流一天几十行、800 行上限，照抄会把写放大。这里统一成：
 *
 *   1. **stat 守卫**：只有文件字节超阈值、或内存里累计行数超上限时才读全量；
 *   2. **tmp→rename** 原子替换（不会让读侧看到半截文件；跨进程最后写者胜，可接受）；
 *   3. 单行 append（O_APPEND，单行 < 4KB 时 POSIX/Windows 实践上原子）；
 *   4. 任何异常 → `{ok:false}` / `[]` / `null`，绝不抛（磁盘满、目录不可写、
 *      文件被改成目录都不影响压缩/交接本体）。
 *
 * 行数计数在 store 生命周期内缓存（首次 append/`count()` 时读一次文件），
 * 跨进程并发下可能少算几行 —— 下一次超阈值轮转时自然收敛；诊断数据可接受。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 文件状态（不抛）。
 * @param {string} file
 * @returns {{exists:boolean, size:number, mtimeMs:number|null}}
 */
export function jsonlStat(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: null };
  }
}

/**
 * 读整个文件（失败/不存在 → null，不抛）。
 * @param {string} file
 * @returns {string|null}
 */
export function readJsonlText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 文本 → 有效行（去空行/去首尾空白；不解析 JSON）。
 * @param {string|null} text
 * @returns {string[]}
 */
export function splitJsonlLines(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) lines.push(trimmed);
  }
  return lines;
}

/**
 * 原子重写（tmp→rename；dk 目录自动创建；失败返回 false）。
 * @param {string} file
 * @param {string[]} lines
 * @returns {boolean}
 */
export function rewriteJsonlLines(file, lines) {
  try {
    const list = Array.isArray(lines) ? lines.filter((line) => typeof line === 'string' && line.length > 0) : [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, list.length === 0 ? '' : `${list.join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 追加一行（自动 mkdir；失败返回 false，不抛）。
 * @param {string} file
 * @param {string} line
 * @returns {boolean}
 */
export function appendJsonlLine(file, line) {
  try {
    if (typeof line !== 'string' || line.length === 0) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * JSONL 有界日志（一个文件一个实例；同一路径重复创建会各自计数，见文件头）。
 *
 * @param {object} options
 * @param {string} options.file
 * @param {number} [options.maxRows] 行数上限（0 = 不限）
 * @param {number} [options.byteLimit] 字节上限（0 = 不限）
 * @param {(lines:string[]) => string[]} [options.prune] 轮转时的裁剪函数（省略 = 保留最近 maxRows 行）
 * @returns {{filePath:string, append:Function, count:Function, readText:Function, stat:Function, status:Function}}
 */
export function createJsonlLog({ file, maxRows = 0, byteLimit = 0, prune } = {}) {
  const rowsCap = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : 0;
  const bytesCap = Number.isInteger(byteLimit) && byteLimit > 0 ? byteLimit : 0;
  let rows = null; // 懒加载：null = 还没数过

  function ensureRows() {
    if (rows !== null) return rows;
    rows = splitJsonlLines(readJsonlText(file)).length;
    return rows;
  }

  function shouldRotate() {
    if (rowsCap > 0 && ensureRows() > rowsCap) return true;
    if (bytesCap > 0 && jsonlStat(file).size > bytesCap) return true;
    return false;
  }

  function rotate() {
    const lines = splitJsonlLines(readJsonlText(file));
    const kept =
      typeof prune === 'function'
        ? prune(lines)
        : rowsCap > 0
          ? lines.slice(-rowsCap)
          : lines;
    const safe = Array.isArray(kept) ? kept.filter((line) => typeof line === 'string' && line.length > 0) : [];
    if (!rewriteJsonlLines(file, safe)) return { rotated: false, rows };
    rows = safe.length;
    return { rotated: true, rows };
  }

  return {
    filePath: file,
    /**
     * 追加一行；超过上限时轮转。永不抛。
     * @param {string} line 已序列化的单行 JSON
     * @returns {{ok:boolean, rotated?:boolean}}
     */
    append(line) {
      try {
        ensureRows();
        if (!appendJsonlLine(file, line)) return { ok: false };
        rows += 1;
        if (!shouldRotate()) return { ok: true };
        const result = rotate();
        return { ok: true, ...(result.rotated ? { rotated: true } : {}) };
      } catch {
        return { ok: false };
      }
    },
    /** 当前行数（懒计数；失败按 0）。 */
    count() {
      try {
        return ensureRows();
      } catch {
        return 0;
      }
    },
    /** 读文本（失败 → null）。 */
    readText() {
      return readJsonlText(file);
    },
    stat() {
      return jsonlStat(file);
    },
    /**
     * 文件状态：CLI / 端点用来回答「文件在哪、多大、还能不能写」。
     * @returns {{file:string, exists:boolean, size:number, rows:number, mtimeMs:number|null, writeable:boolean}}
     */
    status() {
      const stat = jsonlStat(file);
      let writeable = false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.accessSync(path.dirname(file), fs.constants.W_OK);
        writeable = true;
      } catch {
        writeable = false;
      }
      return {
        file,
        exists: stat.exists,
        size: stat.size,
        rows: ensureRows(),
        mtimeMs: stat.mtimeMs,
        writeable,
      };
    },
  };
}
