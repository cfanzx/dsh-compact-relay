/**
 * 交接单结构校验 —— 纯函数，零依赖。
 *
 * 与 M2 的摘要校验（core/validate-summary.js）同思路，但对象不同：
 * 交接单是给「下一个会话」看的任务书，必须包含规格表里所有必填段、每段非空、
 * 不许夹带标题/前言（模型常犯），也不许出现规格表以外的段落。
 *
 * A1：默认校验九段；交接 writer 只让模型写七段时传 `{titles: HANDOFF_MODEL_SECTIONS}`，
 * 程序段（当前进度/改过的文件）会出现在文档里但不要求模型输出。
 */
import { HANDOFF_MODEL_SECTIONS, HANDOFF_SECTIONS } from './handoff-spec.js';
import { MIN_CONTENT_CHARS, MIN_CONTENT_SECTIONS, contentMetrics, isPlaceholderText } from './placeholders.js';

/**
 * 把一行解析成「六段之一」的标题，不是就返回 null。
 * @param {string} line
 * @returns {string|null}
 */
function sectionOf(line) {
  const match = /^##\s+(.+?)\s*$/.exec(line);
  if (match === null) return null;
  const title = match[1].trim();
  return HANDOFF_SECTIONS.includes(title) ? title : `?${title}`;
}

/**
 * 校验一次交接单正文。
 * @param {string} text 模型输出的 markdown
 * @returns {{ok: boolean, problems: string[], text: string, sections: Record<string,string>}}
 */
export function validateHandoff(text, { titles = HANDOFF_SECTIONS } = {}) {
  const required = Array.isArray(titles) && titles.length > 0 ? titles : HANDOFF_SECTIONS;
  const source = typeof text === 'string' ? text : '';
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return { ok: false, problems: ['交接文档是空的'], text: '', sections: {} };
  }

  const lines = trimmed.split(/\r?\n/);
  /** @type {{title:string, index:number}[]} */
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const title = sectionOf(lines[index]);
    if (title !== null) headings.push({ title, index });
  }

  const problems = [];
  const firstHeading = headings.length > 0 ? headings[0].index : lines.length;
  const preamble = lines.slice(0, firstHeading).join('').trim();
  if (preamble.length > 0) {
    problems.push('第一个标题之前有多余文字（只许输出规定的小节，不要大标题/前言/客套话）');
  }

  /** @type {Record<string,string>} */
  const sections = {};
  const seen = new Map();
  const requiredSet = new Set(required);
  for (let index = 0; index < headings.length; index += 1) {
    const { title, index: lineIndex } = headings[index];
    if (title.startsWith('?')) {
      problems.push(`出现了未定义的小节：## ${title.slice(1)}`);
      continue;
    }
    seen.set(title, (seen.get(title) ?? 0) + 1);
    if (!requiredSet.has(title)) continue;
    const end = index + 1 < headings.length ? headings[index + 1].index : lines.length;
    sections[title] = lines.slice(lineIndex + 1, end).join('\n').trim();
  }

  for (const section of required) {
    const count = seen.get(section) ?? 0;
    if (count === 0) problems.push(`缺少小节：## ${section}`);
    else if (count > 1) problems.push(`小节重复：## ${section}`);
    else if ((sections[section] ?? '').length === 0) problems.push(`小节为空：## ${section}`);
  }

  // 必填小节必须按固定顺序出现（提示词与文档都声明「顺序固定」）。
  // 只在必填段齐全且无重复时检查，避免与「缺段/重复」重复报错；顺序反了就拒绝，让模型重写。
  const ordered = headings
    .map(({ title }) => title)
    .filter((title) => !title.startsWith('?') && requiredSet.has(title));
  if (required.every((section) => seen.get(section) === 1)) {
    const wrongOrder = required.some((section, index) => ordered[index] !== section);
    if (wrongOrder) problems.push(`小节顺序不对：应按 ${required.join(' → ')} 的顺序输出`);
  }

  // 2026-10-19 真机：六段全写 (none) 的「空壳文档」每段都非空，旧校验放行，
  // 结果新会话接手一张白纸。单段占位允许，六段全占位 → 判为不合格。
  // 2026-10-20 修 P1：占位句识别升级后，再加整篇内容量下限——
  // 「五段 (none) + 一句『无明确未决问题』」这类自然语言空话也要拒绝。
  const bodies = required.map((section) => (sections[section] ?? '').trim());
  const allPresent = bodies.every((body) => body.length > 0);
  const allPlaceholder = allPresent && bodies.every((body) => isPlaceholderText(body));
  if (allPlaceholder) {
    problems.push('全部小节都是占位符（(none)/无/空），交接文档没有任何可用信息');
  } else if (allPresent) {
    const metrics = contentMetrics(bodies);
    if (metrics.sections < MIN_CONTENT_SECTIONS || metrics.chars < MIN_CONTENT_CHARS) {
      problems.push(
        `内容过少：只有 ${metrics.sections} 段有实质内容、共 ${metrics.chars} 字` +
          `（至少 ${MIN_CONTENT_SECTIONS} 段 / ${MIN_CONTENT_CHARS} 字），交接文档疑似空壳`,
      );
    }
  }

  return { ok: problems.length === 0, problems, text: trimmed, sections };
}

/**
 * 问题列表 → 重试指令里的多行文字。
 * @param {string[]} problems
 * @returns {string}
 */
export function describeHandoffProblems(problems) {
  return (Array.isArray(problems) ? problems : []).map((problem) => `- ${problem}`).join('\n');
}
