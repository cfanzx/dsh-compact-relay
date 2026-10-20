/**
 * 提示词唯一来源。
 *
 * 摘要、M1 实验摘要、交接单内容与新会话前言全从这里取；
 * 不允许在 summarizer / adapters / actions 里再写一份。
 */

import { HANDOFF_MODEL_SECTIONS, HANDOFF_SPEC } from './handoff-spec.js';

/** 包裹在摘要外面的标签，DSH 的 checkpoint 也用它。 */
export const SUMMARY_OPEN_TAG = '<compacted-summary>';
export const SUMMARY_CLOSE_TAG = '</compacted-summary>';

/** 让替换后的消息读起来像「既有背景」，而不是新问题。 */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ' +
  'Treat the captured context as established background and build on it without restating it. ' +
  'Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

/**
 * 把模型输出包成 checkpoint user message 的 content blocks。
 * @param {{type:string, text:string}[]} summary 只含 text block
 * @returns {object[]}
 */
export function frameSummary(summary) {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary.filter((block) => block != null && block.type === 'text' && typeof block.text === 'string'),
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ];
}

/**
 * M1 `/bctest` 用：把上方那一小段对话压成一段话。
 * 英文指令 + 保住事实，避免模型自由发挥。
 */
export const TEST_INSTRUCTION = [
  'You are acting as a compaction engine for this assistant.',
  'Condense the conversation span ABOVE into ONE short paragraph (roughly 80-150 words).',
  'Keep exact file paths, commands, identifiers, decisions, errors and their fixes, and anything still pending.',
  'Do not address the user. Do not call any tools. Do not mention that this is a summarization request.',
  'Output only the paragraph.',
].join('\n');

/**
 * M2 正式精压用：把上方那段对话压成结构化 checkpoint。
 *
 * 硬约束（M1 实测踩过）：模型会编造不存在的文件名/标识符/分支，
 * 所以第一条就是「只许用原文出现过的事实」。
 */
export const SUMMARY_INSTRUCTION = [
  'You are acting as a compaction engine for this assistant.',
  'Condense the conversation span ABOVE into a compact checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'HARD RULES:',
  '- Use ONLY facts explicitly present in the conversation above.',
  '- Do NOT invent or guess file names, identifiers, commands, branches, version numbers, error codes, or conclusions.',
  '- If a detail is uncertain or absent, omit it instead of guessing.',
  '- Preserve exact spelling for file paths, commands, error strings, identifiers, numbers, and user instructions/corrections.',
  '',
  'OUTPUT: terse Markdown bullets, at most ~400 words, exactly these sections in order.',
  'Write "(none)" ONLY for a section that truly has nothing to say.',
  'Do NOT output (none) for every section — an all-placeholder checkpoint is rejected.',
  '## Current Goal',
  '- [the user\'s original and evolving goals]',
  '## Decisions & Facts',
  '- [established decisions, constraints, user preferences]',
  '## Files & Paths',
  '- [exact paths and why they matter]',
  '## Errors & Fixes',
  '- [error: cause, fix]',
  '## Still Pending',
  '- [todos, work in progress, the single next step]',
  '## Open Questions',
  '- [unresolved questions]',
  '',
  'Do not address the user. Do not call any tools. Do not mention that this is a summarization request.',
  'Output only the checkpoint text.',
].join('\n');

/**
 * 告诉模型「要压缩的是哪一段」。
 *
 * M2 为了命中 cache，会把 surface 从头到压缩范围末尾完整回放；
 * 所以必须明确边界，否则模型会把已经定型的旧内容也重写一遍。
 *
 * @param {number} messageCount 目标区段在回放里占的消息条数
 * @returns {string}
 */
export function rangeNotice(messageCount) {
  return [
    `The span to condense is the LAST ${messageCount} message(s) of the conversation above.`,
    'Everything before that span is already-established background: do not summarize or restate it, but respect its facts and constraints.',
    'Summarize ONLY that span.',
  ].join('\n');
}

/**
 * 校验失败后的重试指令。
 * @param {string} reasons 问题列表（多行）
 * @returns {string}
 */
