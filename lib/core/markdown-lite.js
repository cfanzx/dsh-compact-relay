/**
 * 轻量 Markdown 解析（0.3.4 BUG-005）—— 纯函数，零依赖。
 *
 * 为什么自己写：交接单详情面板以前把 markdown 原样塞进 `<pre>`，用户在面板里看到的是
 * `## 目标`/`- xxx`/`**粗体**` 源码。引第三方 markdown 渲染器会增加运行时依赖
 * （插件只有 peerDependencies、零运行时依赖是硬约束），而 `dangerouslySetInnerHTML`
 * 又引入 XSS 面。所以这里只解析交接单实际用到的子集，产出**结构化数据**，由客户端
 * 用 React 文本节点渲染 —— 从不生成 HTML，任何 `<script>` 都只会显示成文字。
 *
 * 支持（够用即可，不做完整 CommonMark）：
 *   - 标题 `#`–`######`（段落里的行首）
 *   - 段落（连续非空行；保留原始换行）
 *   - 无序列表 `-` / `*` / `+`
 *   - 有序列表 `1.` / `1)`（保留起始编号）
 *   - 围栏代码块 ```（保留语言标记；块内不做行内解析）
 *   - 分隔线 `---` / `***` / `___`
 *   - 行内：`**粗体**`、`` `行内代码` ``、反斜杠转义
 *
 * 返回值约定（客户端渲染器按此映射 React 节点）：
 *   blocks: Array<
 *     | {type:'heading', level:number, segments:Segment[]}
 *     | {type:'paragraph', segments:Segment[]}
 *     | {type:'list', ordered:boolean, start:number, items:Segment[][]}
 *     | {type:'code', lang:string, text:string}
 *     | {type:'hr'}
 *   >
 *   Segment = {type:'text'|'strong'|'code', text:string}
 */

const FENCE_RE = /^\s*```\s*([^\s`]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*(\d+)[.)]\s+(.*)$/;

/**
 * 解析行内标记：`**粗体**`、`` `代码` ``、反斜杠转义。
 * 未闭合的标记按普通文本处理（不吞字符）。
 * @param {string} text
 * @returns {{type:'text'|'strong'|'code', text:string}[]}
 */
export function parseInlineLite(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const segments = [];
  let buffer = '';
  const flush = () => {
    if (buffer.length > 0) {
      segments.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    // 反斜杠转义：下一个字符按字面量处理（\* 不开启粗体）。
    if (char === '\\' && index + 1 < source.length) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    if (char === '`') {
      const end = source.indexOf('`', index + 1);
      if (end === -1) {
        buffer += char;
        index += 1;
        continue;
      }
      flush();
      segments.push({ type: 'code', text: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (char === '*' && source[index + 1] === '*') {
      const end = source.indexOf('**', index + 2);
      if (end === -1) {
        buffer += '**';
        index += 2;
        continue;
      }
      flush();
      segments.push({ type: 'strong', text: source.slice(index + 2, end) });
      index = end + 2;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flush();
  return segments;
}

/**
 * 把 markdown 文本解析成块数组；空文本返回 []。
 * @param {string} text
 * @returns {object[]}
 */
export function parseMarkdownLite(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  // 连续非空行攒成段落；遇到块级语法先 flush。
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', segments: parseInlineLite(paragraph.join('\n')) });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];

    // 围栏代码块
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      flushParagraph();
      const codeLines = [];
      index += 1;
      while (index < lines.length && FENCE_RE.exec(lines[index]) === null) {
        codeLines.push(lines[index]);
        index += 1;
      }
      // 吃掉收尾围栏（未闭合时到文件尾）
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', lang: fence[1] ?? '', text: codeLines.join('\n') });
      continue;
    }

    // 空行：结束段落
    if (line.trim().length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }

    // 标题
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1].length, segments: parseInlineLite(heading[2]) });
      index += 1;
      continue;
    }

    // 分隔线（注意：`---` 也匹配无序列表语法，必须先判 hr）
    if (HR_RE.test(line)) {
      flushParagraph();
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    const unordered = UL_RE.exec(line);
    const ordered = unordered === null ? OL_RE.exec(line) : null;
    if (unordered !== null || ordered !== null) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const start = isOrdered ? Number(ordered[1]) : 1;
      const items = [];
      const itemRe = isOrdered ? OL_RE : UL_RE;
      while (index < lines.length) {
        const matched = itemRe.exec(lines[index]);
        if (matched === null) break;
        items.push(parseInlineLite(isOrdered ? matched[2] : matched[1]));
        index += 1;
      }
      blocks.push({ type: 'list', ordered: isOrdered, start, items });
      continue;
    }

    // 普通段落行（保留换行）
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}
