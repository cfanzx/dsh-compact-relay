
    /* @inline core/markdown-lite.js */

    /**
     * 交接单详情面板的轻量 Markdown 渲染（0.3.4 BUG-005）。
     *
     * 解析在 core/markdown-lite.js（构建时内联，同一份源码有 node 单测），这里只把
     * 结构化块映射成 React 节点。全部是 React 文本节点，**从不生成 HTML**，
     * 因此交接单内容里的 `<script>` 只会显示成文字，没有 XSS 面。
     */
    const MARKDOWN_MONO_STYLE = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    };
    const MARKDOWN_INLINE_CODE_STYLE = {
      ...MARKDOWN_MONO_STYLE,
      fontSize: 10.5,
      background: 'rgba(127,127,127,0.16)',
      borderRadius: 4,
      padding: '0 3px',
    };
    const MARKDOWN_CODE_BLOCK_STYLE = {
      ...MARKDOWN_MONO_STYLE,
      margin: '6px 0',
      padding: '6px 8px',
      borderRadius: 6,
      background: 'rgba(127,127,127,0.16)',
      overflowX: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      fontSize: 10.5,
      lineHeight: '15px',
    };

    /** 行内片段 → React 子节点（文本/粗体/行内代码）。 */
    function renderInlineLite(segments, keyPrefix) {
      return segments.map((segment, index) => {
        const key = `${keyPrefix}-${index}`;
        if (segment.type === 'strong') return h('strong', { key }, segment.text);
        if (segment.type === 'code') return h('code', { key, style: MARKDOWN_INLINE_CODE_STYLE }, segment.text);
        return segment.text;
      });
    }

    /**
     * 把 markdown 文本渲染成 React 节点数组（标题/段落/列表/代码块/分隔线）。
     * @param {string} text
     * @returns {object[]}
     */
    function renderMarkdownLite(text) {
      const blocks = parseMarkdownLite(typeof text === 'string' ? text : '');
      return blocks
        .map((block, index) => {
          const key = `md-${index}`;
          if (block.type === 'heading') {
            return h(
              'div',
              {
                key,
                style: {
                  fontWeight: 600,
                  fontSize: block.level <= 2 ? 13 : 12,
                  lineHeight: '17px',
                  marginTop: index === 0 ? 0 : 10,
                  marginBottom: 4,
                },
              },
              renderInlineLite(block.segments, `${key}-h`),
            );
          }
          if (block.type === 'paragraph') {
            return h(
              'div',
              { key, style: { margin: '4px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
              renderInlineLite(block.segments, `${key}-p`),
            );
          }
          if (block.type === 'list') {
            return h(
              'div',
              { key, style: { margin: '2px 0 6px' } },
              block.items.map((item, itemIndex) =>
                h(
                  'div',
                  { key: `${key}-i${itemIndex}`, style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
                  h(
                    'span',
                    { style: { flex: 'none', minWidth: block.ordered ? 18 : 8, opacity: 0.7 } },
                    block.ordered ? `${block.start + itemIndex}.` : '•',
                  ),
                  h(
                    'span',
                    { style: { flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                    renderInlineLite(item, `${key}-i${itemIndex}-s`),
                  ),
                ),
              ),
            );
          }
          if (block.type === 'code') {
            return h('pre', { key, style: MARKDOWN_CODE_BLOCK_STYLE }, block.text);
          }
          if (block.type === 'hr') {
            return h('div', { key, style: { borderTop: '1px solid rgba(127,127,127,0.35)', margin: '8px 0' } });
          }
          return null;
        })
        .filter((node) => node !== null);
    }
