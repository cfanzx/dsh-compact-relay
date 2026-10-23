/**
 * dsh-compact-relay —— 浏览器半（DSH client bundle）。
 *
 * 职责：输入框左侧指示灯 / 悬停卡 / 菜单 / 压缩确认卡 / 交接单面板 / toast，
 *       以及 /handoff 命令卡（命令成功后自动切到新会话）。
 * 数据：GET /api/compact-relay-state、SSE /api/compact-relay-stream；
 * 动作：POST /api/compact-relay-action；交接单：GET /api/compact-relay-handoffs。
 *
 * 为什么是单文件：DSH 运行时没有打包器，package.json exports["./client"]
 * 必须指向已构建好的单文件 bundle；拆模块会报 client bundle not found。
 */
window.__ModuleLoader__.load({
  id: 'dsh-compact-relay',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    /**
     * Services this browser half needs.
     *  - slots：挂指示灯、挂 /handoff 命令卡
     *  - sessions：等新会话进会话列表（自动切换的前置条件）
     *  - uiWorkspace：真正把主视图切到新会话（DSH 0.2 的 openSession）
     */
    const inject = ['slots', 'sessions', 'uiWorkspace'];

    /** 兜底颜色：真正生效的颜色以宿主下发的 state.colors 为准（见 palette），这里只在缺省时使用。 */
    const COLORS = {
      track: 'currentColor',
      ringIdle: '#c9ccd1',
      ringAdviseCompact: '#e5484d',
      ringAdviseHandoff: '#e5484d',
      /** M4 阶段标记：外环变阶段色（host 的 colors.stage 优先，默认蓝）。 */
      ringStage: '#f0b429',
      dotIdle: '#d7d9dd',
      dotAdviseHandoff: '#e5484d',
      panelBg: 'var(--dsh-popover-bg, #ffffff)',
      panelBorder: 'rgba(0,0,0,0.10)',
      panelShadow: '0 6px 24px rgba(0,0,0,0.14)',
      text: 'inherit',
      subText: 'rgba(127,127,127,0.95)',
      hover: 'rgba(127,127,127,0.10)',
      error: '#e5484d',
    };

    const RADIUS = 8;
    const CIRC = 2 * Math.PI * RADIUS;

    /**
     * 会话页没有可用的主题 CSS 变量（--dsh-popover-bg 等都不存在），
     * 只能按 body 背景亮度判断深浅色，给菜单/悬停卡配一套能看清的底色与字色。
     */
    function detectTheme() {
      let bg = '';
      let fg = '';
      try {
        const body = getComputedStyle(document.body);
        bg = body.backgroundColor || '';
        fg = body.color || '';
      } catch {
        /* SSR / 测试环境 */
      }
      const nums = (bg.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      const [r, g, b] = nums.length >= 3 ? nums : [255, 255, 255];
      const dark = 0.299 * r + 0.587 * g + 0.114 * b < 128;
      const fgNums = (fg.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      const themeFg = fgNums.length >= 3 ? `rgb(${fgNums[0]}, ${fgNums[1]}, ${fgNums[2]})` : dark ? '#f2f2f5' : '#1f2329';
      // BUG-001：底色/文字/边框优先消费 DSH 主题 token（悬停卡/菜单/确认卡/交接单/toast 共用）；
      // 拿不到 token 的宿主（旧版/隔离测试）才回退到探测出的深浅两套硬编码值。
      // BUG-001（2026-10-20 二次修正）：官方弹层用的是 --dsw-menu-surface-fill +
      // --dsw-menu-backdrop-filter（实测浅色 #f8f9fa94 / 深色 #43454a73 + blur(40px)），
      // 比 overlay token 更贴近系统菜单；拿不到时才回退 overlay → 硬编码两套色。
      const overlayFallback = dark ? '#61666b' : '#e9ecf2';
      return {
        dark,
        panelBg: `var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay, ${overlayFallback}))`,
        panelBackdrop: 'var(--dsw-menu-backdrop-filter, none)',
        panelFg: `var(--dsw-alias-label-primary, ${themeFg})`,
        panelBorder: `var(--dsw-alias-border-l3, ${dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)'})`,
        panelShadow: dark ? '0 6px 24px rgba(0,0,0,0.5)' : '0 6px 24px rgba(0,0,0,0.14)',
        // P2-A1：小字对比度交给 DSH 的次级文字 token，不再写死 0.55 透明度。
        subText: `var(--dsw-alias-label-tertiary, ${dark ? 'rgba(242,242,245,0.72)' : 'rgba(31,35,41,0.66)'})`,
        hover: `var(--dsw-alias-bg-layer-2, ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'})`,
      };
    }

    /**
     * 自动适配颜色：只让用户选 3 个基准色（+ 阶段蓝），再按浅/深界面派生两套。
     *
     * 规则：只调 HSL 明度（灰系不抬饱和），每个候选色算 WCAG 对比度；
     * 不足 3:1 就沿明度方向微调，保证细色环在浅底/深底上都看得清。
     */
    const DEFAULT_BASE = { idle: '#6F7680', compact: '#C26A00', handoff: '#D92D20', stage: '#2563EB', pin: '#C026D3' };

    /** DSH 原生自动压缩线的标记色：刻意不用五级配色里的任何颜色，保证一眼和环上的红/琥珀分开。 */
    const NATIVE_LINE_COLOR = '#7C3AED';
    const SCHEME_BG = { light: '#ffffff', dark: '#1c1c22' };

    function normalizeHex(value, fallback) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
      if (/^#[0-9a-f]{3}$/i.test(text)) {
        return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
      }
      return fallback;
    }

    function hexToHsl(hex) {
      const n = parseInt(normalizeHex(hex, '#888888').slice(1), 16);
      const r = ((n >> 16) & 255) / 255;
      const g = ((n >> 8) & 255) / 255;
      const b = (n & 255) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      if (max === min) return { h: 0, s: 0, l };
      const d = max - min;
      const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      let h;
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      return { h: h * 60, s, l };
    }

    function hslToHex(h, s, l) {
      const hue = ((h % 360) + 360) % 360 / 360;
      const sat = Math.min(1, Math.max(0, s));
      const lig = Math.min(1, Math.max(0, l));
      const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
      const p = 2 * lig - q;
      const channel = (t) => {
        const x = ((t % 1) + 1) % 1;
        if (x < 1 / 6) return p + (q - p) * 6 * x;
        if (x < 1 / 2) return q;
        if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
        return p;
      };
      const to = (value) => Math.round(value * 255).toString(16).padStart(2, '0');
      return `#${to(channel(hue + 1 / 3))}${to(channel(hue))}${to(channel(hue - 1 / 3))}`;
    }

    function luminance(hex) {
      const n = parseInt(normalizeHex(hex, '#888888').slice(1), 16);
      const channel = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
    }

    function contrastRatio(a, b) {
      const la = luminance(a);
      const lb = luminance(b);
      const hi = Math.max(la, lb);
      const lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    }

    function deriveColor(baseHex, scheme) {
      const { h, s, l } = hexToHsl(normalizeHex(baseHex, '#888888'));
      const neutral = s < 0.15;
      let lig = scheme === 'dark' ? Math.max(l, 0.62) : Math.min(l, 0.46);
      const sat = neutral ? s : Math.min(0.92, Math.max(0.4, s));
      const bg = SCHEME_BG[scheme];
      let out = hslToHex(h, sat, lig);
      for (let i = 0; i < 60 && contrastRatio(out, bg) < 3; i += 1) {
        lig = scheme === 'dark' ? Math.min(0.94, lig + 0.01) : Math.max(0.06, lig - 0.01);
        out = hslToHex(h, sat, lig);
      }
      return out;
    }

    /** 取用户选的基准色（兼容旧版直接下发一套颜色）。 */
    function basePalette(colors) {
      if (colors !== null && typeof colors === 'object' && colors.base !== null && typeof colors.base === 'object') {
        const base = {};
        for (const key of ['idle', 'stage', 'pin', 'compact', 'handoff']) {
          base[key] = normalizeHex(colors.base[key], DEFAULT_BASE[key]);
        }
        return base;
      }
      if (colors !== null && typeof colors === 'object' && typeof colors.idle === 'string') {
        return {
          idle: normalizeHex(colors.idle, DEFAULT_BASE.idle),
          stage: normalizeHex(colors.stage, DEFAULT_BASE.stage),
          pin: normalizeHex(colors.pin, DEFAULT_BASE.pin),
          compact: normalizeHex(colors.compact, DEFAULT_BASE.compact),
          handoff: normalizeHex(colors.handoff, DEFAULT_BASE.handoff),
        };
      }
      return { ...DEFAULT_BASE };
    }

    /** 按指定明暗方案生成一套颜色（关闭自动适配时原样返回基准色）。 */
    function paletteForScheme(colors, scheme) {
      const base = basePalette(colors);
      const auto = !(colors !== null && typeof colors === 'object' && colors.autoAdapt === false);
      if (!auto) return base;
      return {
        idle: deriveColor(base.idle, scheme),
        stage: deriveColor(base.stage, scheme),
        pin: deriveColor(base.pin, scheme),
        compact: deriveColor(base.compact, scheme),
        handoff: deriveColor(base.handoff, scheme),
      };
    }

    /** 决定当前用浅色还是深色方案：设置里强制优先，否则跟随界面实际明暗。 */
    function effectiveScheme(colors, detectedDark) {
      if (colors !== null && typeof colors === 'object' && (colors.mode === 'light' || colors.mode === 'dark')) return colors.mode;
      return detectedDark ? 'dark' : 'light';
    }

    /**
     * 选当前生效的一套颜色。
     *
     * A8：优先用 host 在 state/settings view 里下发的 colors.palette[scheme]
     * （两套都算好，浏览器半只挑一套，不必每帧重算派生）；没有下发时按基准色
     * 本地派生 —— 兼容旧 payload，也覆盖设置页「改了还没保存」的即时预览。
     */
    function resolvePalette(colors, detectedDark) {
      const scheme = effectiveScheme(colors, detectedDark);
      const palette = colors !== null && typeof colors === 'object' ? colors.palette : undefined;
      if (palette !== null && typeof palette === 'object') {
        const selected = palette[scheme];
        if (selected !== null && typeof selected === 'object') {
          const base = basePalette(colors);
          const out = {};
          for (const key of ['idle', 'stage', 'pin', 'compact', 'handoff']) {
            out[key] = normalizeHex(selected[key], base[key]);
          }
          return out;
        }
      }
      return paletteForScheme(colors, scheme);
    }

    /** 浅/深两套派生色板（host 下发给浏览器半；纯函数，可单测）。 */
    function paletteForBothSchemes(colors) {
      return { light: paletteForScheme(colors, 'light'), dark: paletteForScheme(colors, 'dark') };
    }
    /**
     * 指示灯环的「分段 + 断点」—— 纯函数，零依赖（0.3.1 新设计）。
     *
     * 2026-10-20 方案对齐：环按「压缩判断」分段，而不是单纯按阈值整体变色。
     *
     * 两个压缩判断路径（谁先到谁就是断点1）：
     * 1. 模型判断：最小线 < 当前 < 压缩线，且内容到了适合压缩的小节点 → 断点1 = 判断时的实际比例；
     * 2. 阈值判断：当前 ≥ 压缩线（设置里的阈值）→ 断点1 = 压缩线比例。
     *
     * 颜色规则：
     * - 正常区 0 → 断点1：还没到断点1 时灰（未走满）；到了断点1（走满）整段蓝；
     * - 压缩区 断点1 → 交接线：琥珀；
     * - 交接区 交接线 → 当前进度：红。
     * - 断点2 = 交接线（设置里的阈值），模型不参与。
     * - 断点只在该边界「两侧都有弧」时显示——压缩后环变短，断点因为前后没有颜色自然消失。
     *
     * 比例都是 0–1；缺口宽度由渲染层按环周长换算（这里只返回边界是否存在）。
     */

    /** 把任意输入收成 0–1。 */
    function clampRatio(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(1, value));
    }

    /**
     * 计算环的分段与断点。
     * @param {number} ratio 当前已用比例（0–1）
     * @param {number} compactRatio 压缩线比例（0–1）
     * @param {number} handoffRatio 交接线比例（0–1）
     * @param {number|null} [hintRatio] 模型判断的「适合压缩」位置（0–1）；没有就是 null
     * @returns {{ratio:number, break1:number|null, segments:{from:number,to:number,color:'idle'|'stage'|'compact'|'handoff'}[], boundaries:{at:number}[]}}
     */
    function ringSegments(ratio, compactRatio, handoffRatio, hintRatio = null) {
      const r = clampRatio(ratio);
      const c = clampRatio(compactRatio);
      const h = clampRatio(handoffRatio);
      const hint = hintRatio === null || hintRatio === undefined ? null : clampRatio(hintRatio);

      // 断点1：模型判断的位置优先；否则到压缩线时用阈值位置。
      // 模型判断记录可能比当前进度靠后（压缩后比例回落），那种情况按阈值逻辑处理。
      let break1 = null;
      if (hint !== null && hint <= r + 1e-9) break1 = Math.min(hint, c); // 阈值先到就用压缩线
      else if (r >= c) break1 = c;

      const segments = [];
      if (break1 === null || break1 <= 0) {
        // 还没出现压缩判断：只有正常区，未走满 = 灰。
        if (r > 0) segments.push({ from: 0, to: r, color: 'idle' });
      } else {
        // 正常区：走满 → 蓝。
        segments.push({ from: 0, to: break1, color: 'stage' });
        // 压缩区：断点1 → 交接线（没走到交接线就截到当前进度），琥珀。
        const compactEnd = Math.min(r, h);
        if (compactEnd > break1) segments.push({ from: break1, to: compactEnd, color: 'compact' });
        // 交接区：交接线 → 当前进度，红。
        if (r > h) segments.push({ from: h, to: r, color: 'handoff' });
      }

      // 断点：交界两侧都得有弧才显示（r 越过线）。
      const boundaries = [];
      if (break1 !== null && r > break1 + 1e-9) boundaries.push({ at: break1 });
      if (break1 !== null && break1 < h && r > h + 1e-9) boundaries.push({ at: h });

      return { ratio: r, break1, segments, boundaries };
    }

    /**
     * 某段在渲染时实际要画的起止（两端各让出半个缺口；首段 0 处和末段当前进度处不留缺口）。
     * @param {{from:number,to:number}} segment
     * @param {number} gapRatio 半个缺口的比例宽度（gapPx / 环周长）
     * @param {number} ratio 当前总比例（判断是不是末段）
     * @returns {{from:number, to:number}}
     */
    function trimSegment(segment, gapRatio, ratio) {
      const first = segment.from <= 0;
      const last = Math.abs(segment.to - ratio) < 1e-9;
      const from = first ? segment.from : segment.from + gapRatio;
      const to = last ? segment.to : segment.to - gapRatio;
      return { from, to };
    }

    /** 主题变化时重新检测 body 明暗（DSH 切主题时 body 背景会变）。 */
    function useAutoTheme() {
      const [theme, setTheme] = useState(() => detectTheme());
      useEffect(() => {
        let raf = 0;
        const schedule = () => {
          if (raf !== 0) return;
          const run = () => {
            raf = 0;
            const next = detectTheme();
            setTheme((prev) =>
              prev.dark === next.dark && prev.panelBg === next.panelBg && prev.panelFg === next.panelFg ? prev : next,
            );
          };
          raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
        };
        const observer = new MutationObserver(schedule);
        for (const target of [document.documentElement, document.body]) {
          if (target) {
            observer.observe(target, {
              attributes: true,
              attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-ds-theme-source', 'data-ds-dark-theme'],
            });
          }
        }
        let media = null;
        try {
          media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        } catch {
          media = null;
        }
        const onMedia = () => schedule();
        if (media !== null) {
          if (typeof media.addEventListener === 'function') media.addEventListener('change', onMedia);
          else if (typeof media.addListener === 'function') media.addListener(onMedia);
        }
        return () => {
          observer.disconnect();
          if (raf !== 0) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
            else clearTimeout(raf);
          }
          if (media !== null) {
            if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onMedia);
            else if (typeof media.removeListener === 'function') media.removeListener(onMedia);
          }
        };
      }, []);
      return theme;
    }

    /**
     * 跨片段共享的浮层 / 指示灯环小部件（30-indicator 与 50-settings 共用）。
     *
     * 为什么单独一个片段：这些几何/材质在「指示灯」和「设置页教学卡片」里各画过一遍，
     * 以前是两份点坐标/弧线 path/原生线刻度/闪烁 keyframes。放在 15 号片段（按文件名
     * 排序在 10-runtime 之后、20-format/30-indicator/50-settings 之前），函数声明会
     * 提升，后面的片段可直接调用；常量在使用点（组件渲染时）早已初始化。
     */

    /**
     * 环上比例 → SVG 坐标（viewBox 0 0 20 20，圆心 10,10，半径用 10-runtime 的 RADIUS）。
     * @param {number} value 0–1 的比例
     * @returns {[number, number]}
     */
    function ringPoint(value) {
      const angle = value * Math.PI * 2 - Math.PI / 2;
      return [10 + RADIUS * Math.cos(angle), 10 + RADIUS * Math.sin(angle)];
    }

    /**
     * 环上两比例之间的弧线 path（0.5 以上用大弧标志）。
     * @param {number} from
     * @param {number} to
     * @returns {string}
     */
    function ringArcPath(from, to) {
      const [x1, y1] = ringPoint(from);
      const [x2, y2] = ringPoint(to);
      const large = to - from > 0.5 ? 1 : 0;
      return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
    }

    /**
     * DSH 原生自动压缩线的「径向刻度」：穿过环带的一条短线（内 5.6 → 外 9.6）。
     * 指示灯与设置页教学图用同一套几何，只是描边/属性不同。
     * @param {number} value 合法的原生阈值比例（0.02–1 之间，调用方先校验）
     * @returns {{x1:number, y1:number, x2:number, y2:number}}
     */
    function nativeTickAt(value) {
      const angle = value * Math.PI * 2 - Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return { x1: 10 + 5.6 * cos, y1: 10 + 5.6 * sin, x2: 10 + 9.6 * cos, y2: 10 + 9.6 * sin };
    }

    /** 越过原生自动压缩线后「整环红色闪烁」的 keyframes（指示灯/教学图共用一份）。 */
    const NATIVE_ALERT_CSS = '@keyframes cr-native-alert { 0%,100% { opacity: 1 } 50% { opacity: 0.15 } } @media (prefers-reduced-motion: reduce) { [data-cr-native-alert] { animation: none !important; opacity: 0.85 !important; } }';

    /**
     * 浮层外观（菜单 / 悬停卡 / 确认卡 / 交接单面板 / 历史面板 / toast 共用）。
     * 主题色由 10-runtime 的 detectTheme() 给出（BUG-001：优先 DSH 主题 token）。
     * @param {object} theme detectTheme() 的返回值
     * @returns {{background:string, backdropFilter:string, WebkitBackdropFilter:string, border:string, boxShadow:string}}
     */
    function panelChrome(theme) {
      return {
        background: theme.panelBg,
        backdropFilter: theme.panelBackdrop,
        WebkitBackdropFilter: theme.panelBackdrop,
        border: `1px solid ${theme.panelBorder}`,
        boxShadow: theme.panelShadow,
      };
    }

    const fmt = (n) => {
      if (n == null) return '—';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return String(n);
    };

    /** 交接单列表用的本地时间：2026-10-19 20:31。 */
    const fmtTime = (ms) => {
      if (!Number.isFinite(ms)) return '未知时间';
      const d = new Date(ms);
      return (
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` +
        ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      );
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * 交接预览用的轻量 markdown：`## 标题` 渲染成加粗行（去掉 # 前缀），
     * 其余行原样保留。不引第三方渲染器，只求「预览读起来不像源码」。
     * @param {string} text
     * @returns {object[]} React 子节点数组
     */
    const previewLines = (text) =>
      String(text ?? '')
        .split('\n')
        .map((line, index) => {
          const heading = /^#{1,6}\s+(.*)$/.exec(line);
          if (heading !== null) {
            return h('div', { key: `h${index}`, style: { fontWeight: 600, marginTop: index === 0 ? 0 : 8 } }, heading[1]);
          }
          return h('div', { key: `l${index}`, style: { minHeight: '1em' } }, line);
        });

    /** 新会话 id 的形态（宿主文案里用反引号包着 session-<uuid>）。 */
    const CHILD_ID_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    /**
     * 从命令结果文本里提取新会话 id。
     * @param {string} text
     * @returns {string|null}
     */
    function extractChildId(text) {
      if (typeof text !== 'string') return null;
      const match = CHILD_ID_RE.exec(text);
      return match === null ? null : match[0];
    }

    /** 每个子会话只自动打开一次（历史回放不反复跳转）。 */
    const OPENED_PREFIX = 'dsh.compact-relay.opened.v1';
    function openedKey(childId) {
      return `${OPENED_PREFIX}:${childId}`;
    }
    /** 读「打开过」状态：'1'=已成功打开，'opening'=上次正在打开（刷新后不能当成功）。 */
    function openedValueOf(childId) {
      try {
        return window.localStorage.getItem(openedKey(childId));
      } catch {
        return null;
      }
    }
    function wasOpened(childId) {
      return openedValueOf(childId) === '1';
    }
    function markOpened(childId, value) {
      try {
        window.localStorage.setItem(openedKey(childId), value);
      } catch {
        /* 隐私模式下可写不了，忽略 */
      }
    }
    function clearOpened(childId) {
      try {
        window.localStorage.removeItem(openedKey(childId));
      } catch {
        /* ignore */
      }
    }

    /**
     * 指示灯本体：外环=占用与压缩建议，内圆=交接建议；点击弹菜单。
     *
     * 数据源（M5，实际实现）：宿主订阅 `session/event` 后经自家 SSE 端点
     * `/api/compact-relay-stream` 推送（见 lib/dsh/state-hub.js）；浏览器用
     * EventSource 订阅，连不上或会话未就绪时退回轮询 `/api/compact-relay-state`。
     * 注意：第三方 slot 拿不到官方 `useProjection`（实测），所以不直连官方投影。
     */
    function CompactRelayIndicator(props) {
      const { sessionId, waitAndOpen } = props;
      const hasSession = typeof sessionId === 'string' && sessionId.length > 0;
      const [state, setState] = useState({ advice: 'none', pressure: null, window: null, summaries: 0, colors: null, compactRange: undefined, busy: false, pins: { count: 0, seqs: [], marks: [] }, compressHint: null, native: null });
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [hover, setHover] = useState(false);
      // 0.3.1：首次使用引导（只出现一次）+ 指示灯脉冲，解决「根本不知道那有个按钮」。
      const [onboarding, setOnboarding] = useState(false);
      const [pulseOn, setPulseOn] = useState(false);
      const [onboardingPulseMs, setOnboardingPulseMs] = useState(4800);
      // 悬停卡/菜单/提示的锚点（fixed 定位，躲开 composer 的 overflow 裁剪）。
      const [anchor, setAnchor] = useState(null);
      const theme = useAutoTheme();
      const [toast, setToast] = useState(null);
      // M6：压缩确认卡（先预览、再确认）与执行中取消。
      const [preview, setPreview] = useState(null);
      const previewRef = useRef(null);
      const previewAbortRef = useRef(null);
      const runAbortRef = useRef(null);
      // M6：交接单列表（菜单入口，只读）。
      const [docs, setDocs] = useState(null);
      const docsRef = useRef(null);
      const rootRef = useRef(null);
      const toastRef = useRef(null);
      // P2-A2：焦点管理（打开弹出层先进第一个可操作项，Esc/点外关闭后回到指示灯）。
      const triggerRef = useRef(null);
      const menuRef = useRef(null);
      // P2-C3/C4：交接单详情的请求序号与 AbortController（防乱序/防关闭后被撑开）。
      const docsRequestRef = useRef(0);
      const docsAbortRef = useRef(null);
      // A6：压缩历史面板（菜单入口，只读）。
      const [diff, setDiff] = useState(null);
      const diffRef = useRef(null);
      const diffAbortRef = useRef(null);
      const diffRequestRef = useRef(0);
      const closeDocs = useCallback(() => {
        docsRequestRef.current += 1;
        if (docsAbortRef.current !== null) {
          try {
            docsAbortRef.current.abort();
          } catch {
            /* ignore */
          }
          docsAbortRef.current = null;
        }
        setDocs(null);
      }, []);

      const closeDiff = useCallback(() => {
        diffRequestRef.current += 1;
        if (diffAbortRef.current !== null) {
          try {
            diffAbortRef.current.abort();
          } catch {
            /* ignore */
          }
          diffAbortRef.current = null;
        }
        setDiff(null);
      }, []);
      // A1b：交接预览（九段草稿 + 就绪清单），只读不落盘。
      const [handoffPreview, setHandoffPreview] = useState(null);
      const handoffPreviewRef = useRef(null);
      const handoffPreviewAbortRef = useRef(null);
      const closeHandoffPreview = useCallback(() => {
        if (handoffPreviewAbortRef.current !== null) {
          try {
            handoffPreviewAbortRef.current.abort();
          } catch {
            /* ignore */
          }
          handoffPreviewAbortRef.current = null;
        }
        setHandoffPreview(null);
      }, []);
	
      const rememberAnchor = useCallback((el) => {
        if (el === null || el === undefined) return;
        const rect = el.getBoundingClientRect();
        setAnchor({
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
        });
      }, []);
      // 滚动/缩放时锚点会漂，重算一次。
      useEffect(() => {
        if (!hover && !open && toast === null) return undefined;
        const update = () => {
          const el = rootRef.current;
          if (el !== null && el !== undefined) rememberAnchor(el.firstElementChild ?? el);
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
          window.removeEventListener('scroll', update, true);
          window.removeEventListener('resize', update);
        };
      }, [hover, open, toast, rememberAnchor]);

      // toast 宽度是 max-content，渲染前估不准：渲染后量一次，超出视口就把 left 收回来。
      useEffect(() => {
        if (toast === null) return;
        const el = toastRef.current;
        if (el === null) return;
        const margin = 8;
        const rect = el.getBoundingClientRect();
        let left = rect.left;
        if (rect.right > window.innerWidth - margin) left = window.innerWidth - margin - rect.width;
        if (left < margin) left = margin;
        if (left !== rect.left) el.style.left = `${Math.round(left)}px`;
      }, [toast, anchor]);

      const url =
        typeof sessionId === 'string' && sessionId.length > 0
          ? `/api/compact-relay-state?sessionId=${encodeURIComponent(sessionId)}`
          : '/api/compact-relay-state';

      const applierRef = useRef(() => {});
      const fetchState = useCallback(async () => {
        if (!hasSession) return;
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (data && typeof data === 'object') applierRef.current(data);
          } catch {
            /* host 不在就保持上一次状态 */
          }
      }, [url, hasSession]);

      // 状态应用函数（轮询与 SSE 共用同一份映射）。
      const readyRef = useRef(false);
      // P3-12：轮询响应与 SSE 帧都可能晚到；host 每帧带单调 revision，只接受更新的帧。
      // 旧 host（没有 revision）保持原行为，不因为拿不到号就丢帧。
      const lastRevisionRef = useRef(-1);
      const applyState = useCallback((data) => {
        if (data === null || typeof data !== 'object') return;
        if (data.ok === false) return;
        const revision = Number.isInteger(data.revision) ? data.revision : null;
        if (revision !== null) {
          if (revision <= lastRevisionRef.current) return;
          lastRevisionRef.current = revision;
        }
        readyRef.current = typeof data.sessionId === 'string' && data.sessionId.length > 0;
        setState({
          sessionId: typeof data.sessionId === 'string' && data.sessionId.length > 0 ? data.sessionId : null,
          level: typeof data.level === 'string' && data.level.length > 0 ? data.level : null,
          advice: data.advice || 'none',
          pressure: data.pressure ?? null,
          window: data.window ?? 1_000_000,
          summaries: data.summaries ?? 0,
          busy: data.busy === true,
          thresholds: data.thresholds && typeof data.thresholds === 'object' ? data.thresholds : null,
          pins:
            data.pins && typeof data.pins === 'object'
              ? {
                  count: Number(data.pins.count) || 0,
                  seqs: Array.isArray(data.pins.seqs) ? data.pins.seqs.filter((seq) => Number.isInteger(seq)) : [],
                  // 0.3.1：锁定消息在历史里的相对位置（0–1）——环上按位置画块。
                  marks: Array.isArray(data.pins.marks)
                    ? data.pins.marks
                        .filter((item) => item !== null && typeof item === 'object' && typeof item.ratio === 'number' && Number.isFinite(item.ratio))
                        .map((item) => ({ seq: Number.isInteger(item.seq) ? item.seq : -1, ratio: Math.max(0, Math.min(1, item.ratio)) }))
                        .slice(0, 20)
                    : [],
                }
              : { count: 0, seqs: [], marks: [] },
          // 0.3.1：模型判断的「这里适合压缩」位置（0–1）；没有或已失效为 null。
          compressHint:
            data.compressHint && typeof data.compressHint === 'object' && typeof data.compressHint.ratio === 'number' && Number.isFinite(data.compressHint.ratio)
              ? { ratio: Math.max(0, Math.min(1, data.compressHint.ratio)), at: typeof data.compressHint.at === 'number' ? data.compressHint.at : 0 }
              : null,
          // 0.3.1：DSH 原生自动压缩配置（环上的报警最高阈值 / 引导文案 / 设置页）。
          native:
            data.native && typeof data.native === 'object'
              ? {
                  autoEnabled: data.native.autoEnabled !== false,
                  thresholdRatio:
                    typeof data.native.thresholdRatio === 'number' && Number.isFinite(data.native.thresholdRatio)
                      ? Math.max(0, Math.min(1, data.native.thresholdRatio))
                      : 0.8,
                }
              : null,
          colors: data.colors && typeof data.colors === 'object' ? data.colors : null,
          // undefined=宿主没给（未知，保留可点）；null=明确没有可压范围；object=可压多少。
          compactRange:
            data.compactRange === undefined
              ? undefined
              : data.compactRange === null
                ? null
                : {
                    nodes: Number(data.compactRange.nodes) || 0,
                    tokens: Number(data.compactRange.tokens) || 0,
                    startSeq: data.compactRange.startSeq ?? null,
                    endSeq: data.compactRange.endSeq ?? null,
                  },
        });
      }, []);

      applierRef.current = applyState;

      // M5 实时推送：EventSource 订阅 `/api/compact-relay-stream`。
      // 后端在每条会话事件后去抖推一次状态；连不上就自动退回轮询。
      const [streamLive, setStreamLive] = useState(false);
      const streamLiveRef = useRef(false);
      useEffect(() => {
        if (!hasSession || typeof EventSource !== 'function') return;
        const streamUrl = url.replace('/api/compact-relay-state', '/api/compact-relay-stream');
        let source;
        try {
          source = new EventSource(streamUrl);
        } catch {
          return;
        }
        let dead = false;
        source.onopen = () => {
          if (dead) return;
          streamLiveRef.current = true;
          setStreamLive(true);
        };
        source.onmessage = (event) => {
          try {
            applyState(JSON.parse(event.data));
          } catch {
            /* 坏帧忽略，下一帧再来 */
          }
        };
        source.onerror = () => {
          if (dead) return;
          streamLiveRef.current = false;
          setStreamLive(false);
          try {
            source.close();
          } catch {
            /* ignore */
          }
        };
        return () => {
          dead = true;
          streamLiveRef.current = false;
          setStreamLive(false);
          try {
            source.close();
          } catch {
            /* ignore */
          }
        };
      }, [url, applyState, hasSession]);

      // 兜底轮询：
      //  - 还没就绪（会话刚打开 / 没有 agent）→ 1.5s 快轮询（修「重启后停在上下文未知」）；
      //  - 已就绪但 SSE 没连上 → 5s 轮询兜底；
      //  - 已就绪且 SSE 活着 → 不主动发请求，只留 5s 计时器。
      useEffect(() => {
        if (!hasSession) return;
        let timer;
        let dead = false;
        const tick = () => {
          if (dead) return;
          if (!readyRef.current || !streamLiveRef.current) void fetchState();
          timer = setTimeout(tick, readyRef.current ? 5000 : 1500);
        };
        tick();
        return () => {
          dead = true;
          clearTimeout(timer);
        };
      }, [fetchState, hasSession]);


      // 点外面 / Esc 关闭菜单、压缩确认卡与交接单面板。
      useEffect(() => {
        if (!open && preview === null && docs === null && diff === null && handoffPreview === null) return;
        const inside = (target) => {
          const inRoot = rootRef.current !== null && rootRef.current.contains(target);
          const inPreview = previewRef.current !== null && previewRef.current.contains(target);
          const inDocs = docsRef.current !== null && docsRef.current.contains(target);
          const inDiff = diffRef.current !== null && diffRef.current.contains(target);
          const inHandoff = handoffPreviewRef.current !== null && handoffPreviewRef.current.contains(target);
          return inRoot || inPreview || inDocs || inDiff || inHandoff;
        };
        const onDown = (e) => {
          if (inside(e.target)) return;
          setOpen(false);
          setPreview(null);
          closeDocs();
          closeDiff();
          closeHandoffPreview();
          window.setTimeout(() => triggerRef.current?.focus?.(), 0);
        };
        const onKey = (e) => {
          if (e.key !== 'Escape') return;
          setOpen(false);
          setPreview(null);
          closeDocs();
          closeDiff();
          closeHandoffPreview();
          window.setTimeout(() => triggerRef.current?.focus?.(), 0);
          if (previewAbortRef.current !== null) {
            try {
              previewAbortRef.current.abort();
            } catch {
              /* ignore */
            }
            previewAbortRef.current = null;
          }
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open, preview, docs, diff, handoffPreview, closeDocs, closeDiff, closeHandoffPreview]);

      // P2-A2：弹出层打开后把焦点送进第一个可操作按钮（键盘用户不用再 Tab 找）。
      useEffect(() => {
        const target = open
          ? menuRef.current
          : preview !== null
            ? previewRef.current
            : docs !== null
              ? docsRef.current
              : diff !== null
                ? diffRef.current
                : handoffPreview !== null
                  ? handoffPreviewRef.current
                  : null;
        if (target === null) return;
        const first = typeof target.querySelector === 'function' ? target.querySelector('button:not(:disabled)') : null;
        if (first !== null && typeof first.focus === 'function') first.focus();
      }, [open, preview, docs, diff, handoffPreview]);

      const adviseCompact = state.advice === 'compact';
      const adviseHandoff = state.advice === 'handoff';
      const pressureValue = state.pressure;
      const windowValue = state.window;
      const ratio = pressureValue && windowValue ? Math.min(1, pressureValue / windowValue) : 0;

      // M6：锁定集合（宿主下发的 count/seqs；默认空）。
      const pins = state.pins !== null && typeof state.pins === 'object' ? state.pins : { count: 0, seqs: [] };
      // 0.3.1：阶段标记功能已删（作者拍板），ring level 只看建议。
      const level = typeof state.level === 'string' ? state.level : adviseHandoff ? 'handoff' : adviseCompact ? 'compact' : 'idle';

      // 颜色：host 下发 3 个基准色 + 自动适配开关；这里按当前界面明暗派生两套，
      // 保证同一套基准色在浅色/深色界面都看得清（设置里也可强制模式）。
      const palette = resolvePalette(state.colors, theme.dark);

      // 0.3.1：环不再整体变色，而是按「容量区间」分段上色 + 断点（规则见 core/ring.js）。
      // 正常区 0→压缩线：没走满灰、走满蓝；压缩区→琥珀；交接区→红；断点=区间交界的小缺口。
      const compactAt = state.thresholds !== null && typeof state.thresholds === 'object' ? state.thresholds.compactAt : null;
      const compactRatio =
        state.thresholds !== null && typeof state.thresholds === 'object' && typeof state.thresholds.compactRatio === 'number'
          ? state.thresholds.compactRatio
          : typeof compactAt === 'number' && typeof windowValue === 'number' && windowValue > 0
            ? compactAt / windowValue
            : 0.4;
      const handoffRatio =
        state.thresholds !== null && typeof state.thresholds === 'object' && typeof state.thresholds.handoffRatio === 'number'
          ? state.thresholds.handoffRatio
          : 0.6;
      // 0.3.1：模型判断的「这里适合压缩」位置 → 断点1（优先于阈值）；失效的 hint 由 host 过滤。
      const hintRatio = state.compressHint && typeof state.compressHint.ratio === 'number' ? state.compressHint.ratio : null;
      const ring = ringSegments(ratio, compactRatio, handoffRatio, hintRatio);
      // DSH 原生自动压缩线（报警最高阈值）：开着时在环上画一个「径向刻度」（不是沿环的弧），
      // 用紫色 + 主题底色描边——刻意不用五级配色里的颜色，保证在任何分段颜色上都看得清。
      // 越过原生线后：整环红色闪烁（作者 2026-10-20 反馈）。
      const nativeAuto = state.native !== null && state.native.autoEnabled ? state.native.thresholdRatio : null;
      const nativeValid = nativeAuto !== null && nativeAuto > 0.02 && nativeAuto < 1;
      const nativeCrossed = nativeValid && ratio > nativeAuto;
      // 断点缺口：0.9 SVG 单位（≈6.4°），折算成比例；段太短时缺口会吃掉整段，就跳过该段。
      const ringGapRatio = 0.9 / CIRC;
      // 点坐标/弧线 path 是共享几何（15-shared.js 的 ringPoint / ringArcPath）。
      const ringNodes = ring.segments
        .map((segment, index) => {
          const trimmed = trimSegment(segment, ringGapRatio, ring.ratio);
          if (trimmed.to - trimmed.from <= 0.001) return null;
          return h('path', {
            key: `ring-${index}`,
            d: ringArcPath(trimmed.from, trimmed.to),
            fill: 'none',
            stroke: palette[segment.color],
            strokeWidth: 2,
            strokeLinecap: 'round',
            'data-cr-seg': segment.color,
            style: { transition: 'stroke 200ms ease' },
          });
        })
        .filter((node) => node !== null);
      // DSH 原生自动压缩线：径向紫色刻度 + 越过线后整环红色闪烁。
      // 刻度用一条「穿过环带」的短线（内 5.6 → 外 9.6）+ 一圈主题底色描边，避免和红色分段糊在一起。
      const nativeNodes = [];
      if (nativeValid) {
        const tick = nativeTickAt(nativeAuto);
        // 越过原生压缩线：整环红色闪烁（1s 呼吸）；prefers-reduced-motion 下改为常亮红色（不闪）。
        if (nativeCrossed) {
          nativeNodes.push(
            h('style', { key: 'native-alert-style' }, NATIVE_ALERT_CSS),
            h('circle', {
              key: 'native-alert',
              cx: 10,
              cy: 10,
              r: RADIUS,
              fill: 'none',
              stroke: palette.handoff,
              strokeWidth: 2.6,
              strokeLinecap: 'round',
              style: { animation: 'cr-native-alert 1s ease-in-out infinite' },
              'data-cr-native-alert': '1',
            }),
          );
        }
        nativeNodes.push(
          h('line', {
            key: 'native-tick-casing',
            ...tick,
            stroke: theme.dark ? '#26262c' : '#ffffff',
            strokeWidth: 4.2,
            strokeLinecap: 'round',
            opacity: 0.92,
          }),
          h('line', {
            key: 'native-tick',
            ...tick,
            stroke: NATIVE_LINE_COLOR,
            strokeWidth: 2.2,
            strokeLinecap: 'round',
            'data-cr-native-line': String(nativeAuto),
          }),
        );
      }
      // 平时给中心一点可见的灰点；交接时红点（外环已分段，红点强调该交接）。
      const dotColor = adviseHandoff ? palette.handoff : palette.idle;
      // 锁定消息在环上的块（方案 A：按消息在历史里的相对位置）。这是「保护内容」的信号，
      // 权重最高：用最显眼的反差色、比外环略粗；多个锁定全部显示。
      const pinMarks = state.pins && Array.isArray(state.pins.marks) ? state.pins.marks : [];
      const pinBlocks = pinMarks.map((mark, index) =>
        h('circle', {
          key: `pin-${mark.seq ?? index}-${index}`,
          cx: 10,
          cy: 10,
          r: RADIUS,
          fill: 'none',
          stroke: palette.pin,
          strokeWidth: 2.9,
          strokeLinecap: 'round',
          strokeDasharray: `2.8 ${CIRC}`,
          transform: `rotate(${-90 + mark.ratio * 360} 10 10)`,
          'data-cr-pin-mark': String(index),
        }),
      );

      // 忙碌 = 本组件正在跑动作，或宿主侧锁已占用（另一个窗口在压/接）。
      const hostBusy = state.busy === true;
      const effectiveBusy = busy || hostBusy;

      // P2-C2：toast 只保留一个 timer；新提示先清旧 timer，按类型决定停留时长。
      const toastTimerRef = useRef(null);
      const toastSeqRef = useRef(0);
      const showToast = useCallback((value, ms = 6000) => {
        if (toastTimerRef.current !== null) {
          clearTimeout(toastTimerRef.current);
          toastTimerRef.current = null;
        }
        const seq = ++toastSeqRef.current;
        setToast(value);
        if (ms > 0) {
          toastTimerRef.current = setTimeout(() => {
            if (toastSeqRef.current === seq) {
              toastTimerRef.current = null;
              setToast(null);
            }
          }, ms);
        }
      }, []);
      useEffect(
        () => () => {
          if (toastTimerRef.current !== null) {
            clearTimeout(toastTimerRef.current);
            toastTimerRef.current = null;
          }
        },
        [],
      );

      // 0.3.1：首次使用引导——只在第一次打开会话时出现一次（localStorage 记住），
      // 配合指示灯呼吸光晕，解决「指示灯太安静、新用户不知道这里有个菜单」。
      // 设置页「再看一次初次引导」按钮通过 window 事件重播（两个组件同页，用事件解耦）。
      const onboardingText = useCallback(() => {
        const nativeRatio = state.native !== null && state.native.autoEnabled !== false ? state.native.thresholdRatio : null;
        const nativePart =
          nativeRatio === null
            ? 'DSH 原生自动压缩已关闭'
            : `DSH 原生自动压缩线在 ${(nativeRatio * 100).toFixed(0)}%，到那之前先压缩或交接更稳`;
        return `这是上下文指示灯：点它压缩旧会话、锁定重要消息、交接新会话。${nativePart}。环上的小缺口是我判断「该压缩」的位置（模型判断或到线自动出现）。重要的结论/路径先锁定，压缩时才不会被压掉。`;
      }, [state.native]);

      /** 播放一次引导：呼吸光晕 + 提示。手动重播用更长时间（用户要关掉设置页才看得到）。 */
      const playOnboarding = useCallback(
        (options = {}) => {
          const pulseMs = typeof options.pulseMs === 'number' && options.pulseMs > 0 ? options.pulseMs : 4800;
          const toastMs = typeof options.toastMs === 'number' && options.toastMs > 0 ? options.toastMs : 15000;
          setPulseOn(false);
          setOnboarding(false);
          setOnboardingPulseMs(pulseMs);
          // 先复位再拉起：重复点击也能从头开始呼吸光晕。
          window.setTimeout(() => {
            setOnboarding(true);
            showToast(onboardingText(), toastMs);
          }, 30);
        },
        [onboardingText, showToast],
      );

      // 首次自动播放（localStorage 记住，只弹一次）。
      useEffect(() => {
        if (!hasSession) return undefined;
        let seen = true;
        try {
          seen = window.localStorage.getItem('compact-relay:onboarded') === '1';
        } catch {
          seen = true; // 隐私模式读不到 localStorage 就当看过，别每次弹
        }
        if (seen) return undefined;
        const timer = setTimeout(() => {
          try {
            window.localStorage.setItem('compact-relay:onboarded', '1');
          } catch {
            /* ignore */
          }
          playOnboarding();
        }, 1200);
        return () => clearTimeout(timer);
      }, [hasSession, playOnboarding]);

      // 设置页「再看一次初次引导」→ 重播（手动触发给更长时间：光晕 9s、提示 20s）。
      useEffect(() => {
        const onReplay = (event) => {
          const detail = event !== null && typeof event === 'object' && event.detail !== null && typeof event.detail === 'object' ? event.detail : {};
          playOnboarding({ pulseMs: 9000, toastMs: 20000, ...detail });
        };
        window.addEventListener('compact-relay:replay-onboarding', onReplay);
        return () => window.removeEventListener('compact-relay:replay-onboarding', onReplay);
      }, [playOnboarding]);

      // 引导光晕：默认 4 次呼吸后自动停（手动重播时按传入时长）。
      useEffect(() => {
        if (!onboarding) return undefined;
        const blink = setInterval(() => setPulseOn((value) => !value), 600);
        const stop = setTimeout(() => {
          clearInterval(blink);
          setPulseOn(false);
        }, onboardingPulseMs);
        return () => {
          clearInterval(blink);
          clearTimeout(stop);
          setPulseOn(false);
        };
      }, [onboarding, onboardingPulseMs]);

      // M6：执行中取消——先 abort 本地请求，再让 host 中止事务（历史不变）。
      const cancelRun = useCallback(() => {
        const controller = runAbortRef.current;
        if (controller !== null) {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }
        showToast({ text: '正在取消…（已提交的部分不会回滚）' }, 0);
        void fetch('/api/compact-relay-action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}) }),
        }).catch(() => {});
      }, [sessionId]);

      // M6：预览——只算「能压哪段、多少 token」，不写历史。
      const startPreview = useCallback(async () => {
        if (effectiveBusy) return;
        setOpen(false);
        setHandoffPreview(null);
        setPreview({ loading: true });
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        previewAbortRef.current = controller;
        try {
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'preview', ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}) }),
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false || data.preview == null) {
            setPreview(null);
            showToast(data && data.message ? String(data.message) : '压缩预估失败：现在没有能压缩的内容');
            return;
          }
          setPreview({ data });
        } catch (error) {
          setPreview(null);
          if (error && error.name === 'AbortError') return;
          showToast('压缩预估失败：' + (error && error.message ? error.message : '未知错误'), 8000);
        } finally {
          previewAbortRef.current = null;
        }
      }, [effectiveBusy, sessionId, showToast]);

      // A1b：交接预览——生成九段草稿 + 就绪清单，不写盘、不建会话、不改历史。
      const startHandoffPreview = useCallback(async () => {
        if (effectiveBusy) return;
        setOpen(false);
        setPreview(null);
        closeDocs();
        closeDiff();
        setHandoffPreview({ loading: true });
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        handoffPreviewAbortRef.current = controller;
        try {
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'handoff-preview', ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}) }),
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            setHandoffPreview(null);
            showToast(data && data.message ? String(data.message) : '交接预览失败：没有拿到草稿', 6000);
            return;
          }
          setHandoffPreview({ data });
        } catch (error) {
          setHandoffPreview(null);
          if (error && error.name === 'AbortError') return;
          showToast('交接预览失败：' + (error && error.message ? error.message : '未知错误'), 8000);
        } finally {
          handoffPreviewAbortRef.current = null;
        }
      }, [effectiveBusy, sessionId, showToast, closeDocs, closeDiff]);

      // M6：交接单列表（菜单入口）——只读接口，点开可看全文/复制路径。
      // P2-C3/C4：请求带序号 + AbortController；只接受「仍然是当前选中文件」的响应。
      const loadDocs = useCallback(async () => {
        setOpen(false);
        setPreview(null);
        closeDiff();
        if (docsAbortRef.current !== null) {
          try {
            docsAbortRef.current.abort();
          } catch {
            /* ignore */
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        docsAbortRef.current = controller;
        const reqId = ++docsRequestRef.current;
        setDocs({ loading: true });
        try {
          const res = await fetch('/api/compact-relay-handoffs?limit=20', {
            cache: 'no-store',
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (reqId !== docsRequestRef.current) return;
          if (!res.ok || data.ok === false) {
            setDocs({ error: data && data.message ? String(data.message) : '读取交接单失败' });
            return;
          }
          setDocs({ items: Array.isArray(data.items) ? data.items : [], selected: null });
        } catch (error) {
          if (reqId !== docsRequestRef.current || (error && error.name === 'AbortError')) return;
          setDocs({ error: '读取交接单失败：' + (error && error.message ? error.message : '未知错误') });
        }
      }, [closeDiff]);

      // A6：压缩历史（菜单入口）——只读，压了哪些条 / 摘要预览 / 省了多少容量。
      const loadDiff = useCallback(async () => {
        setOpen(false);
        setPreview(null);
        closeDocs();
        if (diffAbortRef.current !== null) {
          try {
            diffAbortRef.current.abort();
          } catch {
            /* ignore */
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        diffAbortRef.current = controller;
        const reqId = ++diffRequestRef.current;
        setDiff({ loading: true });
        try {
          const query = new URLSearchParams({ limit: '10' });
          if (typeof sessionId === 'string' && sessionId.length > 0) query.set('sessionId', sessionId);
          const res = await fetch(`/api/compact-relay-diff?${query.toString()}`, {
            cache: 'no-store',
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (reqId !== diffRequestRef.current) return;
          if (!res.ok || data.ok === false) {
            setDiff({ error: data && data.message ? String(data.message) : '读取压缩历史失败' });
            return;
          }
          const items = Array.isArray(data.items) ? data.items : [];
          if (items.length === 0) {
            setDiff(null);
            showToast('还没有压缩记录；执行一次「压缩旧会话」后就能在这里回看。', 5000);
            return;
          }
          setDiff({ items });
        } catch (error) {
          if (reqId !== diffRequestRef.current || (error && error.name === 'AbortError')) return;
          setDiff({ error: '读取压缩历史失败：' + (error && error.message ? error.message : '未知错误') });
        }
      }, [closeDocs, sessionId, showToast]);

      const openDoc = useCallback(async (name) => {
        if (docsAbortRef.current !== null) {
          try {
            docsAbortRef.current.abort();
          } catch {
            /* ignore */
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        docsAbortRef.current = controller;
        const reqId = ++docsRequestRef.current;
        setDocs((prev) => (prev === null ? null : { ...prev, selected: name, contentLoading: true, content: null, contentError: null }));
        try {
          const res = await fetch(`/api/compact-relay-handoffs?file=${encodeURIComponent(name)}`, {
            cache: 'no-store',
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (reqId !== docsRequestRef.current) return;
          if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '读取失败');
          setDocs((prev) =>
            prev === null || prev.selected !== name
              ? prev
              : {
                  ...prev,
                  contentLoading: false,
                  content: typeof data.content === 'string' ? data.content : '',
                  docPath: typeof data.path === 'string' ? data.path : null,
                },
          );
        } catch (error) {
          if (reqId !== docsRequestRef.current || (error && error.name === 'AbortError')) return;
          setDocs((prev) =>
            prev === null || prev.selected !== name
              ? prev
              : { ...prev, contentLoading: false, contentError: '读取失败：' + (error && error.message ? error.message : '未知错误') },
          );
        }
      }, []);

      const copyDocPath = useCallback(() => {
        const items = docs !== null && Array.isArray(docs.items) ? docs.items : [];
        const selected = docs !== null && typeof docs.selected === 'string' ? docs.selected : null;
        const item = selected === null ? undefined : items.find((candidate) => candidate.name === selected);
        const target = (docs !== null && typeof docs.docPath === 'string' && docs.docPath.length > 0 ? docs.docPath : undefined) ?? item?.path;
        if (typeof target !== 'string' || target.length === 0) return;
        try {
          const written = navigator.clipboard?.writeText(target);
          if (written !== undefined && typeof written.then === 'function') {
            written.then(
              () => showToast('已复制路径：' + target, 4000),
              () => showToast('复制失败：' + target, 5000),
            );
          } else {
            showToast('已复制路径：' + target, 4000);
          }
        } catch {
          showToast('复制失败：' + target, 5000);
        }
      }, [docs]);

      // M6：菜单一层入口——有锁定就清空，没有就锁最近一轮。
      const togglePins = useCallback(async () => {
        if (effectiveBusy) return;
        setOpen(false);
        setBusy(true);
        try {
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'pin-toggle', ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}) }),
          });
          const data = await res.json().catch(() => ({}));
          showToast(data && data.message ? String(data.message) : res.ok ? '已更新锁定状态' : '锁定操作失败', 6000);
        } catch (error) {
          showToast('锁定操作失败：' + (error && error.message ? error.message : '未知错误'), 8000);
        } finally {
          setBusy(false);
        }
      }, [effectiveBusy, sessionId]);

      const run = useCallback(
        async (action) => {
          // A3：确认必须带预览时拿到的 planId，宿主重算不一致会以 changed 拒绝。
          const expected =
            action === 'compact' && preview !== null && preview.loading !== true && typeof preview.data?.planId === 'string'
              ? { planId: preview.data.planId }
              : undefined;
          setBusy(true);
          setOpen(false);
          setPreview(null);
          setHandoffPreview(null);
          const controller = typeof AbortController === 'function' ? new AbortController() : null;
          runAbortRef.current = controller;
          // 立刻给反馈：不等结果回来，先告诉用户「在做了」；压缩/交接都可取消。
          const runningText =
            action === 'compact'
              ? '正在压缩旧会话…（通常需几秒，可随时取消）'
              : '正在交接…（先压缩旧会话、再生成交接单，约需十几秒）';
          showToast({ text: runningText, cancel: true }, 0);
          try {
            const res = await fetch('/api/compact-relay-action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action,
                ...(expected === undefined ? {} : { expected }),
                ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
              }),
              ...(controller === null ? {} : { signal: controller.signal }),
            });
            const data = await res.json().catch(() => ({}));
            if (data && data.code === 'changed') {
              // 范围变了：提示并自动重开确认卡，让用户看新范围再决定。
              showToast(data.message ? String(data.message) : '压缩范围已变，请重新预估。', 6000);
              void startPreview();
            } else if (action === 'handoff' && data && typeof data.childId === 'string') {
              showToast('交接单已生成，正在打开新会话…', 0);
              try {
                await waitAndOpen(data.childId);
                showToast('已切换到新会话；旧会话仍保留（交接前可能做过压缩，原文都在会话日志里）。', 6000);
              } catch (error) {
                showToast(`交接单已生成，但自动切换新会话失败：${error && error.message ? error.message : '未知原因'}（新会话 ${data.childId}）`, 8000);
              }
            } else if (data && data.cancelled === true) {
              showToast(data.message ? String(data.message) : '已取消，会话记录没有改动。', 6000);
            } else {
              showToast(data && data.message ? String(data.message) : action === 'compact' ? '已开始压缩' : '已开始交接', 6000);
            }
          } catch (error) {
            if (error && error.name === 'AbortError') showToast('已取消请求（若已提交，会话记录以历史为准）。', 5000);
            else showToast('操作失败：' + (error && error.message ? error.message : '未知错误'), 8000);
          } finally {
            setBusy(false);
            runAbortRef.current = null;
          }
        },
        [sessionId, waitAndOpen, preview, startPreview],
      );

      const adviceText = adviseHandoff ? '建议交接' : adviseCompact ? '建议压缩' : '正常';
      // 0.3.1：模型判断的断点位置（「这里适合压缩」）；DSH 原生自动压缩线（报警最高阈值）。
      const compressHintText =
        state.compressHint !== null && typeof state.compressHint.ratio === 'number'
          ? `压缩判断点 ${(state.compressHint.ratio * 100).toFixed(0)}%`
          : '';
      const nativeLineText =
        state.native !== null && state.native.autoEnabled !== false && typeof state.native.thresholdRatio === 'number'
          ? `原生自动压缩线 ${(state.native.thresholdRatio * 100).toFixed(0)}%${
              ratio > state.native.thresholdRatio ? '（已越过：整环红色闪烁）' : ''
            }`
          : 'DSH 原生自动压缩已关闭';
      const pressureKnown = pressureValue !== null;
      const title =
        (pressureKnown
          ? `会话容量已用 ${(ratio * 100).toFixed(1)}%（${fmt(pressureValue)} / ${fmt(windowValue)}）`
          : '正在读取会话容量（会话刚打开，请稍候）') +
        `，已压缩 ${state.summaries} 次｜${adviceText}` +
        (compressHintText !== '' ? `｜${compressHintText}` : '') +
        (nativeLineText !== '' ? `｜${nativeLineText}` : '') +
        (pins.count > 0 ? `｜已锁定 ${pins.count} 条` : '') +
        (effectiveBusy ? '｜处理中…' : '');

      // 浮层定位：fixed（不受 composer 裁剪）+ 视口左右收边 + 上方空间不够时翻到下方。
      const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
      const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
      const clampLeft = (estimatedWidth) =>
        anchor === null ? 8 : Math.max(8, Math.min(anchor.left, Math.max(8, vw - estimatedWidth - 8)));
      // 浮层定位：先按「估计高度」判断上方放不放得下，放不下就翻到下方并夹在视口内。
      // 只估宽度会让 340~520px 高的面板在矮视口里顶出屏幕（2026-10-20 预览卡实测）。
      const floatPos = (estimatedWidth, estimatedHeight = 340) => {
        if (anchor === null) return { left: 8, top: 12 };
        const margin = 8;
        const above = anchor.top >= estimatedHeight + margin * 2;
        const top = above
          ? anchor.top - margin
          : Math.max(margin, Math.min(anchor.bottom + margin, vh - estimatedHeight - margin));
        return {
          left: clampLeft(estimatedWidth),
          top,
          ...(above ? { transform: 'translateY(-100%)' } : {}),
        };
      };

      // 悬停数字（规格 §2）：自绘小卡，比原生 title 快、可控制格式。
      const tooltip =
        hover && !open && anchor !== null
          ? h(
              'div',
              {
                'data-cr-tooltip': '1',
                style: {
                  position: 'fixed',
                  ...floatPos(320, 140),
                  maxWidth: 'min(320px, calc(100vw - 16px))',
                  whiteSpace: 'normal',
                  wordBreak: 'break-word',
                  padding: '6px 9px',
                  borderRadius: 8,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  fontSize: 11,
                  lineHeight: '16px',
                  zIndex: 39,
                  pointerEvents: 'none',
                },
              },
              h(
                'div',
                null,
                pressureKnown
                  ? `会话容量已用 ${(ratio * 100).toFixed(1)}%（${fmt(pressureValue)} / ${fmt(windowValue)}）`
                  : '正在读取会话容量（会话刚打开，请稍候）',
              ),
              h(
                'div',
                { style: { color: theme.subText } },
                `已压缩 ${state.summaries} 次 · ${adviceText}${compressHintText !== '' ? ` · ${compressHintText}` : ''}${nativeLineText !== '' ? ` · ${nativeLineText}` : ''}${pins.count > 0 ? ` · 已锁定 ${pins.count} 条` : ''}${effectiveBusy ? ' · 处理中…' : ''}`,
              ),
            )
          : null;

      const svg = h(
        'svg',
        { viewBox: '0 0 20 20', width: 20, height: 20, 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 10, cy: 10, r: RADIUS, fill: 'none', stroke: COLORS.track, strokeWidth: 2, opacity: 0.18 }),
        // 0.3.1：分段弧（正常区灰/蓝 → 压缩区琥珀 → 交接区红），区间之间留缺口当断点。
        ...ringNodes,
        h('circle', {
          cx: 10,
          cy: 10,
          r: 3,
          fill: dotColor,
          'data-cr-dot': adviseHandoff ? 'handoff' : level,
          style: {
            transition: 'fill 200ms ease',
            filter: adviseHandoff ? `drop-shadow(0 0 3px ${palette.handoff})` : 'none',
          },
        }),
        // 0.3.1：DSH 原生自动压缩线（刻度/危险区）。
        ...nativeNodes,
        // 0.3.1：锁定消息在环上的块（品红，按历史位置）。
        ...pinBlocks,
      );

      const trigger = h(
        'button',
        {
          type: 'button',
          ref: triggerRef,
          onClick: (e) => {
            rememberAnchor(e.currentTarget);
            setPreview(null);
            closeDocs();
            setOpen((v) => !v);
          },
          disabled: effectiveBusy,
          'aria-label': title,
          onMouseEnter: (e) => {
            rememberAnchor(e.currentTarget);
            setHover(true);
          },
          onMouseLeave: () => setHover(false),
          onFocus: (e) => {
            rememberAnchor(e.currentTarget);
            setHover(true);
          },
          onBlur: () => setHover(false),
          'data-cr-level': level,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          // 供端到端测试取证：stream=SSE 实时推送，poll=降级轮询。
          'data-cr-source': streamLive ? 'stream' : 'poll',
          'data-cr-tokens': pressureValue == null ? '' : String(pressureValue),
          // 取证用：注入到组件的会话 id / 最近一次状态里的会话 id（排查「未知」时看这俩）。
          'data-cr-session': typeof sessionId === 'string' ? sessionId : '',
          'data-cr-state-session': typeof state.sessionId === 'string' ? state.sessionId : '',
          'data-cr-summaries': String(state.summaries),
          'data-cr-pins': String(pins.count),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            cursor: effectiveBusy ? 'wait' : 'pointer',
            color: 'inherit',
            opacity: effectiveBusy ? 0.5 : 1,
            position: 'relative',
            // 0.3.1：首次引导时做几次呼吸光晕，引导结束后恢复安静。
            boxShadow: pulseOn ? `0 0 0 5px ${palette.stage}33` : '0 0 0 0 transparent',
            transition: 'box-shadow 600ms ease',
          },
        },
        svg,
      );

      // B 方案（2026-10-20 设计评审拍板）：压缩/交接保留两行说明，其余 4 项压成单行，
      // 关键状态放右侧；说明原文仍保留在 title 里，悬停可看。
      const item = (label, sub, action, accent, meta = {}) => {
        const disabled = effectiveBusy || meta.disabled === true;
        const oneLine = meta.oneLine === true;
        return h(
          'button',
          {
            type: 'button',
            key: action,
            role: 'menuitem',
            'data-cr-item': action,
            disabled,
            title: oneLine ? (meta.note ?? sub) : undefined,
            onClick: () => {
              if (disabled) return;
              // M6：压缩项先走预览（meta.onClick），其余动作直接执行。
              if (typeof meta.onClick === 'function') {
                meta.onClick();
                return;
              }
              void run(action);
            },
            style: {
              display: 'flex',
              flexDirection: oneLine ? 'row' : 'column',
              alignItems: oneLine ? 'center' : 'flex-start',
              justifyContent: oneLine ? 'space-between' : 'flex-start',
              gap: oneLine ? 10 : 2,
              width: '100%',
              padding: oneLine ? '6px 10px' : '8px 10px',
              border: 'none',
              borderRadius: 8,
              background: 'transparent',
              cursor: disabled ? 'default' : 'pointer',
              textAlign: 'left',
              color: theme.panelFg,
              opacity: disabled ? 0.5 : 1,
            },
            onMouseEnter: (e) => {
              if (!disabled) e.currentTarget.style.background = theme.hover;
            },
            onMouseLeave: (e) => {
              e.currentTarget.style.background = 'transparent';
            },
          },
          h('span', { style: { fontSize: 13, fontWeight: 500, color: accent || theme.panelFg } }, label),
          oneLine
            ? h(
                'span',
                {
                  style: {
                    fontSize: meta.right === undefined ? 15 : 11,
                    lineHeight: 1,
                    color: theme.subText,
                    whiteSpace: 'nowrap',
                    marginLeft: 'auto',
                    maxWidth: 132,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                meta.right ?? '›',
              )
            : h('span', { style: { fontSize: 11, color: theme.subText } }, meta.note ?? sub),
        );
      };

      // undefined=宿主没上报（老版本/未知）；null=明确没有可压范围；object=可压多少。
      const rangeInfo = state.compactRange;
      const panel = open
        ? h(
            'div',
            {
              ref: menuRef,
              role: 'menu',
              'aria-label': '压缩接力菜单',
              style: {
                position: 'fixed',
                ...floatPos(268, 340),
                width: 268,
                maxWidth: 'calc(100vw - 16px)',
                maxHeight: 'min(70vh, 340px)',
                overflowY: 'auto',
                padding: 6,
                borderRadius: 12,
                ...panelChrome(theme),
                zIndex: 40,
              },
            },
            h(
              'div',
              { style: { padding: '6px 10px 4px', fontSize: 11, color: theme.subText } },
              pressureKnown
                ? `已用 ${(ratio * 100).toFixed(1)}% · 已压缩 ${state.summaries} 次`
                : `容量未知 · 已压缩 ${state.summaries} 次`,
            ),
            item(
              '压缩旧会话',
              '把较早会话压成摘要，腾出容量（先预估再确认，/bc）',
              'compact',
              adviseCompact ? palette.compact : null,
              {
                ...(rangeInfo === null
                  ? {
                      disabled: true,
                      note:
                        pins.count > 0
                          ? `暂无可压内容：有 ${pins.count} 条消息被锁定保护（先点「解锁消息」）`
                          : '暂无可压缩内容（会话太短，或近期会话需保留原文）',
                    }
                  : rangeInfo !== undefined
                    ? { note: `可压 ${rangeInfo.nodes} 条 · 约 ${fmt(rangeInfo.tokens)} tokens · 点击先看压缩预估` }
                    : { note: '点击先看压缩预估（范围/容量）' }),
                onClick: () => {
                  void startPreview();
                },
              },
            ),
            item(
              pins.count > 0 ? `解锁消息（${pins.count} 条）` : '锁定重要消息',
              pins.count > 0
                ? '解除锁定，允许后续压缩合并这些消息'
                : '锁定的消息压缩时不会碰（重要结论/路径先锁住，也可 /pin list 挑一条）',
              'pin',
              null,
              hasSession
                ? {
                    oneLine: true,
                    right: pins.count > 0 ? `已锁 ${pins.count} 条` : '未锁定',
                    onClick: () => {
                      void togglePins();
                    },
                  }
                : { oneLine: true, disabled: true, right: '未就绪', note: '会话还没就绪' },
            ),
            item(
              '交接新会话',
              '生成交接单并开新会话接着聊，旧会话保留（/handoff）',
              'handoff',
              palette.handoff,
              hasSession
                ? {
                    onClick: () => {
                      void startHandoffPreview();
                    },
                  }
                : { disabled: true, note: '会话刚打开，请稍候' },
            ),
            item('查看交接单', '翻看历史交接单、复制文件路径', 'docs', null, {
              oneLine: true,
              onClick: () => {
                void loadDocs();
              },
            }),
            hasSession
              ? item('查看上次压缩', '只读：压了哪些条、摘要预览、省了多少容量', 'diff', null, {
                  oneLine: true,
                  onClick: () => {
                    void loadDiff();
                  },
                })
              : item('查看上次压缩', '只读：压了哪些条、摘要预览、省了多少容量', 'diff', null, {
                  oneLine: true,
                  disabled: true,
                  right: '未就绪',
                  note: '会话还没就绪',
                }),
          )
        : null;

      // M6：确认卡——预览结果 + 「取消 / 确认执行」，点外面关闭。
      // 预览接口的外层是 { ok, message, preview:{nodes,tokens,…} }，卡片要读里层 preview。
      const previewRange = preview?.data?.preview ?? null;
      // 0.3.1：范围太小时预览阶段就拦下（服务端已按 800 tokens 判定），不让用户白确认一次。
      const previewTooSmall = previewRange !== null && previewRange.tooSmall === true;
      const confirmPanel =
        preview === null
          ? null
          : h(
              'div',
              {
                ref: previewRef,
                role: 'dialog',
                'aria-label': '确认压缩',
                'data-cr-preview': '1',
                style: {
                  position: 'fixed',
                  ...floatPos(300, 320),
                  width: 300,
                  maxWidth: 'calc(100vw - 16px)',
                  padding: '10px 12px',
                  borderRadius: 12,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  zIndex: 42,
                },
              },
              preview.loading === true
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    h('div', { style: { fontSize: 12, fontWeight: 600 } }, '正在估算可压缩的范围…'),
                    h('div', { style: { fontSize: 11, color: theme.subText } }, '只估算范围和容量；摘要内容确认后才生成，不在这里展示。'),
                  )
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    h('div', { style: { fontSize: 12, fontWeight: 600 } }, '确认压缩'),
                    h(
                      'div',
                      { style: { fontSize: 11, lineHeight: '17px', color: theme.subText } },
                      `将把 ${previewRange?.nodes ?? '—'} 条旧会话压成 1 条摘要（腾出约 ${fmt(previewRange?.tokens)} tokens）。`,
                      previewTooSmall
                        ? h(
                            'div',
                            { style: { marginTop: 4, color: '#b45309' } },
                            '这段太小，压了可能反而更大。建议先继续聊几轮，或把「保留近期原文」调小后再压缩。',
                          )
                        : null,
                      h('br'),
                      '只估算范围和容量；摘要内容确认后才生成，不在这里展示。压缩后旧会话将替换为摘要，无法还原为原文。',
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } },
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-confirm-cancel': '1',
                          onClick: () => setPreview(null),
                          style: {
                            border: `1px solid ${theme.panelBorder}`,
                            borderRadius: 7,
                            padding: '4px 10px',
                            fontSize: 11,
                            cursor: 'pointer',
                            background: 'transparent',
                            color: theme.panelFg,
                          },
                        },
                        '取消',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-confirm-run': '1',
                          disabled: previewTooSmall,
                          onClick: () => {
                            if (previewTooSmall) return;
                            void run('compact');
                          },
                          style: {
                            border: 'none',
                            borderRadius: 7,
                            padding: '4px 10px',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: previewTooSmall ? 'not-allowed' : 'pointer',
                            opacity: previewTooSmall ? 0.5 : 1,
                            background: palette.compact,
                            color: '#ffffff',
                          },
                        },
                        '确认压缩',
                      ),
                    ),
                  ),
            );

      // M6：交接单面板（列表 → 单篇全文，只读）。
      const smallBtnStyle = {
        border: `1px solid ${theme.panelBorder}`,
        borderRadius: 6,
        padding: '2px 8px',
        fontSize: 11,
        cursor: 'pointer',
        background: 'transparent',
        color: theme.panelFg,
      };
      // A1b：交接预览卡——九段草稿 + 就绪清单；确认才走完整交接（会先压缩再重新生成）。
      const handoffData = handoffPreview !== null && handoffPreview.loading !== true ? handoffPreview.data : null;
      const handoffReadiness = handoffData !== null && typeof handoffData === 'object' ? handoffData.readiness : null;
      const handoffDraft = handoffData !== null && typeof handoffData === 'object' && typeof handoffData.draft === 'string' ? handoffData.draft : '';
      const handoffPanel =
        handoffPreview === null
          ? null
          : h(
              'div',
              {
                ref: handoffPreviewRef,
                role: 'dialog',
                'aria-label': '交接预览',
                'data-cr-handoff-preview': '1',
                style: {
                  position: 'fixed',
                  ...floatPos(360, 520),
                  width: 360,
                  maxWidth: 'calc(100vw - 16px)',
                  maxHeight: 'min(72vh, 520px)',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 12,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  zIndex: 44,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { flex: 1, fontSize: 12, fontWeight: 600 } }, '交接预览'),
                h('button', { type: 'button', onClick: closeHandoffPreview, style: smallBtnStyle }, '关闭'),
              ),
              handoffPreview.loading === true
                ? h('div', { style: { fontSize: 11, color: theme.subText } }, '正在生成九段草稿并做就绪检查…（只预览，不写盘、不建会话）')
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 } },
                    h(
                      'div',
                      {
                        style: {
                          fontSize: 11,
                          lineHeight: '17px',
                          color: handoffReadiness !== null && handoffReadiness.ok === true ? theme.subText : '#b45309',
                        },
                      },
                      handoffReadiness !== null && handoffReadiness.ok === true
                        ? '就绪检查：九段齐全，可以交接。'
                        : '就绪检查未通过：' + (handoffReadiness?.missing ?? []).join('、'),
                      handoffReadiness !== null && Array.isArray(handoffReadiness.warnings) && handoffReadiness.warnings.length > 0
                        ? h('div', { style: { marginTop: 4 } }, '警告：' + handoffReadiness.warnings.slice(0, 3).join('；'))
                        : null,
                    ),
                    h(
                      'div',
                      {
                        style: {
                          fontSize: 11,
                          lineHeight: '16px',
                          overflow: 'auto',
                          maxHeight: 220,
                          border: `1px solid ${theme.panelBorder}`,
                          borderRadius: 8,
                          padding: '6px 8px',
                          background: theme.hover,
                        },
                      },
                      ...previewLines(
                        handoffDraft.length > 1500
                          ? `${handoffDraft.slice(0, 1500)}\n…（已截断，确认后生成完整交接单）`
                          : handoffDraft,
                      ),
                    ),
                    h('div', { style: { fontSize: 11, color: theme.subText } }, '确认后会先压缩旧会话，再按压缩后的历史生成最终交接单；预览不落盘。'),
                    h(
                      'div',
                      { style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } },
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-handoff-cancel': '1',
                          onClick: closeHandoffPreview,
                          style: { ...smallBtnStyle, borderRadius: 7, padding: '4px 10px' },
                        },
                        '取消',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-handoff-run': '1',
                          onClick: () => {
                            closeHandoffPreview();
                            void run('handoff');
                          },
                          style: {
                            border: 'none',
                            borderRadius: 7,
                            padding: '4px 10px',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer',
                            background: palette.handoff,
                            color: '#ffffff',
                          },
                        },
                        '确认交接',
                      ),
                    ),
                  ),
            );

      const docsPanel =
        docs === null
          ? null
          : h(
              'div',
              {
                ref: docsRef,
                role: 'dialog',
                'aria-label': '交接单',
                'data-cr-docs': '1',
                style: {
                  position: 'fixed',
                  ...floatPos(360, 520),
                  width: 360,
                  maxWidth: 'calc(100vw - 16px)',
                  maxHeight: 'min(70vh, 480px)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  borderRadius: 12,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  zIndex: 43,
                },
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    borderBottom: `1px solid ${theme.panelBorder}`,
                    fontSize: 12,
                    fontWeight: 600,
                  },
                },
                h(
                  'span',
                  { style: { flex: 1, minWidth: 0 } },
                  docs.selected !== undefined && docs.selected !== null
                    ? '交接单详情'
                    : `历史交接单（${Array.isArray(docs.items) ? docs.items.length : 0}）`,
                ),
                h('button', { type: 'button', 'data-cr-docs-close': '1', onClick: closeDocs, style: smallBtnStyle }, '关闭'),
              ),
              docs.loading === true
                ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: theme.subText } }, '读取中…')
                : docs.selected !== undefined && docs.selected !== null
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', flexWrap: 'wrap' } },
                        h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => setDocs({ items: docs.items, selected: null }),
                            style: smallBtnStyle,
                          },
                          '← 列表',
                        ),
                        h('button', { type: 'button', 'data-cr-docs-copy': '1', onClick: copyDocPath, style: smallBtnStyle }, '复制路径'),
                        h(
                          'span',
                          {
                            style: {
                              flex: 1,
                              minWidth: 0,
                              fontSize: 10,
                              color: theme.subText,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                          },
                          docs.docPath ?? '',
                        ),
                      ),
                      h(
                        'pre',
                        {
                          'data-cr-doc-content': '1',
                          style: {
                            margin: 0,
                            padding: '8px 12px',
                            overflowY: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            fontSize: 11,
                            lineHeight: '16px',
                            maxHeight: 'min(50vh, 320px)',
                          },
                        },
                        docs.contentLoading === true ? '读取中…' : (docs.contentError ?? docs.content ?? ''),
                      ),
                    )
                  : h(
                      'div',
                      { style: { overflowY: 'auto', padding: 4 } },
                      docs.error !== undefined && docs.error !== null
                        ? h('div', { style: { padding: '8px 10px', fontSize: 11, color: COLORS.error } }, String(docs.error))
                        : Array.isArray(docs.items) && docs.items.length > 0
                          ? docs.items.map((entry) =>
                              h(
                                'button',
                                {
                                  key: entry.name,
                                  type: 'button',
                                  'data-cr-doc-item': entry.name,
                                  onClick: () => {
                                    void openDoc(entry.name);
                                  },
                                  style: {
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'flex-start',
                                    gap: 2,
                                    width: '100%',
                                    padding: '7px 9px',
                                    border: 'none',
                                    borderRadius: 8,
                                    background: 'transparent',
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    color: theme.panelFg,
                                    fontSize: 12,
                                  },
                                  onMouseEnter: (event) => {
                                    event.currentTarget.style.background = theme.hover;
                                  },
                                  onMouseLeave: (event) => {
                                    event.currentTarget.style.background = 'transparent';
                                  },
                                },
                                h(
                                  'span',
                                  { style: { fontWeight: 500, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                                  entry.sourceTitle || entry.name,
                                ),
                                h(
                                  'span',
                                  { style: { fontSize: 10, color: theme.subText } },
                                  `${fmtTime(entry.mtime)} · ${Math.max(1, Math.round((Number(entry.size) || 0) / 1024))}KB · ${entry.name}`,
                                ),
                              ),
                            )
                          : h(
                              'div',
                              { style: { padding: '10px 12px', fontSize: 11, color: theme.subText } },
                              '还没有交接单；执行一次「交接新会话」（/handoff）后会自动保存在这里。',
                            ),
                    ),
            );

      // A6：压缩历史面板（只读）——范围、摘要预览、容量、是否已提交。
      const diffStatus = (entry) => {
        if (entry.committed === true) return '已提交';
        if (entry.open === true) return '未闭合';
        if (entry.error !== null && entry.error !== undefined) return '失败';
        return '未提交';
      };
      const diffPanel =
        diff === null
          ? null
          : h(
              'div',
              {
                ref: diffRef,
                role: 'dialog',
                'aria-label': '压缩记录',
                'data-cr-diff': '1',
                style: {
                  position: 'fixed',
                  ...floatPos(360, 520),
                  width: 360,
                  maxWidth: 'calc(100vw - 16px)',
                  maxHeight: 'min(70vh, 480px)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  borderRadius: 12,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  zIndex: 43,
                },
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    borderBottom: `1px solid ${theme.panelBorder}`,
                    fontSize: 12,
                    fontWeight: 600,
                  },
                },
                h('span', { style: { flex: 1, minWidth: 0 } }, `压缩记录（最近 ${Array.isArray(diff.items) ? diff.items.length : 0} 次）`),
                h('button', { type: 'button', 'data-cr-diff-close': '1', onClick: closeDiff, style: smallBtnStyle }, '关闭'),
              ),
              diff.loading === true
                ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: theme.subText } }, '读取中…')
                : diff.error !== undefined && diff.error !== null
                  ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: COLORS.error } }, String(diff.error))
                  : Array.isArray(diff.items) && diff.items.length > 0
                    ? h(
                        'div',
                        { style: { overflowY: 'auto', padding: 4 } },
                        diff.items.map((entry, index) =>
                          h(
                            'div',
                            {
                              key: `${entry.seq ?? index}`,
                              'data-cr-diff-item': String(entry.seq ?? index),
                              style: {
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 3,
                                padding: '7px 9px',
                                borderRadius: 8,
                              },
                            },
                            h(
                              'span',
                              { style: { fontSize: 12, fontWeight: 600 } },
                              `${index === 0 ? '最近一次' : `第 ${index + 1} 近`} · ${diffStatus(entry)}`,
                            ),
                            h(
                              'span',
                              { style: { fontSize: 10, color: theme.subText } },
                              `${entry.shadowedCount ?? 0} 条旧会话 → 1 条摘要 · 约 ${fmt(entry.shadowedTokens)} tokens · ${fmtTime(entry.at)}`,
                            ),
                            h(
                              'span',
                              { style: { fontSize: 11, lineHeight: '16px', color: entry.error ? COLORS.error : theme.subText, whiteSpace: 'normal', wordBreak: 'break-word' } },
                              entry.error ? `错误：${entry.error.message ?? entry.error.name ?? '未知'}` : entry.preview || '（摘要为空）',
                            ),
                          ),
                        ),
                      )
                    : h('div', { style: { padding: '10px 12px', fontSize: 11, color: theme.subText } }, '还没有压缩记录。'),
            );

      const toastText =
        typeof toast === 'string'
          ? toast
          : toast !== null && typeof toast === 'object' && typeof toast.text === 'string'
            ? toast.text
            : '';

      return h(
        'div',
        { ref: rootRef, style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('span', { style: { position: 'relative', display: 'inline-flex' } }, trigger, tooltip),
        panel,
        confirmPanel,
        handoffPanel,
        docsPanel,
        diffPanel,
        toastText.length > 0
          ? h(
              'div',
              {
                ref: toastRef,
                role: 'status',
                'data-cr-toast': '1',
                style: {
                  position: 'fixed',
                  // 贴着指示灯显示（操作结果就在手边），拿不到锚点才回退到顶部居中。
                  ...(anchor === null ? { top: 12, left: '50%', transform: 'translateX(-50%)' } : floatPos(360)),
                  width: 'max-content',
                  maxWidth: 'min(460px, calc(100vw - 24px))',
                  whiteSpace: 'normal',
                  wordBreak: 'break-word',
                  textAlign: 'left',
                  padding: '8px 12px',
                  borderRadius: 10,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  borderLeft: `3px solid ${/失败|错误|无法|没有可|不满足|拒绝|未知/.test(toastText) ? COLORS.ringAdviseHandoff : '#2fb344'}`,
                  fontSize: 12,
                  lineHeight: '18px',
                  zIndex: 41,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                },
              },
              h('span', { style: { flex: 1, minWidth: 0 } }, toastText),
              // 压缩执行中给一个「取消」——点了就 abort 事务（历史不变）。
              toast !== null && typeof toast === 'object' && toast.cancel === true
                ? h(
                    'button',
                    {
                      type: 'button',
                      'data-cr-toast-cancel': '1',
                      onClick: cancelRun,
                      style: { ...smallBtnStyle, flex: 'none' },
                    },
                    '取消',
                  )
                : null,
            )
          : null,
      );
    }

    /** 交接结果的一行式展示（放在聊天流里的 /handoff 命令卡）。 */
    function handoffRow(text, tone, action) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 2px',
            fontSize: 12,
            color: tone === 'error' ? COLORS.error : COLORS.subText,
          },
        },
        h('span', { style: { flex: 1, minWidth: 0 } }, text),
        action
          ? h(
              'button',
              {
                type: 'button',
                onClick: action,
                style: {
                  flex: 'none',
                  border: 'none',
                  borderRadius: 6,
                  padding: '2px 8px',
                  background: COLORS.hover,
                  color: 'inherit',
                  fontSize: 11,
                  cursor: 'pointer',
                },
              },
              '重试打开',
            )
          : null,
      );
    }

    /**
     * /handoff 命令卡：命令成功后自动切到新会话。
     * 这个槽把命令的通用卡片替换成我们的卡片（只有 /handoff 这一个 key）。
     */
    function HandoffCard({ node, waitAndOpen }) {
      const outcome = node !== null && typeof node === 'object' ? node.outcome : undefined;
      const outcomeText = outcome !== null && typeof outcome === 'object' && typeof outcome.text === 'string' ? outcome.text : '';
      // A5：优先用命令结果里的结构化 childId；旧宿主没带字段时再从文本 #child= 兜底。
      const childId =
        outcome !== null && typeof outcome === 'object' && typeof outcome.childId === 'string' && outcome.childId.length > 0
          ? outcome.childId
          : extractChildId(outcomeText);
      // P2-C1：区分 opening / opened / failed；刷新后只有 localStorage='1' 才算已打开，
      // 'opening'（上次没走完）要重新尝试，不能直接渲染成功态。
      const [status, setStatus] = useState(() => {
        if (outcome === undefined) return 'running';
        if (outcome !== null && outcome.kind === 'error') return 'error';
        if (childId === null) return 'done';
        return wasOpened(childId) ? 'done' : 'opening';
      });
      const [detail, setDetail] = useState(null);

      const openChild = useCallback(() => {
        if (childId === null) return;
        setStatus('opening');
        setDetail(null);
        waitAndOpen(childId).then(
          () => {
            markOpened(childId, '1');
            setStatus('done');
          },
          (error) => {
            clearOpened(childId);
            setStatus('failed');
            setDetail(String(error && error.message ? error.message : error));
          },
        );
      }, [childId, waitAndOpen]);

      useEffect(() => {
        if (outcome === undefined || outcome === null || outcome.kind !== 'success' || childId === null) return;
        if (wasOpened(childId)) {
          setStatus('done');
          return;
        }
        markOpened(childId, 'opening');
        let alive = true;
        waitAndOpen(childId).then(
          () => {
            markOpened(childId, '1');
            if (alive) setStatus('done');
          },
          (error) => {
            clearOpened(childId);
            if (!alive) return;
            setStatus('failed');
            setDetail(String(error && error.message ? error.message : error));
          },
        );
        return () => {
          alive = false;
        };
      }, [childId, outcome, waitAndOpen]);

      if (status === 'running') return handoffRow('正在交接：压缩旧会话 → 生成交接单 → 打开新会话…');
      if (status === 'error') return handoffRow(outcomeText || '交接失败（详见日志）', 'error');
      if (childId === null) return handoffRow(outcomeText || '交接完成');
      if (status === 'failed') {
        return handoffRow(`新会话已建好（${childId}），自动切换失败：${detail || '未知原因'}`, 'error', openChild);
      }
      if (status === 'opening') return handoffRow(`交接完成，正在打开新会话（${childId}）…`);
      return handoffRow('交接完成：已切到新会话（点指示灯 → 查看交接单 可回看或复制）。');
    }

    /* ---------------- 设置栏：压缩接力 ---------------- */

    /** 颜色预设：点一下同时改 4 个基准色。 */
    const COLOR_PRESETS = [
      { id: 'classic', label: '经典', base: { idle: '#6F7680', compact: '#C26A00', handoff: '#D92D20', stage: '#2563EB', pin: '#C026D3' } },
      { id: 'contrast', label: '高对比', base: { idle: '#4B5563', compact: '#92400E', handoff: '#B91C1C', stage: '#1D4ED8', pin: '#A21CAF' } },
      { id: 'soft', label: '柔和', base: { idle: '#7D8794', compact: '#B45309', handoff: '#D05A55', stage: '#3B82F6', pin: '#D946EF' } },
    ];

    const settingsHintStyle = { margin: 0, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' };
    const settingsLabelStyle = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' };
    const settingsInputStyle = {
      height: 28,
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'inherit',
      fontSize: 12,
      padding: '0 8px',
      maxWidth: 320,
    };
    const settingsButtonStyle = {
      height: 30,
      borderRadius: 7,
      border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3))',
      background: 'transparent',
      color: 'inherit',
      fontSize: 12,
      padding: '0 12px',
      cursor: 'pointer',
    };

    /** 不可变地设置对象里的某个路径。 */
    function setIn(object, path, value) {
      if (path.length === 1) return { ...object, [path[0]]: value };
      return { ...object, [path[0]]: setIn(object[path[0]] ?? {}, path.slice(1), value) };
    }

    /** 一行设置：标签 + 作用小字 + 调整后的变化小字 + 控件。 */
    function settingsRow(label, purpose, effect, control) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 18 } },
        h('div', { style: settingsLabelStyle }, label),
        h('p', { style: settingsHintStyle }, `作用：${purpose}`),
        h('p', { style: settingsHintStyle }, `调整后：${effect}`),
        h('div', { style: { marginTop: 6 } }, control),
      );
    }

    /** 区块标题：设置页按权重分区块（UI-002），标题前一条细分隔线。 */
    function sectionHeading(title) {
      return h(
        'div',
        { style: { marginTop: 26, paddingTop: 14, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))', fontSize: 14, fontWeight: 700, color: 'var(--dsw-alias-label-primary, inherit)' } },
        title,
      );
    }

    /** 色块预览：显示一个颜色在浅/深界面里分别会变成什么样。 */
    function colorPreviewRow(baseColor) {
      const light = paletteForScheme({ autoAdapt: true, base: { ...DEFAULT_BASE, idle: baseColor, compact: baseColor, handoff: baseColor, stage: baseColor } }, 'light');
      const dark = paletteForScheme({ autoAdapt: true, base: { ...DEFAULT_BASE, idle: baseColor, compact: baseColor, handoff: baseColor, stage: baseColor } }, 'dark');
      const swatch = (label, color) =>
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } },
          h('i', { style: { width: 10, height: 10, borderRadius: 999, background: color, display: 'inline-block' } }),
          `${label} ${color}`,
        );
      return h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 } }, swatch('浅色', light.idle), swatch('深色', dark.idle));
    }

    /** GitHub 外链；URL 还没配置时显示“准备中”占位（先预留接口）。 */
    function githubLink(label, url, placeholder) {
      const style = { fontSize: 12, color: 'var(--dsw-alias-state-business-primary, #2563eb)', textDecoration: 'underline', cursor: 'pointer' };
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        return h('a', { href: url, target: '_blank', rel: 'noreferrer noopener', style }, label);
      }
      return h('span', { style: { ...settingsHintStyle, fontSize: 12 } }, placeholder);
    }

    /** 颜色选择控件：色盘 + 浅/深预览。 */
    function colorField(value, onChange, label) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h('input', {
          type: 'color',
          'aria-label': label,
          value: normalizeHex(value, '#888888'),
          onChange: (event) => onChange(event.target.value),
          style: { width: 36, height: 28, padding: 2, border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3))', borderRadius: 6, background: 'transparent' },
        }),
        colorPreviewRow(normalizeHex(value, '#888888')),
      );
    }

    /** 设置栏面板：阈值 / 压缩 / 颜色。 */
    function CompactRelaySettings() {
      const [form, setForm] = useState(null);
      /** 已保存表单的 JSON 快照：用来提示「有未保存的修改」。 */
      const [savedSnapshot, setSavedSnapshot] = useState(null);
      const [version, setVersion] = useState('');
      const [status, setStatus] = useState(null);
      const [saving, setSaving] = useState(false);
      /** A4：设置文件有问题时后端仍返回默认配置 + 错误说明，这里在顶部提示。 */
      const [settingsError, setSettingsError] = useState(null);
      /** A4：恢复默认是删文件，二次确认后才执行。 */
      const [confirmReset, setConfirmReset] = useState(false);
      /** 0.3.1：DSH 原生自动压缩配置（读 profile + 默认值）与开关确认。 */
      const [native, setNative] = useState(null);
      /** UI-002：设置文件路径（「关于与危险操作」区块展示）。 */
      const [settingsPath, setSettingsPath] = useState('');
      const [confirmNative, setConfirmNative] = useState(null); // null | 'disable' | 'enable'
      const [nativeBusy, setNativeBusy] = useState(false);
      /** UI-003：结果提示就地显示在开关旁（以前只写页面底部，用户看不到）。 */
      const [nativeStatus, setNativeStatus] = useState(null);
      /** 作者 2026-10-20：设置页「再看一次初次引导」的就地提示。 */
      const [onboardingNotice, setOnboardingNotice] = useState(null);
      const nativeConfirmRef = useRef(null);

      /** 把服务端返回的 view 落到表单：同时更新「已保存」快照和设置文件错误。 */
      const applyLoaded = useCallback((data) => {
        setForm(data.config);
        setSavedSnapshot(JSON.stringify(data.config));
        setSettingsError(data.settingsError ?? null);
        setNative(data.native && typeof data.native === 'object' ? data.native : null);
        if (typeof data.version === 'string') setVersion(data.version);
        if (typeof data.path === 'string') setSettingsPath(data.path);
      }, []);

      const load = useCallback(async () => {
        try {
          const res = await fetch('/api/compact-relay-settings', { cache: 'no-store' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '读取设置失败');
          applyLoaded(data);
          setStatus(null);
        } catch (error) {
          setStatus({ error: true, text: `读取设置失败：${error && error.message ? error.message : '未知错误'}` });
        }
      }, [applyLoaded]);

      useEffect(() => {
        void load();
      }, [load]);

      const patch = (path, value) => {
        setForm((prev) => (prev === null ? prev : setIn(prev, path, value)));
        setConfirmReset(false);
      };

      /** 表单与已保存快照不一致 → 有未保存修改。 */
      const dirty = form !== null && savedSnapshot !== null && JSON.stringify(form) !== savedSnapshot;

      const save = useCallback(async () => {
        if (form === null || saving) return;
        setSaving(true);
        setStatus(null);
        setConfirmReset(false);
        try {
          const res = await fetch('/api/compact-relay-settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(form),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '保存失败');
          applyLoaded(data);
          setStatus({ text: '已保存（立即生效，不需要重启）' });
        } catch (error) {
          setStatus({ error: true, text: `保存失败：${error && error.message ? error.message : '未知错误'}` });
        } finally {
          setSaving(false);
        }
      }, [form, saving, applyLoaded]);

      /** 恢复默认 = 删除用户设置文件；先二次确认，避免误点丢掉配色。 */
      const reset = useCallback(async () => {
        if (saving) return;
        setSaving(true);
        setStatus(null);
        try {
          const res = await fetch('/api/compact-relay-settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '恢复默认失败');
          applyLoaded(data);
          setConfirmReset(false);
          setStatus({ text: '已恢复默认设置' });
        } catch (error) {
          setStatus({ error: true, text: `恢复默认失败：${error && error.message ? error.message : '未知错误'}` });
        } finally {
          setSaving(false);
        }
      }, [saving, applyLoaded]);

      /** 0.3.1：关闭/恢复 DSH 原生自动压缩（写 profile 配置，备份后重启生效）。 */
      const applyNative = useCallback(
        async (enabled) => {
          if (nativeBusy) return;
          setNativeBusy(true);
          setNativeStatus(null);
          try {
            const res = await fetch('/api/compact-relay-action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'native-auto', enabled }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '调整失败');
            setConfirmNative(null);
            setNativeStatus({ text: data.message ?? (enabled ? '已恢复 DSH 原生自动压缩' : '已关闭 DSH 原生自动压缩') });
            await load();
          } catch (error) {
            setNativeStatus({ error: true, text: `调整失败：${error && error.message ? error.message : '未知错误'}` });
          } finally {
            setNativeBusy(false);
          }
        },
        [nativeBusy, load],
      );

      // UI-003：确认块出现时滚进视野（以前它渲染在设置页底部以外，用户以为「点了没反应」）。
      useEffect(() => {
        if (confirmNative !== null && nativeConfirmRef.current && typeof nativeConfirmRef.current.scrollIntoView === 'function') {
          nativeConfirmRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }, [confirmNative]);

      if (form === null) {
        return h(
          'div',
          { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))', padding: '8px 0' } },
          status && status.error ? status.text : '读取设置中…',
        );
      }

      const percent = (ratio) => Math.round(ratio * 100);
      const compactPercent = percent(form.thresholds.compactRatio);
      const handoffPercent = percent(form.thresholds.handoffRatio);
      const count = (value) => (Number.isFinite(value) ? value : 0);

      const autoOnNative = native !== null && native.autoEnabled !== false;
      const nativePercent = native !== null && typeof native.thresholdRatio === 'number' ? Math.round(native.thresholdRatio * 100) : 80;
      const previewLight = paletteForScheme(form.colors, 'light');
      const previewDark = paletteForScheme(form.colors, 'dark');
      const banner = settingsError === null ? null : h(
        'div',
        { style: { marginBottom: 14, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-state-warning-primary, #d97706)', background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))' } },
        h(
          'div',
          { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning-primary, #b45309)' } },
          `设置文件有误${settingsError.field ? `（${settingsError.field}）` : ''}：${settingsError.message}`,
        ),
        h('div', { style: { ...settingsHintStyle, marginTop: 4 } }, '已按默认设置启动；点「恢复默认」会删除这个文件。'),
      );

      const swatch = (color, scheme) =>
        h('span', {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))',
          },
        }, h('i', { style: { width: 10, height: 10, borderRadius: 999, background: color, display: 'inline-block' } }), scheme);

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', maxWidth: 680, padding: '4px 0 20px' } },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '压缩接力'),
        h(
          'p',
          { style: { margin: '0 0 4px', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.95))' } },
          '功能：看上下文容量、到线提醒并帮你压缩旧会话 / 交接新会话、锁定重要消息；边界：只动本插件的压缩与交接历史，不改模型回复，也不接管 DSH 原生自动压缩（只在本页开关、改了要重启）。',
        ),
        h('p', { style: { ...settingsHintStyle, marginBottom: 10 } }, '这里改的设置立即生效，不需要重启。阈值按窗口比例算：换不同上下文窗口的模型会自动缩放。'),
        banner,
        sectionHeading('压缩提示'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '压缩提示' },
          settingsRow(
            '最小压缩线',
            '低于这条线，压缩不划算（摘要可能比原文还大），模型不会建议压缩，环上也不出断点。',
            '它会随「保留近期原文」和模型窗口自动抬高，保证压缩一定有净收益；不用细调，默认 5% 就行。',
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'number', min: 1, max: 60, step: 1, value: Math.round(form.thresholds.minRatio * 100), 'aria-label': '最小压缩线（百分比）', style: { ...settingsInputStyle, width: 90 },
                onChange: (event) => patch(['thresholds', 'minRatio'], Math.min(0.6, Math.max(0.01, Number(event.target.value) / 100))),
              }),
              h('span', { style: settingsHintStyle }, '% 窗口'),
            ),
          ),
          settingsRow(
            '压缩提醒线',
            '指示灯到这条线开始变琥珀色，菜单也会建议「压缩旧会话」。',
            '调高 → 更晚提醒、压得更少但上下文更长；调低 → 更早提醒、压得更勤。',
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'number', min: 5, max: 95, step: 1, value: compactPercent, 'aria-label': '压缩提醒线（百分比）', style: { ...settingsInputStyle, width: 90 },
                onChange: (event) => patch(['thresholds', 'compactRatio'], Math.min(0.95, Math.max(0.05, Number(event.target.value) / 100))),
              }),
              h('span', { style: settingsHintStyle }, '% 窗口'),
              h('span', { style: settingsHintStyle }, `（1M 窗口 ≈ ${Math.round(1000000 * form.thresholds.compactRatio / 1000)}K）`),
            ),
          ),
          settingsRow(
            '交接提醒线',
            '到这条线内圆亮红点，菜单建议「交接新会话」。',
            '调高 → 更晚换会话、单会话更久；调低 → 更早换会话、单会话更短。必须大于压缩线。',
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'number',
                min: 5,
                max: native !== null && native.autoEnabled !== false ? Math.max(5, Math.round(native.thresholdRatio * 100) - 1) : 99,
                step: 1,
                value: handoffPercent,
                'aria-label': '交接提醒线（百分比）',
                style: { ...settingsInputStyle, width: 90 },
                onChange: (event) => {
                  const raw = Math.max(0.05, Number(event.target.value) / 100);
                  const cap = native !== null && native.autoEnabled !== false ? Math.max(0.05, native.thresholdRatio - 0.01) : 0.99;
                  patch(['thresholds', 'handoffRatio'], Math.min(cap, raw));
                },
              }),
              h('span', { style: settingsHintStyle }, '% 窗口'),
              h('span', { style: settingsHintStyle }, `（1M 窗口 ≈ ${Math.round(1000000 * form.thresholds.handoffRatio / 1000)}K）`),
            ),
          ),
        ),
        sectionHeading('压缩行为'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '压缩行为' },
          settingsRow(
            '摘要份数上限',
            '会话里压缩摘要到这么多份后，也建议交接；下次压缩会把旧摘要一并合并。',
            '调高 → 可以多压几轮再交接；调低 → 更早交接，旧摘要更早被合并。',
            h('input', {
              type: 'number', min: 0, max: 20, step: 1, value: count(form.thresholds.maxSummaries), 'aria-label': '摘要份数上限', style: { ...settingsInputStyle, width: 90 },
              onChange: (event) => patch(['thresholds', 'maxSummaries'], Math.max(0, Math.round(Number(event.target.value)))),
            }),
          ),
          settingsRow(
            '保留近期原文',
            '压缩时，这段 token 范围内的近期消息保持原文，不压成摘要。',
            '调高 → 保留更多原文、压缩后省得更少；调低 → 压得更狠、可能丢掉近期细节。',
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'number', min: 0, max: 200000, step: 1000, value: count(form.retention.recentTailTokens), 'aria-label': '保留近期原文（token）', style: { ...settingsInputStyle, width: 120 },
                onChange: (event) => patch(['retention', 'recentTailTokens'], Math.max(0, Math.round(Number(event.target.value)))),
              }),
              h('span', { style: settingsHintStyle }, 'token'),
            ),
          ),
          settingsRow(
            '交接单目录',
            '/handoff 生成的九段交接单保存到这里。',
            '改到别的目录后，旧交接单不会自动搬过去；「查看交接单」只列新目录。',
            h('input', {
              type: 'text', 'aria-label': '交接单目录', value: form.handoffDir, style: { ...settingsInputStyle, width: '100%' },
              onChange: (event) => patch(['handoffDir'], event.target.value),
            }),
          ),
        ),
        sectionHeading('DSH 原生自动压缩'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': 'DSH 原生自动压缩' },
          settingsRow(
            '自动压缩开关',
            native === null
              ? '正在读取 DSH 配置…'
              : autoOnNative
                ? `当前开启：容量到 ${nativePercent}% 时，DSH 会自己把历史压成摘要（不读本插件的锁定）。`
                : '当前已关闭：DSH 不再自动压历史，只有你主动压缩/交接才会动历史。',
            autoOnNative
              ? `开启时：容量到 ${nativePercent}% DSH 会自己压历史（不读锁定）；关闭后：只在你主动压缩/交接时才动历史。`
              : '开启后：DSH 会在容量到原生阈值时自动压历史，可能压掉锁定的消息；本插件的提醒照常。',
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
              h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  'aria-checked': autoOnNative ? 'true' : 'false',
                  'aria-label': 'DSH 原生自动压缩开关',
                  'data-cr-native-switch': autoOnNative ? 'on' : 'off',
                  disabled: native === null || nativeBusy,
                  onClick: () => {
                    setNativeStatus(null);
                    setConfirmNative(autoOnNative ? 'disable' : 'enable');
                  },
                  style: {
                    position: 'relative',
                    width: 42,
                    height: 24,
                    padding: 0,
                    borderRadius: 999,
                    flex: '0 0 auto',
                    border: `1px solid ${autoOnNative ? 'transparent' : 'var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))'}`,
                    background: autoOnNative ? '#2563EB' : 'rgba(127,127,127,0.25)',
                    cursor: native === null || nativeBusy ? 'wait' : 'pointer',
                    transition: 'background 160ms ease',
                  },
                },
                h('span', {
                  'aria-hidden': true,
                  style: {
                    position: 'absolute',
                    top: 3,
                    left: autoOnNative ? 21 : 3,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 160ms ease',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                  },
                }),
              ),
              h('span', { style: { fontSize: 12, fontWeight: 600, minWidth: 44 } }, native === null ? '读取中…' : nativeBusy ? '处理中…' : autoOnNative ? '已开启' : '已关闭'),
              h('span', { style: settingsHintStyle }, native !== null ? `原生阈值 ${nativePercent}%` : ''),
              nativeStatus === null
                ? null
                : h(
                    'span',
                    {
                      'data-cr-native-status': nativeStatus.error ? 'error' : 'ok',
                      style: {
                        fontSize: 11,
                        lineHeight: '16px',
                        color: nativeStatus.error ? 'var(--dsw-alias-state-error-primary, #D92D20)' : 'var(--dsw-alias-state-success-primary, #15803D)',
                      },
                    },
                    nativeStatus.text,
                  ),
            ),
          ),
          confirmNative === null
            ? null
            : h(
                'div',
                {
                  ref: nativeConfirmRef,
                  style: {
                    margin: '0 0 14px',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-state-warning-primary, #d97706)',
                    background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
                  },
                },
                h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, confirmNative === 'disable' ? '确认关闭 DSH 原生自动压缩？' : '确认恢复 DSH 原生自动压缩？'),
                h(
                  'div',
                  { style: { ...settingsHintStyle, marginBottom: 8 } },
                  confirmNative === 'disable'
                    ? `操作内容：在 DSH profile 的 cordis.patch.yml 里把 compaction-basic 的 auto 改为 false（写前备份原文件，可回滚）。` +
                      `改变：DSH 不再在容量到 ${nativePercent}% 时自动压缩历史；锁定的消息不会被压掉；本插件的提醒和手动压缩照常。需要重启 DSH 生效。`
                    : `操作内容：在 DSH profile 的 cordis.patch.yml 里把 compaction-basic 的 auto 改回 true（写前备份，可回滚）。` +
                      `改变：DSH 重新在容量到 ${nativePercent}% 时自动压历史，可能压掉锁定的消息。需要重启 DSH 生效。`,
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: nativeBusy,
                      style: { padding: '4px 12px', borderRadius: 6, border: '1px solid #d97706', background: '#d97706', color: '#fff', cursor: nativeBusy ? 'wait' : 'pointer', fontSize: 12 },
                      onClick: () => {
                        void applyNative(confirmNative === 'enable');
                      },
                    },
                    nativeBusy ? '处理中…' : '确认调整',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: nativeBusy,
                      style: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))', background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer', fontSize: 12 },
                      onClick: () => setConfirmNative(null),
                    },
                    '取消',
                  ),
                ),
              ),
        ),
        sectionHeading('颜色与外观'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '颜色与外观' },
          h(
            'p',
            { style: { ...settingsHintStyle, marginBottom: 12 } },
            '当前预览：',
            swatch(previewLight.idle, '浅色'),
            ' ',
            swatch(previewDark.idle, '深色'),
            '（按你选的基准色自动派生；下面每行也会显示该颜色的两套结果）',
          ),
          settingsRow(
            '颜色模式',
            '指示灯颜色跟随界面浅色/深色自动切换。',
            '自动 → 跟随界面明暗；浅色/深色 → 强制使用对应一套配色。',
            h('select', {
              'aria-label': '颜色模式', value: form.colors.mode, style: { ...settingsInputStyle, width: 140 },
              onChange: (event) => patch(['colors', 'mode'], event.target.value),
            },
              h('option', { value: 'auto' }, '自动（跟随界面）'),
              h('option', { value: 'light' }, '浅色'),
              h('option', { value: 'dark' }, '深色'),
            ),
          ),
          settingsRow(
            '自动适配颜色',
            '按界面明暗自动调整你选的颜色明度，保证细色环看得清。',
            '开 → 只选 3 个基准色即可；关 → 颜色原样用于两种界面（需要自己保证对比度）。',
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
              h('input', {
                type: 'checkbox', 'aria-label': '自动适配颜色', checked: form.colors.autoAdapt !== false,
                onChange: (event) => patch(['colors', 'autoAdapt'], event.target.checked),
              }),
              '开启自动适配（推荐）',
            ),
          ),
          h('p', { style: { ...settingsHintStyle, margin: '2px 0 6px' } }, '预设：'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 } },
            COLOR_PRESETS.map((preset) =>
              h('button', {
                key: preset.id, type: 'button', style: settingsButtonStyle,
                onClick: () => patch(['colors', 'base'], { ...preset.base }),
              }, preset.label),
            ),
          ),
          settingsRow(
            '默认颜色（① 正常）',
            '没到任何线时的外环颜色。',
            '换更显眼的色 → 平时更容易注意到指示灯；换更淡的色 → 更安静。',
            colorField(form.colors.base.idle, (value) => patch(['colors', 'base', 'idle'], value), '默认颜色'),
          ),
          settingsRow(
            '填满颜色（② 正常区走满）',
            '正常区（从 0 到第一个断点）走满后整段变成这个颜色。',
            '换成和压缩色（琥珀）差别大的颜色（如蓝）→ 越线时更醒目；换成接近灰色 → 更安静。',
            colorField(form.colors.base.stage, (value) => patch(['colors', 'base', 'stage'], value), '填满颜色'),
          ),
          settingsRow(
            '调整颜色（③ 该压缩）',
            '到压缩线后的外环颜色，提示该压缩旧会话了。',
            '调暖/调亮 → 提醒更强；接近默认色 → 提醒更弱。',
            colorField(form.colors.base.compact, (value) => patch(['colors', 'base', 'compact'], value), '调整颜色'),
          ),
          settingsRow(
            '上限颜色（④ 该交接）',
            '到交接线时的内圆红点（外环到线时也用它）。',
            '调成更醒目的红 → 交接信号更强；换其他色 → 和「该压缩」的区分度会变化。',
            colorField(form.colors.base.handoff, (value) => patch(['colors', 'base', 'handoff'], value), '上限颜色'),
          ),
          settingsRow(
            '锁定颜色（⑤ 锁定的消息）',
            '锁定重要消息后，指示灯环上按消息位置显示的块；最重要的信号，默认用最醒目的品红。',
            '换成更醒目的反差色 → 锁定位置一眼可见；换成接近默认色 → 更安静（但可能看不清标记）。',
            colorField(form.colors.base.pin, (value) => patch(['colors', 'base', 'pin'], value), '锁定颜色'),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' } },
            h('button', { type: 'button', style: { ...settingsButtonStyle, background: 'var(--dsw-alias-button-primary, #2563eb)', color: '#fff', border: 'none' }, disabled: saving, onClick: () => void save() }, saving ? '保存中…' : dirty ? '保存修改' : '保存'),
            dirty ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warning-primary, #b45309)' } }, '有未保存的修改') : null,
            status !== null ? h('span', { style: { fontSize: 11, color: status.error ? 'var(--dsw-alias-state-error-primary, #d92d20)' : 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } }, status.text) : null,
            h('span', { style: settingsHintStyle }, '改完点这里保存；恢复默认在页面最底部。'),
          ),
        ),
        sectionHeading('帮助'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '帮助' },
          // 0.3.1：教学卡片——几个示意小环 + 一句说明（不是截图，SVG 随用户配色/阈值变）。
          (() => {
            // BUG-009（2026-10-20）：每个示例环单独构造参数——比例按各自语义取、hint 用 null；
            // 不再共用 minRatio + 0.12 的假断点（那会让 5 个环的断点全挤在同一处、颜色也对不上）。
            const demoRatio = (ratio, hintRatio) => ringSegments(ratio, form.thresholds.compactRatio, form.thresholds.handoffRatio, hintRatio ?? null);
            // 点坐标/弧线 path 是共享几何（15-shared.js 的 ringPoint / ringArcPath）。
            const colorOf = (key) =>
              key === 'stage' ? previewLight.stage : key === 'compact' ? previewLight.compact : key === 'handoff' ? previewLight.handoff : previewLight.idle;
            const demoRing = (ring, options = {}) => {
              // 断点缺口：真实断点 + 示例专用缺口（「走满正常区」在压缩线上补一个，示意「到线就是断点1」）。
              const gap = 0.012;
              const gaps = [...ring.boundaries.map((boundary) => boundary.at), ...(options.extraGaps ?? [])];
              // 原生自动压缩线：和指示灯一样用「径向紫色刻度 + 底色描边」；越过线后整环红色闪烁。
              const nativeAt =
                typeof options.nativeAt === 'number' && options.nativeAt > 0.02 && options.nativeAt < 1 ? options.nativeAt : null;
              const nativeTick = nativeAt === null ? null : nativeTickAt(nativeAt);
              const nativeCrossed = nativeAt !== null && ring.ratio > nativeAt + 1e-9;
              return h(
                'svg',
                { viewBox: '0 0 20 20', width: 46, height: 46, 'aria-hidden': true, style: { display: 'block' } },
                h('circle', { cx: 10, cy: 10, r: 8, fill: 'none', stroke: 'rgba(127,127,127,0.28)', strokeWidth: 2 }),
                ...ring.segments
                  .filter((segment) => segment.to - segment.from > 0.001)
                  .map((segment, index) => {
                    // 和真实指示灯一致：首段从 0 画起、末段画到当前进度，都不让缺口。
                    const from = segment.from <= 1e-9 ? segment.from : segment.from + gap;
                    const to = Math.abs(segment.to - ring.ratio) < 1e-9 ? segment.to : segment.to - gap;
                    if (to - from <= 0.001) return null;
                    return h('path', { key: index, d: ringArcPath(from, to), fill: 'none', stroke: colorOf(segment.color), strokeWidth: 2, strokeLinecap: 'round', 'data-cr-demo': segment.color });
                  })
                  .filter((node) => node !== null),
                // 断点缺口用「背景色小段」强调一下（教学图里看得清）
                ...gaps.map((at, index) =>
                  h('path', { key: `b${index}`, d: ringArcPath(at - 0.01, at + 0.01), fill: 'none', stroke: 'var(--dsw-alias-bg-base, #fff)', strokeWidth: 3, 'data-cr-demo-gap': String(at) }),
                ),
                // 越过原生压缩线：整环红色闪烁（教学图里也演示出来）。
                ...(nativeCrossed
                  ? [
                      h('style', { key: 'native-alert-style' }, NATIVE_ALERT_CSS),
                      h('circle', {
                        key: 'native-alert',
                        cx: 10,
                        cy: 10,
                        r: 8,
                        fill: 'none',
                        stroke: previewLight.handoff,
                        strokeWidth: 2.4,
                        strokeLinecap: 'round',
                        style: { animation: 'cr-native-alert 1s ease-in-out infinite' },
                        'data-cr-native-alert': '1',
                      }),
                    ]
                  : []),
                ...(nativeTick === null
                  ? []
                  : [
                      h('line', { key: 'native-casing', ...nativeTick, stroke: 'var(--dsw-alias-bg-base, #fff)', strokeWidth: 4.2, strokeLinecap: 'round', opacity: 0.92 }),
                      h('line', { key: 'native-line', ...nativeTick, stroke: NATIVE_LINE_COLOR, strokeWidth: 2.2, strokeLinecap: 'round', 'data-cr-demo-native': String(nativeAt) }),
                    ]),
              );
            };
            const compactRatio = form.thresholds.compactRatio;
            const handoffRatio = form.thresholds.handoffRatio;
            const legend = [
              // 每个示例的 ratio / hint 都按它要说明的状态单独给，不再共用 hint。
              { ratio: Math.max(0.045, form.thresholds.minRatio * 0.9), hint: null, title: '还没到最小线', text: '灰：正常，别急着压' },
              { ratio: compactRatio, hint: null, extraGaps: [compactRatio], title: '走满正常区', text: '蓝 + 断点1（该压缩的位置）' },
              { ratio: compactRatio + 0.08, hint: null, title: '进入压缩区', text: '琥珀：建议压缩旧会话' },
              { ratio: handoffRatio + 0.15, hint: null, title: '越过交接线', text: '红：建议交接新会话' },
            ];
            if (native !== null && native.autoEnabled !== false) {
              legend.push({
                ratio: native.thresholdRatio + 0.06,
                hint: null,
                nativeAt: native.thresholdRatio,
                title: '原生自动压缩线',
                text: `${Math.round(native.thresholdRatio * 100)}%：DSH 会自己压历史（越过整环红色闪烁）`,
              });
            }
            return h(
              'div',
              { style: { marginBottom: 16, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))', background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.04))' } },
              h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '指示灯怎么看'),
              h(
                'div',
                { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
                ...legend.map((item) =>
                  h(
                    'div',
                    { key: item.title, 'data-cr-demo-item': item.title, style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 150 } },
                    demoRing(demoRatio(Math.min(0.95, item.ratio), item.hint), { extraGaps: item.extraGaps, nativeAt: item.nativeAt }),
                    h(
                      'div',
                      { style: { fontSize: 11, lineHeight: '15px' } },
                      h('div', { style: { fontWeight: 600 } }, item.title),
                      h('div', { style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } }, item.text),
                    ),
                  ),
                ),
              ),
              h('div', { style: { ...settingsHintStyle, marginTop: 6 } }, '断点=小缺口：我判断「这里适合压缩」的位置（模型判断或到线自动出现）；压缩后环变短，断点自然消失。'),
            );
          })(),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 } },
            h(
              'button',
              {
                type: 'button',
                style: settingsButtonStyle,
                'data-cr-replay-onboarding': '1',
                onClick: () => {
                  try {
                    window.dispatchEvent(new CustomEvent('compact-relay:replay-onboarding', { detail: { pulseMs: 9000, toastMs: 20000 } }));
                  } catch {
                    /* ignore */
                  }
                  setOnboardingNotice('已重新播放：关掉设置页后，指示灯会呼吸光晕并再弹一次引导（提示约 20 秒）。');
                },
              },
              '再看一次初次引导',
            ),
            onboardingNotice === null
              ? null
              : h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } }, onboardingNotice),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 18 } },
            githubLink('使用教程（GitHub）', form.links?.tutorial, '使用教程：未配置链接'),
            githubLink('反馈 / 提 bug（GitHub Issues）', form.links?.feedback, '反馈 / 提 bug：未配置链接'),
            // 2026-10-20：0.3.1 已发布到 npm，帮助区直接给包页面入口。
            githubLink('npm 包页面', 'https://www.npmjs.com/package/dsh-compact-relay', ''),
          ),
        ),
        sectionHeading('关于与危险操作'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '关于与危险操作' },
          h('p', { style: settingsHintStyle }, `版本：${version || '—'}`),
          h('p', { style: settingsHintStyle }, `设置文件：${settingsPath || '—'}`),
          h('p', { style: { ...settingsHintStyle, marginTop: 8 } }, '输入框左侧的上下文指示灯：看容量、提醒压缩/交接、锁住重要消息；到线了用 /bc 或 /handoff，重要内容用 /pin 锁住。'),
          h('p', { style: settingsHintStyle }, '遇到 bug 或想提改进：走上面「帮助」里的 GitHub Issues；也欢迎直接发邮件。'),
          h('p', { style: settingsHintStyle }, '联系方式：cfanzx@136.com（合作、安全问题，以及不便公开讨论的事项）。'),
          h('p', { style: settingsHintStyle }, 'npm 包页面：https://www.npmjs.com/package/dsh-compact-relay'),
          h('p', { style: settingsHintStyle }, '致谢：DeepSeek Harness；设置栏实现参考了 dsh-plugin-memory；也谢谢帮忙测试的朋友们。'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 20, paddingTop: 14, borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.25))', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary, #d92d20)' } }, '危险操作'),
            confirmReset
              ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                  h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary, #d92d20)' } }, '确定恢复默认？（会删除你的设置文件）'),
                  h('button', { type: 'button', style: settingsButtonStyle, disabled: saving, onClick: () => void reset() }, '确定恢复'),
                  h('button', { type: 'button', style: settingsButtonStyle, disabled: saving, onClick: () => setConfirmReset(false) }, '取消'),
                )
              : h('button', { type: 'button', style: settingsButtonStyle, disabled: saving, onClick: () => setConfirmReset(true) }, '恢复默认'),
          ),
        )

      );
    }

    /**
     * 装配浏览器半。
     * @param {object} ctx 客户端根上下文
     */
    function apply(ctx) {
      /**
       * 等新会话进入会话列表后把主视图切过去。
       * 新会话是 host 侧刚创建的：客户端 catalog 需要一次推送/拉取才认识它。
       * @param {string} sessionId
       */
      const openChildSession = async (sessionId) => {
        if (typeof sessionId !== 'string' || !/^session-.+/.test(sessionId)) {
          throw new Error('缺少新会话 id');
        }
        let lastError = null;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          let known = false;
          try {
            const snapshot = ctx.sessions.list.getSnapshot();
            known = snapshot !== undefined && snapshot.byId !== undefined && snapshot.byId[sessionId] !== undefined;
          } catch (error) {
            lastError = error;
          }
          if (known) {
            try {
              ctx.uiWorkspace.openSession(sessionId);
              return;
            } catch (error) {
              lastError = error;
            }
          } else if (attempt === 2 || attempt === 8 || attempt === 16) {
            try {
              ctx.sessions.refresh();
            } catch (error) {
              lastError = error;
            }
          }
          await sleep(400);
        }
        // 最后一次尝试：catalog 可能滞后，但 retain 已经认识它。
        try {
          ctx.uiWorkspace.openSession(sessionId);
        } catch (error) {
          throw lastError ?? error;
        }
      };

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'compact-relay',
            inject: (sessionId) => ({
              sessionId,
              waitAndOpen: openChildSession,
            }),
          },
          CompactRelayIndicator,
        ),
      );

      // /handoff 命令卡：成功后自动切换（key 必须等于命令名）。
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.commandview',
            key: 'handoff',
            inject: () => ({ waitAndOpen: openChildSession }),
          },
          HandoffCard,
        ),
      );

      // 设置栏：官方「设置」左侧新增一节「压缩接力」（第三方插件走 settings.section）。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'compact-relay',
            order: 110,
            label: () => '压缩接力',
          },
          CompactRelaySettings,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
