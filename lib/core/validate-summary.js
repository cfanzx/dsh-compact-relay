/**
 * 摘要结构校验 —— 纯函数，零依赖。
 *
 * 来源：REFERENCES.md §1.3（handoff-compaction 的 validateHandoffText 思路）。
 * M1 实测：模型会编造原文没有的文件名/标识符，还会漏掉小节。
 * 结构校验是最后一道闸；不过就走重试，重试还不过就拒绝提交。
 */
import { MIN_CONTENT_CHARS, MIN_CONTENT_SECTIONS, contentMetrics, isPlaceholderText } from './placeholders.js';

/**
 * 「模型把指令当内容复述」的典型信号。
 *
 * 2026-10-19 真机踩过：待压区段太贫瘠（多为基础消息 + 空回复）时，
 * 模型输出的是 "Condense the last 33 messages..." 这种任务复述，
 * 但六段标题齐全 → 旧校验放行 → 垃圾摘要覆盖了真实历史。
 */
export const INSTRUCTION_ECHO_PATTERNS = Object.freeze([
  /summarization request/i,
  /do not address the user/i,
  /do not call any tools/i,
  /HARD RULES/,
  /terse Markdown/i,
  /compaction engine/i,
  /condense the (last|conversation|span|messages)/i,
  /the span to condense/i,
  /already-established background/i,
  /output only the (checkpoint|paragraph|corrected)/i,
  /keep the output at or under/i,
]);

/** 摘要必须具备的小节标题（与 SUMMARY_INSTRUCTION 保持一致）。 */
export const REQUIRED_SECTIONS = Object.freeze([
  '## Current Goal',
  '## Decisions & Facts',
  '## Files & Paths',
  '## Errors & Fixes',
  '## Still Pending',
  '## Open Questions',
]);

/**
 * 把摘要按「行级 `## 标题`」切段，只保留 requiredSections 里的段。
 *
 * 2026-10-19 debug：旧实现用 `joined.includes(section)` + 整篇去标题行判占位，
 * 模型只要加一句前言、「## Current Goal (none)」写在同一行、或套一层代码围栏，
 * 就能让「六段全占位」的空壳摘要通过校验（端到端探针复现：3 条真实历史被空壳 checkpoint 替换）。
 * 这里按段解析，标题必须独立成行且与要求逐字一致，正文逐段判定。
 *
 * @param {string} text
 * @param {readonly string[]} requiredSections
 * @returns {{bodies: Map<string,string>, headings: string[]}}
 */
function sectionTitle(section) {
  return section.replace(/^##\s+/, '').trim();
}

function parseSections(text, requiredSections) {
  const wanted = new Set(requiredSections.map(sectionTitle));
  const bodies = new Map();
  const headings = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (match !== null) {
      const title = match[1].trim();
      if (wanted.has(title)) {
        current = title;
        headings.push(title);
        if (!bodies.has(title)) bodies.set(title, []);
        continue;
      }
      current = null;
      continue;
    }
    if (current !== null) bodies.get(current).push(line);
  }
  const normalized = new Map();
  for (const [title, lines] of bodies) normalized.set(title, lines.join('\n').trim());
  return { bodies: normalized, headings };
}

/**
 * 校验一次摘要输出。
 * @param {object[]} blocks 模型输出的 content blocks
 * @param {{requiredSections?: readonly string[]}} [options]
 * @returns {{ok: boolean, problems: string[], summary: {type:'text', text:string}[]}}
 */
export function validateSummary(blocks, { requiredSections = REQUIRED_SECTIONS } = {}) {
  const textBlocks = (Array.isArray(blocks) ? blocks : []).filter(
    (block) => block !== null && block !== undefined && block.type === 'text' && typeof block.text === 'string',
  );
  const joined = textBlocks
    .map((block) => block.text)
    .join('\n')
    .trim();

  const problems = [];
  if (joined.length === 0) problems.push('empty summary');
  const { bodies, headings } = parseSections(joined, requiredSections);
  for (const section of requiredSections) {
    const body = bodies.get(sectionTitle(section));
    if (body === undefined) problems.push(`missing section: ${section}`);
    else if (body.length === 0) problems.push(`empty section: ${section}`);
  }
  for (const pattern of INSTRUCTION_ECHO_PATTERNS) {
    if (pattern.test(joined)) {
      problems.push(`looks like instruction echo (matched ${pattern}), not a summary of the span`);
      break;
    }
  }

  // 六段全是 (none)/无 → 没有可用信息，提交它会用垃圾 checkpoint 覆盖真实历史。
  // 逐段判定：前言/围栏/行内占位都不再能稀释「全占位」这个事实。
  // 2026-10-20 修 P1：占位句识别升级后，再加整篇内容量下限——
  // 「五段 (none) + 一句『无明确未决问题』」这类自然语言空话也要拒绝。
  const bodyTexts = requiredSections.map((section) => bodies.get(sectionTitle(section)) ?? '');
  const allPresent = bodyTexts.every((body) => body.length > 0);
  if (requiredSections.length > 0 && joined.length > 0 && allPresent) {
    const allPlaceholder = bodyTexts.every((body) => isPlaceholderText(body));
    if (allPlaceholder) {
      problems.push('placeholder-only summary: every required section is empty or (none)/无');
    } else {
      const metrics = contentMetrics(bodyTexts);
      if (metrics.sections < MIN_CONTENT_SECTIONS || metrics.chars < MIN_CONTENT_CHARS) {
        problems.push(
          `内容过少：只有 ${metrics.sections} 段有实质内容、共 ${metrics.chars} 字` +
            `（至少 ${MIN_CONTENT_SECTIONS} 段 / ${MIN_CONTENT_CHARS} 字），疑似空壳摘要`,
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    summary: textBlocks.filter((block) => block.text.trim().length > 0),
  };
}

/**
 * 把问题列表渲染成重试指令里的一段文字。
 * @param {string[]} problems
 * @returns {string}
 */
export function describeProblems(problems) {
  return (Array.isArray(problems) ? problems : []).map((problem) => `- ${problem}`).join('\n');
}
