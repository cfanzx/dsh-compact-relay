/**
 * 占位符识别 —— 交接单与压缩摘要共用。
 *
 * 2026-10-19 真机踩过：模型在「没有内容」时会按提示词写 (none)，
 * 而六段全写 (none) 的交接单「每段都非空」→ 旧校验放行 → 空壳文档被写盘、
 * 还建了新会话，接手者拿到一张白纸。摘要侧同理会把真实历史换成垃圾 checkpoint。
 *
 * 单段占位是规格允许的（比如「进行中的」确实没有），
 * 但整篇全是占位说明模型什么也没写，必须拒绝。
 */

/** 归一化后算占位的写法（大小写、全半角括号、列表符号、句末标点都不影响）。 */
const PLACEHOLDER_WORDS = new Set([
  '(none)',
  'none',
  'n/a',
  'na',
  'nil',
  'null',
  'empty',
  'tbd',
  'todo',
  'nothing',
  '暂无内容',
  '待补充',
  '待定',
  'n/a(无)',
  '(无)',
  '无',
  '暂无',
  '没有',
  '无内容',
  '没有内容',
  '空',
  '(空)',
  '-',
  '--',
  '—',
  '…',
  '...',
]);

/**
 * 自然语言「空话」句——不是单个占位词，但整句没有任何可核对信息。
 *
 * 2026-10-20 修 P1：旧实现只查枚举白名单。模型把「暂无」写成
 * 「无明确未决问题」「No open questions.」就能绕过——
 * 五段 (none) + 一句自然语言空话仍然通过校验，空壳 checkpoint 覆盖真实历史。
 */
const CN_PLACEHOLDER_SENTENCE = new RegExp(
  '^(?:当前|目前|现在)?(?:' +
    '无|没有|暂无|未发现|没有发现|无任何|没有任何|无明确|暂无明确|没有明确|' +
    '无特别|无新增|没有新增|无变化|没有变化|无相关|无其他|没有其他|不适用' +
    ')(?:任何)?(?:的)?(?:未决|待办|待处理|待确认|待补充|待定|问题|事项|内容|发现|变化|新增|相关|特别|明确)?' +
    '(?:问题|事项|内容|任务|文件|变化|发现)?[。．.,，;；!！?？]*$',
  'u',
);
const CN_PENDING_SENTENCE = /^(?:待|等待)(?:后续|进一步)?(?:补充|确认|定|处理|观察|跟进)?[。．.,，;；!！?？]*$/u;
/** 英文空话：no/none/nothing (+ 可选限定词) (+ 可选对象) (+ yet)。 */
const EN_PLACEHOLDER_SENTENCE =
  /^(?:no|none|nothing|n\/a|nil|null|tbd|todo|empty|not applicable)(?:\s+(?:open|pending|outstanding|known|additional|specific|other|new|unresolved|further|notable|relevant|remaining))?(?:\s+(?:questions?|issues?|tasks?|items?|changes?|concerns?|problems?|blockers?))?(?:\s+yet)?[.!?]*$/i;

/** 整篇至少要有这么多实质字符、这么多段有实质内容，才算「写了东西」。 */
export const MIN_CONTENT_CHARS = 40;
export const MIN_CONTENT_SECTIONS = 2;

/**
 * 去掉列表符号/强调符号，只留句子本体（保留空格，给英文/中文两套匹配共用）。
 * @param {string} line
 * @returns {string}
 */
function sentenceText(line) {
  return String(line ?? '')
    .trim()
    .replace(/^(?:[-*+·•]|\d+[.)、])\s*/u, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * 一整行是不是「自然语言空话」（空行也算）。
 * 例：`无明确未决问题。`、`暂无待办`、`Nothing yet.`、`No open questions.`
 * 反例：`无（等待用户拍板）`、`none of the above is true`、`待办：明天修复`。
 * @param {string} line
 * @returns {boolean}
 */
export function isPlaceholderSentence(line) {
  const text = sentenceText(line);
  if (text.length === 0) return true;
  const compact = text.replace(/\s+/g, '');
  if (CN_PLACEHOLDER_SENTENCE.test(compact) || CN_PENDING_SENTENCE.test(compact)) return true;
  return EN_PLACEHOLDER_SENTENCE.test(text);
}

/**
 * 单行归一化：去列表符号 / 强调符号 / 引号 / 空白 / 句末标点，全角括号转半角。
 * @param {string} line
 * @returns {string}
 */
function normalizeLine(line) {
  return String(line ?? '')
    .trim()
    .replace(/^(?:[-*+·•]|\d+[.)、])\s*/u, '')
    .replace(/[*_`~]+/g, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[。．.,，;；:：!！?？]+$/u, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase()
    // 2026-10-19 debug：模型常把占位词再包一层括号（（暂无）/(暂无内容)），
    // 归一化后去掉外层括号再查集合，否则「六段全 (暂无)」会被当成有内容。
    .replace(/^\((.*)\)$/, '$1');
}

/**
 * 一行是不是纯占位（空行也算占位）。
 * 2026-10-20 起除枚举词外，还认「无明确未决问题」「No open questions.」这类自然语言空话。
 * @param {string} line
 * @returns {boolean}
 */
export function isPlaceholderLine(line) {
  const text = normalizeLine(line);
  return text.length === 0 || PLACEHOLDER_WORDS.has(text) || isPlaceholderSentence(line);
}

/**
 * 一段文字是不是「全空/全占位」——只要有一行是实质内容就返回 false。
 * @param {string} text
 * @returns {boolean}
 */
export function isPlaceholderText(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    if (!isPlaceholderLine(line)) return false;
  }
  return true;
}

/**
 * 统计几段文字的实质内容量（占位句/空行/纯符号都不算）。
 * 用于「六段标题齐全、每段都有字，但整篇没有信息」的兜底判断。
 * @param {string[]} texts
 * @returns {{chars:number, sections:number}}
 */
export function contentMetrics(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  let chars = 0;
  let sections = 0;
  for (const text of list) {
    let sectionChars = 0;
    for (const line of String(text ?? '').split(/\r?\n/)) {
      if (isPlaceholderLine(line)) continue;
      sectionChars += sentenceText(line)
        .replace(/[#>|]/g, '')
        .replace(/\s+/g, '')
        .length;
    }
    chars += sectionChars;
    if (sectionChars >= 4) sections += 1;
  }
  return { chars, sections };
}
