/**
 * 轻账本（0.4 P1-3）—— 文件读写层（JSONL，存 `~/.dsh/compact-relay-ledger.jsonl`）。
 *
 * 设计红线：
 *  - **不影响本体**：所有 IO 都 try/catch 吞掉，`record()` 永不抛；写失败只返回 `{ok:false}`，
 *    压缩/交接照常成功（磁盘满、目录不可写、文件被改成目录都不影响动作）；
 *  - **损坏静默降级**：读侧跳过坏行/坏记录（`core/ledger.js` 的 parse），不让一行坏数据毁掉全部历史；
 *  - **有界**：只保留最近 `maxEntries`（默认 200）条，超过就整文件重写成最近 N 条（先写 tmp 再 rename）；
 *  - 只记数值/枚举/时间/交接单路径；不记消息、摘要、交接单正文、sessionId、cwd（见 core/ledger.js）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultDshHome } from '../core/config-schema.js';
import {
  LEDGER_MAX_ENTRIES,
  buildLedgerRecord,
  parseLedgerLines,
  summarizeLedgerRecords,
} from '../core/ledger.js';
import { localIso } from './diag-counters.js';

/** 账本文件名（放 DSH_HOME 下，与 compact-relay.json 同级）。 */
export const LEDGER_FILE = 'compact-relay-ledger.jsonl';

/** 默认账本路径：`$DSH_HOME/compact-relay-ledger.jsonl`（缺省 ~/.dsh）。 */
export function defaultLedgerPath() {
  return path.join(defaultDshHome(), LEDGER_FILE);
}

/**
 * 读取账本（损坏行跳过；任何 IO 异常 → 空数组，不抛）。
 * @param {string} [file]
 * @param {{maxEntries?:number}} [options]
 * @returns {object[]}
 */
export function readLedgerFile(file = defaultLedgerPath(), { maxEntries = LEDGER_MAX_ENTRIES } = {}) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const records = parseLedgerLines(text);
    const cap = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : LEDGER_MAX_ENTRIES;
    return records.length > cap ? records.slice(-cap) : records;
  } catch {
    return [];
  }
}

/**
 * 追加一条记录，并在超过上限时裁剪到最近 N 条。
 * 永不抛：失败返回 `{ok:false}`（调用方无需处理，也不能因此改变压缩/交接结果）。
 * @param {object} record buildLedgerRecord 的产物
 * @param {string} [file]
 * @param {{maxEntries?:number}} [options]
 * @returns {{ok:boolean}}
 */
export function appendLedgerRecord(record, file = defaultLedgerPath(), { maxEntries = LEDGER_MAX_ENTRIES } = {}) {
  try {
    if (record === null || typeof record !== 'object') return { ok: false };
    const cap = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : LEDGER_MAX_ENTRIES;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    // 有界：条目超过上限时，整文件重写成最近 cap 条（原子替换，避免读到半截文件）。
    const all = readLedgerFile(file, { maxEntries: Number.MAX_SAFE_INTEGER });
    if (all.length > cap) {
      const kept = all.slice(-cap);
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, file);
    }
    return { ok: true };
  } catch {
    // 静默降级：账本不可写绝不能影响压缩/交接本体。
    return { ok: false };
  }
}

/**
 * 账本存储单例（lib/index.js 装配到 deps.ledger；actions 通过 deps.ledger 记录）。
 *
 * @param {{file?:string, maxEntries?:number}} [options]
 * @returns {{filePath:string, record:Function, records:Function, summary:Function}}
 */
export function createLedgerStore({ file = defaultLedgerPath(), maxEntries = LEDGER_MAX_ENTRIES } = {}) {
  return {
    filePath: file,
    /**
     * 记一条流水（自动补本地时间）；构造非法/写失败都静默返回 {ok:false}。
     * @param {object} input buildLedgerRecord 的入参（不含 at，由这里注入）
     * @returns {{ok:boolean}}
     */
    record(input) {
      try {
        const record = buildLedgerRecord({ ...(input !== null && typeof input === 'object' ? input : {}), at: localIso() });
        if (record === null) return { ok: false };
        return appendLedgerRecord(record, file, { maxEntries });
      } catch {
        return { ok: false };
      }
    },
    /** 最近 N 条（默认全部，最多 maxEntries）；读失败返回 []。 */
    records({ limit } = {}) {
      return readLedgerFile(file, { maxEntries: Number.isInteger(limit) && limit > 0 ? limit : maxEntries });
    },
    /** 设置页一行累计数字；读失败按空账本处理（全 0 / null，不抛）。 */
    summary() {
      return summarizeLedgerRecords(readLedgerFile(file, { maxEntries }));
    },
  };
}
