/**
 * 0.3.4（BUG-005）轻量 Markdown 单测：块级/行内解析 + XSS 原样当文本 + 边界。
 */
import assert from 'node:assert/strict';
import { parseInlineLite, parseMarkdownLite } from '../lib/core/markdown-lite.js';

/* ------------------------------------------------------------------ *
 * 1. 行内：粗体 / 行内代码 / 转义 / 未闭合标记
 * ------------------------------------------------------------------ */

assert.deepEqual(parseInlineLite('普通文本'), [{ type: 'text', text: '普通文本' }]);
assert.deepEqual(parseInlineLite('前 **重点** 后'), [
  { type: 'text', text: '前 ' },
  { type: 'strong', text: '重点' },
  { type: 'text', text: ' 后' },
]);
assert.deepEqual(parseInlineLite('用 `code` 调用'), [
  { type: 'text', text: '用 ' },
  { type: 'code', text: 'code' },
  { type: 'text', text: ' 调用' },
]);
assert.deepEqual(parseInlineLite('**粗** 和 `代` 混排'), [
  { type: 'strong', text: '粗' },
  { type: 'text', text: ' 和 ' },
  { type: 'code', text: '代' },
  { type: 'text', text: ' 混排' },
]);
// 未闭合标记按字面文本处理，不吞字符
assert.deepEqual(parseInlineLite('未闭合 **粗体'), [{ type: 'text', text: '未闭合 **粗体' }]);
assert.deepEqual(parseInlineLite('未闭合 `代码'), [{ type: 'text', text: '未闭合 `代码' }]);
// 反斜杠转义
assert.deepEqual(parseInlineLite('\\*不是粗体\\*'), [{ type: 'text', text: '*不是粗体*' }]);
// 空输入
assert.deepEqual(parseInlineLite(''), []);
assert.deepEqual(parseInlineLite(null), []);

/* ------------------------------------------------------------------ *
 * 2. XSS：任何 HTML 都只是文本，不产生 html 节点（渲染器只用 React 文本节点）
 * ------------------------------------------------------------------ */

const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const xssBlocks = parseMarkdownLite(xss);
assert.equal(xssBlocks.length, 1);
assert.equal(xssBlocks[0].type, 'paragraph');
assert.deepEqual(xssBlocks[0].segments, [{ type: 'text', text: xss }], 'HTML 必须原样当文本');
assert.equal(JSON.stringify(xssBlocks).includes('"html"'), false, '解析结果里不允许出现 html 节点类型');
const xssInline = parseInlineLite('`<b>code</b>` 和 **<i>x</i>**');
assert.deepEqual(xssInline, [
  { type: 'code', text: '<b>code</b>' },
  { type: 'text', text: ' 和 ' },
  { type: 'strong', text: '<i>x</i>' },
]);

/* ------------------------------------------------------------------ *
 * 3. 块级：标题 / 段落 / 列表 / 代码块 / 分隔线
 * ------------------------------------------------------------------ */

assert.deepEqual(parseMarkdownLite(''), []);
assert.deepEqual(parseMarkdownLite('   \n\n'), []);

const headings = parseMarkdownLite('# 一级\n## 二级\n###### 六级');
assert.deepEqual(
  headings.map((block) => [block.type, block.level]),
  [
    ['heading', 1],
    ['heading', 2],
    ['heading', 6],
  ],
);
// `#######` 七级不是标题（按段落）
assert.equal(parseMarkdownLite('####### 七级')[0].type, 'paragraph');

const paragraph = parseMarkdownLite('第一行\n第二行\n\n新段落');
assert.equal(paragraph.length, 2);
assert.deepEqual(paragraph[0].segments, [{ type: 'text', text: '第一行\n第二行' }], '段落内保留换行');
assert.deepEqual(paragraph[1].segments, [{ type: 'text', text: '新段落' }]);

const unordered = parseMarkdownLite('- 甲\n- 乙\n- 丙');
assert.deepEqual(
  unordered.map((block) => block.type),
  ['list'],
);
assert.equal(unordered[0].ordered, false);
assert.equal(unordered[0].items.length, 3);
assert.deepEqual(unordered[0].items[1], [{ type: 'text', text: '乙' }]);

const ordered = parseMarkdownLite('3. 丙\n4. 丁');
assert.equal(ordered[0].ordered, true);
assert.equal(ordered[0].start, 3, '有序列表要保留起始编号');
assert.equal(ordered[0].items.length, 2);

// 列表项支持行内标记
const richList = parseMarkdownLite('- **重点**：`file.js`');
assert.deepEqual(richList[0].items[0], [
  { type: 'strong', text: '重点' },
  { type: 'text', text: '：' },
  { type: 'code', text: 'file.js' },
]);

// 列表遇到空行/其它块结束
const listThenPara = parseMarkdownLite('- 甲\n- 乙\n\n普通段落');
assert.deepEqual(
  listThenPara.map((block) => block.type),
  ['list', 'paragraph'],
);

const code = parseMarkdownLite('```js\nconst a = 1 < 2;\nconsole.log(a);\n```');
assert.equal(code.length, 1);
assert.equal(code[0].type, 'code');
assert.equal(code[0].lang, 'js');
assert.equal(code[0].text, 'const a = 1 < 2;\nconsole.log(a);', '代码块内不做行内解析/转义');
// 未闭合围栏：到文件尾仍作为代码块
const unclosed = parseMarkdownLite('```\n没关`\n还有');
assert.equal(unclosed[0].type, 'code');
assert.equal(unclosed[0].text, '没关`\n还有');

const hr = parseMarkdownLite('---\n***\n___');
assert.deepEqual(
  hr.map((block) => block.type),
  ['hr', 'hr', 'hr'],
);

/* ------------------------------------------------------------------ *
 * 4. 真实交接单片段：标题 + 元信息列表 + 正文列表 + 代码块
 * ------------------------------------------------------------------ */

const handoff = [
  '# 交接单',
  '',
  '- 生成时间：2026-10-19T12:31:42.001Z',
  '- 原会话标题：排查卡顿',
  '',
  '## 总体目标',
  '把旧历史压成摘要后继续。',
  '',
  '## 下一步',
  '1. 先看 `~/.dsh/logs`',
  '2. 再跑 **npm test**',
  '',
  '```bash',
  'node test/smoke.mjs',
  '```',
].join('\n');
const parsed = parseMarkdownLite(handoff);
assert.deepEqual(
  parsed.map((block) => block.type),
  ['heading', 'list', 'heading', 'paragraph', 'heading', 'list', 'code'],
);
assert.equal(parsed[0].level, 1);
assert.equal(parsed[1].items.length, 2);
assert.equal(parsed[5].ordered, true);
assert.equal(parsed[6].lang, 'bash');
assert.equal(parsed[6].text, 'node test/smoke.mjs');

console.log('PASS  0.3.4 markdown-lite：行内（粗体/代码/转义/未闭合）');
console.log('PASS  0.3.4 markdown-lite：XSS 原样文本 + 无 html 节点');
console.log('PASS  0.3.4 markdown-lite：标题/段落/列表/代码块/分隔线 + 真实交接单片段');
