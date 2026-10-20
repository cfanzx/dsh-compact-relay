/**
 * 压缩历史读侧（A6，只读）—— 从会话日志里还原「最近几次压缩」。
 *
 * 数据本来就在日志里：compaction/start → summary → user/message(replace) → end。
 * 这里只配对、不写任何东西；面板/接口用 `collectCompactions()`。
 *
 * 「已提交」的判定（和 session-view.countSummaries 同口径）：
 *   1. 有覆盖该 summary 的 replace（replace 的 sourceEventSeqs 含 summary.seq）；
 *   2. 有同 compactionId 的 end，且 end 没有 error；
 *   3. 没有 compactionId 的旧日志按旧口径（有 replace 即算）。
 */
import { sessionLog } from './session-view.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const PREVIEW_CHARS = 200;

/**
 * 把任意文本压成单行预览。
 * 真实 DSH 的 compaction/summary.data.summary 是内容块数组（[{type:'text',text}]），
 * 测试/旧版也可能是纯字符串——两种都归一。
 */
function flatten(value) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (Array.isArray(value)) {
    text = value
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block !== null && typeof block === 'object') {
          if (typeof block.text === 'string') return block.text;
          if (typeof block.content === 'string') return block.content;
        }
        return '';
      })
      .filter((part) => part.length > 0)
      .join('\n');
  }
  return text.replace(/\s+/gu, ' ').trim();
}

/** 摘要正文预览（超长截断，保留省略号）。 */
function previewOf(value, max = PREVIEW_CHARS) {
  const text = flatten(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 日志事件里可用的时间戳（不同版本字段可能不同）。 */
function atOf(event) {
  for (const key of ['time', 'at', 'timestamp', 'createdAt']) {
    const value = event?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function limitOf(options) {
  const raw = Number(options?.limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(raw)));
}

/**
 * 收集最近的压缩记录（最新在前）。
 *
 * @param {object} session DSH 会话（只读使用 .log / .events()）
 * @param {{limit?:number, previewChars?:number}} [options]
 * @returns {Array<{
 *   seq:number,
 *   compactionId:string|null,
 *   at:number|null,
 *   committed:boolean,
 *   open:boolean,
 *   error:object|null,
 *   replaceSeq:number|null,
 *   shadowedRange:{start:number,end:number}|null,
 *   shadowedCount:number,
 *   shadowedTokens:number,
 *   provider:string|null,
 *   model:string|null,
 *   preview:string,
 *   previewTruncated:boolean,
 * }>}
 */
export function collectCompactions(session, options = {}) {
  const limit = limitOf(options);
  const maxChars = Number.isFinite(options.previewChars) ? Math.max(1, Math.trunc(options.previewChars)) : PREVIEW_CHARS;
  const log = sessionLog(session);

  const summaries = [];
  const ends = new Map(); // compactionId -> end.data
  const replaceByCoveredSeq = new Map(); // 被 replace 覆盖的 seq -> replace event

  for (const event of log) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'compaction/summary') {
      summaries.push(event);
    } else if (event.type === 'compaction/end') {
      const id = event.data?.compactionId;
      if (typeof id === 'string') ends.set(id, event.data);
    } else if (event.type === 'user/message' && Array.isArray(event.sourceEventSeqs)) {
      for (const seq of event.sourceEventSeqs) {
        if (typeof seq === 'number' && Number.isFinite(seq)) replaceByCoveredSeq.set(seq, event);
      }
    }
  }

  const items = [];
  for (let index = summaries.length - 1; index >= 0 && items.length < limit; index -= 1) {
    const summary = summaries[index];
    const data = summary.data !== null && typeof summary.data === 'object' ? summary.data : {};
    const compactionId = typeof data.compactionId === 'string' ? data.compactionId : null;
    const end = compactionId === null ? undefined : ends.get(compactionId);
    const replace = replaceByCoveredSeq.get(summary.seq);
    const shadowedSeqs = Array.isArray(data.shadowedSeqs)
      ? data.shadowedSeqs.filter((seq) => typeof seq === 'number' && Number.isFinite(seq))
      : [];
    const rawPreview = flatten(data.summary);
    items.push({
      seq: typeof summary.seq === 'number' ? summary.seq : null,
      compactionId,
      at: atOf(summary),
      committed: replace !== undefined && (compactionId === null ? true : end !== undefined && end.error === undefined),
      open: compactionId !== null && end === undefined,
      error: end?.error ?? null,
      replaceSeq: typeof replace?.seq === 'number' ? replace.seq : null,
      shadowedRange:
        data.shadowedRange !== null && typeof data.shadowedRange === 'object' ? data.shadowedRange : null,
      shadowedCount: shadowedSeqs.length,
      shadowedTokens: typeof data.shadowedTokenCount === 'number' && Number.isFinite(data.shadowedTokenCount)
        ? data.shadowedTokenCount
        : 0,
      provider: typeof data.provider === 'string' ? data.provider : null,
      model: typeof data.model === 'string' ? data.model : null,
      preview: previewOf(rawPreview, maxChars),
      previewTruncated: rawPreview.length > maxChars,
    });
  }
  return items;
}

/** 最近一次压缩（没有返回 null）。 */
export function latestCompaction(session, options = {}) {
  return collectCompactions(session, { ...options, limit: 1 })[0] ?? null;
}