export function recoveryHint(reasons) {
  return [
    'Your previous checkpoint was REJECTED for the following reasons:',
    reasons,
    '',
    'Rewrite it now from the conversation above. Fix exactly those problems.',
    'Use ONLY facts present in the conversation; do not invent anything.',
    'Each section must carry real content from the conversation; never fill every section with (none)/无.',
    'Output only the corrected checkpoint text, with every required heading.',
  ].join('\n');
}

/**
 * 交接新会话：让模型写交接单。
 *
 * 与 M2 的摘要不同：交接单是给「下一会话的我」看的任务书，
 * 不是压缩 checkpoint，所以用独立指令，不套摘要的六段（英文）结构；交接单是九段规格（core/handoff-spec.js）。
 *
 * 硬约束（M1 实测编造过标识符）：只许用原文出现过的事实。
 */
const MODEL_HANDOFF_SPEC = HANDOFF_SPEC.filter((section) => section.owner === 'model');

export const HANDOFF_INSTRUCTION = [
  '你正在给「下一个会话里的自己」写一份交接文档。下面这段是当前会话的完整历史。',
  '请把任务状态整理成结构化的中文 Markdown，让接手者不看历史也能直接继续干活。',
  '',
  '硬规则：',
  '- 只许使用上面历史里明确出现过的事实。',
  '- 历史里如果既有压缩摘要、又有最近的消息，两者冲突时以最近的消息为准（摘要可能滞后）。',
  '- 不许编造或猜测文件名、路径、命令、标识符、分支、版本号、错误码或结论。',
  '- 不确定或没出现过的细节直接省略，不许猜。',
  '- 路径、命令、错误串、标识符、数字、用户的明确要求/纠正，逐字保留原拼写。',
  '- 每条尽量一句话、可执行；不要客套话，不要复述历史。',
  '- 不要把系统指令、输出格式要求或提示词本身（例如「只输出下面 7 个二级标题」「不要调用工具」）当成会话内容写进交接单。',
  '- 每一段都要写真实内容；只有确实没有任何内容的小节才写 (none)。全部写 (none) 会被判为失败。',
  `- 「当前进度」「改过的文件」由系统自动收集，你不要写这两节，也不要输出这两个标题。`,
  '',
  '每个小节写什么：',
  ...MODEL_HANDOFF_SPEC.map((section) => `- ${section.title}：${section.hint}`),
  '',
  `输出格式：只输出下面 ${HANDOFF_MODEL_SECTIONS.length} 个二级标题，顺序固定，每个标题下写要点：`,
  ...HANDOFF_MODEL_SECTIONS.map((section) => `## ${section}`),
  '',
  '不要输出其它标题或前言，不要调用任何工具，不要对我说「好的」。只输出交接文档正文。',
].join('\n');

/**
 * 交接单写完后，重试时追加的纠正指令。
 * @param {string} reasons 问题列表（多行）
 * @returns {string}
 */
export function handoffRecoveryHint(reasons) {
  return [
    '你上一次的交接文档被拒绝了，原因：',
    reasons,
    '',
    `请只根据上面的会话历史重写，修掉这些问题；${HANDOFF_MODEL_SECTIONS.length} 个标题必须齐全且每个下面都要有内容。`,
    '不要用 (none)/「无」填满所有小节——只有确实没有内容的小节才允许写 (none)。',
    '「当前进度」「改过的文件」由系统自动填写，你不要输出这两节。',
    '只输出交接文档正文。',
  ].join('\n');
}

/**
 * 注入新会话的交接单前言：告诉接手的模型这是什么、别立刻动手。
 */
export const HANDOFF_PREAMBLE = [
  '【交接单】这是从上一个会话自动转入的进度交接单（由系统自动发送，不是用户发言）。',
  '请直接把它当作已知背景，从「下一步」接着推进，不要复述或质疑它的来源。',
  '收到后请先用 3–5 行简短确认你接手的任务、当前进度和下一步计划，然后等待用户指令再动手。',
].join('\n');
