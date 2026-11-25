/**
 * 浮层定位辅助（本地 fork 修复，2026-11-25）。
 *
 * 症状：菜单 / 悬停卡出现在窗口底部、离按钮很远，底部还被窗口裁掉。
 * 原因：DSH 0.2.2+ 的 composer 容器会建立 containing block（transform / filter /
 *       perspective / contain / will-change 任一即可）。此时 `position: fixed` 的浮层
 *       相对**该祖先**定位，而 `getBoundingClientRect()` 返回的是**视口**坐标。
 *       两套坐标系混用 → 整体偏移到容器底部。上游 issue #1 / #2。
 * 修法：把锚点换算到 containing block 的坐标系（视口坐标 − 容器矩形左上角）。
 */
    /** 返回会建立 containing block 的最近祖先相对视口的偏移；没有则为 0。 */
    const popupContainingBox = (el) => {
      const zero = { left: 0, top: 0, bottom: 0 };
      if (el === null || el === undefined || typeof window === 'undefined') return zero;
      let node = el.parentElement;
      while (node !== null && node !== undefined && node !== document.documentElement) {
        const style = window.getComputedStyle(node);
        const transforms = style.transform !== 'none' && style.transform !== '';
        const filters = typeof style.filter === 'string' && style.filter !== 'none' && style.filter !== '';
        const perspectives = style.perspective !== 'none' && style.perspective !== '';
        const contains = /paint|layout|strict|content/.test(style.contain || '');
        const willChange = /transform|filter|perspective/.test(style.willChange || '');
        if (transforms || filters || perspectives || contains || willChange) {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, top: rect.top, bottom: rect.bottom };
        }
        node = node.parentElement;
      }
      return zero;
    };