/**
 * dsh-compact-relay —— 浏览器半（DSH client bundle）。
 *
 * 职责：输入框左侧指示灯 / 悬停卡 / 菜单 / 压缩确认卡 / 交接单面板 / toast，
 *       输入框上方接力条（0.5.0：已接力自 … + 下拉菜单），
 *       以及 /handoff 命令卡（命令成功后自动切到新会话）。
 * 数据：GET /api/compact-relay-state、SSE /api/compact-relay-stream、
 *       GET /api/compact-relay-chain（0.5.1 DCR-05 整条接力链，一次读取）；
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
     * 复制文本到剪贴板（0.5.6 A）——形态照抄 30-indicator 的「复制路径」与
     * 50-settings 的 copyDiagnostics：navigator.clipboard?.writeText + Promise 兜底。
     * @param {string} text
     * @returns {Promise<void>}
     */
    function copyTextToClipboard(text) {
      try {
        const written = navigator.clipboard?.writeText(String(text));
        return written !== undefined && typeof written.then === 'function' ? written : Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }

    /**
     * 失败响应的「复制诊断」文本（0.5.6 A3）——服务端已经脱敏（failure = exportRowOf），
     * 客户端只拼装，不额外读任何本机数据。
     * @param {object} data POST /api/compact-relay-action 的响应 body
     * @returns {string}
     */
    function failureClipboardTextOf(data) {
      const failure =
        data !== null && typeof data === 'object' && data.failure !== null && typeof data.failure === 'object'
          ? data.failure
          : null;
      const code = failure !== null && typeof failure.code === 'string' ? failure.code : data?.code ?? 'internal';
      const message =
        failure !== null && typeof failure.message === 'string'
          ? failure.message
          : data !== null && typeof data === 'object' && typeof data.message === 'string'
            ? data.message
            : '（服务端未给出）';
      const action = failure !== null && typeof failure.action === 'string' ? failure.action : '未知动作';
      const lines = [`[dcr] ${action} 失败`, `code: ${code}`, `message: ${message}`];
      if (failure !== null) {
        const id = typeof failure.id === 'string' ? failure.id : typeof data?.failureId === 'string' ? data.failureId : '?';
        if (typeof failure.at === 'string') lines.push(`at: ${failure.at}  id: ${id}`);
        if (typeof failure.trigger === 'string') lines.push(`trigger: ${failure.trigger}`);
        if (typeof failure.sessionId === 'string' && failure.sessionId.length > 0) lines.push(`session: ${failure.sessionId}`);
        if (failure.context !== null && typeof failure.context === 'object' && typeof failure.context.note === 'string') {
          lines.push(`context: ${failure.context.note}`);
        }
        if (typeof failure.durationMs === 'number' && Number.isFinite(failure.durationMs)) {
          lines.push(`duration: ${failure.durationMs}ms  outcome: ${failure.outcome ?? 'fail'}`);
        }
      }
      lines.push('记录文件：$DSH_HOME/compact-relay-events.jsonl');
      return lines.join('\n');
    }

    /**
     * 失败 toast 的入参：响应里带 failureId/failure 时升级成「带复制按钮」的对象形态，
     * 否则保持纯字符串（与旧行为逐字一致）。
     * @param {string} text
     * @param {object} data
     * @returns {string|{text:string, copy:string}}
     */
    function withFailureCopy(text, data) {
      const hasFailure =
        data !== null &&
        typeof data === 'object' &&
        (typeof data.failureId === 'string' || (data.failure !== null && typeof data.failure === 'object'));
      return hasFailure ? { text, copy: failureClipboardTextOf(data) } : text;
    }

    /* ------------------------------------------------------------------ *
     * 0.5.7 长动作异步化（架构 §6）：job 轮询 + 客户端错误留档
     *
     * 服务端把 >3s 的动作拆成三个短动作（job-start / job-status / job-cancel）；
     * 兼容层 15s 没跑完会回 202 ok:false,code:'pending',pending:true,jobId。
     * 客户端从不把 pending 当成功：拿到 jobId 后一律轮询到 done/error/cancelled。
     * ------------------------------------------------------------------ */

    /** 轮询间隔（架构 §6）：0ms 首轮 + 500ms，总时长上限 5min。 */
    const JOB_POLL_INTERVAL_MS = 500;
    const JOB_POLL_MAX_MS = 5 * 60_000;
    /** client-error 的 bodyHead 上限 = 事件 context 值上限（80 码点）。 */
    const CLIENT_ERROR_BODY_HEAD_MAX_CHARS = 80;

    /** 按码点截断（不切坏 emoji）；上限非法时回落到 bodyHead 的 80。 */
    function clipCodePoints(text, max) {
      const value = typeof text === 'string' ? text : '';
      const limit = Number.isInteger(max) && max > 0 ? max : CLIENT_ERROR_BODY_HEAD_MAX_CHARS;
      // 快速路径：码元数 ≤ 上限时码点数必然也 ≤ 上限。
      if (value.length <= limit) return value;
      return Array.from(value).slice(0, limit).join('');
    }

    /** 动作/轮询失败：带 code/status 的 Error（run() 的 catch 按 code 分流）。 */
    function jobFailure(code, message, status) {
      const error = new Error(typeof message === 'string' && message.length > 0 ? message : '任务失败');
      error.code = typeof code === 'string' && code.length > 0 ? code : 'job';
      if (Number.isInteger(status)) error.status = status;
      return error;
    }

    /** 本地取消：抛 name='AbortError'（沿用 0.5.6 的取消判定，不新增错误出口）。 */
    function jobAbortError() {
      const error = new Error('已取消');
      error.name = 'AbortError';
      return error;
    }

    function jobSignalAborted(signal) {
      return signal !== null && typeof signal === 'object' && signal.aborted === true;
    }

    /** 可被 abort 打断的等待（不残留 timer；signal 在测试替身里可能不存在）。 */
    function waitForJobPoll(ms, signal) {
      return new Promise((resolve, reject) => {
        let timer = null;
        const onAbort = () => {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          reject(jobAbortError());
        };
        if (signal !== null && typeof signal === 'object' && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true });
        }
        timer = setTimeout(() => {
          if (signal !== null && typeof signal === 'object' && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        }, ms);
      });
    }

    /**
     * 读 action 响应：优先取原文（client-error 的 bodyHead 用前 80 码点），
     * 测试替身只有 json() 时回退；两者都失败 → {data:null, bodyHead:''}。
     * @param {object} res fetch 的 Response（或测试替身）
     * @returns {Promise<{data:any, bodyHead:string}>}
     */
    async function readActionBody(res) {
      if (res !== null && res !== undefined && typeof res === 'object' && typeof res.text === 'function') {
        let text = '';
        try {
          text = await res.text();
        } catch {
          text = '';
        }
        if (typeof text === 'string' && text.length > 0) {
          try {
            return { data: JSON.parse(text), bodyHead: text };
          } catch {
            return { data: null, bodyHead: text };
          }
        }
        return { data: null, bodyHead: '' };
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      let bodyHead = '';
      if (data !== null && typeof data === 'object') {
        try {
          bodyHead = JSON.stringify(data);
        } catch {
          bodyHead = '';
        }
      }
      return { data, bodyHead };
    }

    /**
     * 轮询一个 job 到终态（架构 §6：0ms 首轮 + 500ms + 5min 上限）。
     *
     *   - done                → 返回 job 的 result（旧同步动作的成功响应体，逐字段不变）
     *   - error / cancelled   → 抛 {code:'cancelled'|…, message, status}
     *   - 404 nojob           → 抛 code:'nojob'（宿主重启会清空内存任务表，调用方提示重试）
     *   - 5min 未结束         → 抛 code:'timeout'
     *
     * 0ms 首轮是刻意的：刚起/已结束的任务（以及测试 mock 的首轮 done）立即命中，
     * 调用方不用先等一个 500ms。onTick 每轮带 elapsedMs 回调，进度 toast 只显示「已 Ns」。
     *
     * @param {string} jobId
     * @param {{signal?:object, onTick?:(tick:{elapsedMs:number,status:string})=>void}} [options]
     * @returns {Promise<any>}
     */
    async function pollJob(jobId, options = {}) {
      const signal = options.signal;
      const onTick = typeof options.onTick === 'function' ? options.onTick : null;
      const startedAt = Date.now();
      let wait = 0;
      for (;;) {
        if (jobSignalAborted(signal)) throw jobAbortError();
        if (Date.now() - startedAt > JOB_POLL_MAX_MS) {
          throw jobFailure('timeout', '任务超过 5 分钟仍未结束（可稍后在事件记录里查看结果）', 0);
        }
        if (wait > 0) await waitForJobPoll(wait, signal);
        if (jobSignalAborted(signal)) throw jobAbortError();
        let res = null;
        try {
          res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'job-status', jobId }),
            ...(signal === undefined || signal === null ? {} : { signal }),
          });
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.name === 'AbortError') throw error;
          throw jobFailure('network', '读取任务状态失败：' + (error && error.message ? String(error.message) : '未知错误'), 0);
        }
        const { data, bodyHead } = await readActionBody(res);
        if (res.status === 404 && data !== null && typeof data === 'object' && data.code === 'nojob') {
          const nojob = jobFailure('nojob', data.message ? String(data.message) : '任务不存在或已过期，请重试', 404);
          nojob.bodyHead = bodyHead;
          throw nojob;
        }
        if (!res.ok) {
          const failure = jobFailure(
            data !== null && typeof data === 'object' && typeof data.code === 'string' ? data.code : 'http',
            data !== null && typeof data === 'object' && typeof data.message === 'string'
              ? data.message
              : `读取任务状态失败（HTTP ${res.status}）`,
            res.status,
          );
          failure.bodyHead = bodyHead;
          throw failure;
        }
        if (data === null || typeof data !== 'object') {
          const empty = jobFailure('empty', '任务状态响应为空', res.status);
          empty.bodyHead = bodyHead;
          throw empty;
        }
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        if (onTick !== null) onTick({ elapsedMs, status: typeof data.status === 'string' ? data.status : 'running' });
        if (data.status === 'done') return data.result;
        if (data.status === 'cancelled') {
          const cancelled = jobFailure(
            'cancelled',
            data.error !== null && typeof data.error === 'object' && typeof data.error.message === 'string'
              ? data.error.message
              : '任务已取消',
            res.status,
          );
          throw cancelled;
        }
        if (data.status === 'error') {
          const failure = jobFailure(
            data.error !== null && typeof data.error === 'object' && typeof data.error.code === 'string'
              ? data.error.code
              : 'job',
            data.error !== null && typeof data.error === 'object' && typeof data.error.message === 'string'
              ? data.error.message
              : '任务失败',
            res.status,
          );
          throw failure;
        }
        // running（或未知状态）：继续轮询，间隔 500ms。
        wait = JOB_POLL_INTERVAL_MS;
      }
    }

    /** 同一次失败只 report 一次：调用方每次操作给一个 token（对象身份）。 */
    const reportedClientErrors = typeof WeakSet === 'function' ? new WeakSet() : null;

    /**
     * 客户端错误留档（0.5.7，B 级动作 client-error）。
     * 只上报传输/渲染侧失败（fetch 抛错 / 非 2xx / 空 body / 404 nojob / 超时），
     * bodyHead 先按码点 clip 到 80（服务端 context 上限），同一次失败只报一次。
     * 永不 reject——上报失败不影响主流程。
     *
     * @param {{kind?:string,status?:number,bodyHead?:string,code?:string,message?:string,sessionId?:string,token?:object}} [details]
     * @returns {Promise<boolean>} 是否真的发出并拿到 2xx
     */
    function reportClientError(details = {}) {
      const source = details !== null && typeof details === 'object' ? details : {};
      const token = source.token;
      if (token !== null && typeof token === 'object' && reportedClientErrors !== null) {
        if (reportedClientErrors.has(token)) return Promise.resolve(false);
        reportedClientErrors.add(token);
      }
      const body = {
        action: 'client-error',
        kind: typeof source.kind === 'string' && source.kind.trim().length > 0 ? clipCodePoints(source.kind.trim(), 40) : 'unknown',
      };
      if (Number.isInteger(source.status) && source.status >= 0) body.status = source.status;
      if (typeof source.bodyHead === 'string' && source.bodyHead.length > 0) {
        body.bodyHead = clipCodePoints(source.bodyHead, CLIENT_ERROR_BODY_HEAD_MAX_CHARS);
      }
      if (typeof source.code === 'string' && source.code.length > 0) body.code = clipCodePoints(source.code, 60);
      if (typeof source.message === 'string' && source.message.length > 0) body.message = source.message.slice(0, 500);
      if (typeof source.sessionId === 'string' && source.sessionId.length > 0) body.sessionId = source.sessionId;
      try {
        return fetch('/api/compact-relay-action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(
          (res) => res !== null && typeof res === 'object' && res.ok === true,
          () => false,
        );
      } catch {
        return Promise.resolve(false);
      }
    }

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
    function parseInlineLite(text) {
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
    function parseMarkdownLite(text) {
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
    /**
     * 交接线保命判定 —— 纯函数，零依赖（0.4.2）。
     *
     * 背景（0.4.1 遗留的三个洞，见 docs/0.4.2-implementation-plan.md）：
     * 1. 交接提醒线仍是配置值（默认 60%），换到实际触发线更低的模型（如 55%）时，
     *    DSH 会先自己压历史，dcr 的交接提醒来不及；
     * 2. 服务端保存校验只看配置阈值（80%），手改设置文件能设到 70%；
     * 3. 旧值不跟随当前模型，除设置页一行 warning 外没有其它可见提示。
     *
     * 0.4.2 规则（范围定稿）：
     *   交接提醒线 ≤ 实际触发线 − 5pp（HANDOFF_MARGIN_PP），向下取整到整数百分位。
     *   - 实际触发线来自 state.native.ratio（按当前路由模型实时算，见 core/native-line.js）；
     *   - 实际线算不出时：运行时不告警、不阻断；服务端保存退回配置阈值防呆（0.4.1 行为）；
     *   - DSH 原生自动压缩关闭时不存在「被抢先压缩」的截止线，不判定；
     *   - 只告警 / 拒绝，绝不静默改写用户配置。
     *
     * 本模块只做判定与文案，不做 IO：服务端 `lib/actions/settings.js` 直接 import，
     * 客户端由 `scripts/build-client.mjs` 的 `/* @inline core/handoff-guard.js *\/`
     * 内联进 `lib/client.js`（同一份判定，避免 UI 与后台两套口径）。
     */

    /** 交接线相对实际触发线至少留 5 个百分点（1M 窗口 ≈ 50K tokens 缓冲）。 */
    const HANDOFF_MARGIN_PP = 5;

    /** 实际线算不出、退回配置阈值防呆时的余量（0.4.1 口径：最高 = 配置阈值 −1pp）。 */
    const FALLBACK_MARGIN_PP = 1;

    /** cap 的绝对上限（避免算出 96%+ 这种没有意义的上限）。 */
    const HANDOFF_LIMIT_DEFAULT = 0.95;

    const EPS = 1e-9;

    /**
     * 合法窗口比例：必须是 0<r<1 的有限数。
     * @param {unknown} value
     * @returns {number|null}
     */
    function ratioOf(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1 ? value : null;
    }

    /**
     * 比例 → 百分数数字（一位小数，整数不带小数）：0.678 → 67.8，0.62 → 62。
     * @param {number|null} ratio
     * @returns {number|null}
     */
    function percentOf(ratio) {
      if (ratio === null) return null;
      const percent = ratio * 100;
      return Math.abs(percent - Math.round(percent)) < 0.05 ? Math.round(percent) : Number(percent.toFixed(1));
    }

    /**
     * 比例 → 百分数文本（用于文案）：0.678 → '67.8'，0.62 → '62'。
     * @param {number|null} ratio
     * @returns {string}
     */
    function percentText(ratio) {
      if (ratio === null) return '';
      const percent = ratio * 100;
      return Math.abs(percent - Math.round(percent)) < 0.05 ? String(Math.round(percent)) : percent.toFixed(1);
    }

    /**
     * 只算交接线上限：参考线 − marginPp，向下取整到整数百分位，再夹到 limit。
     *
     * 浮点安全：`0.62 − 0.05` 在二进制里可能是 0.5700000000000001 / 0.5699999999999999，
     * 直接 floor 会把 57 变成 56，所以加 EPS 再 floor。
     *
     * @param {number|null} referenceRatio 参考线（实际触发线或配置阈值），非法时返回 null
     * @param {{marginPp?:number, limit?:number}} [options]
     * @returns {number|null} 例如 0.62；参考线太小（减完 ≤0）时返回 null
     */
    function handoffCapOf(referenceRatio, { marginPp = HANDOFF_MARGIN_PP, limit = HANDOFF_LIMIT_DEFAULT } = {}) {
      const reference = ratioOf(referenceRatio);
      if (reference === null) return null;
      const margin = (Number.isFinite(marginPp) ? marginPp : HANDOFF_MARGIN_PP) / 100;
      const max = Number.isFinite(limit) && limit > 0 && limit < 1 ? limit : HANDOFF_LIMIT_DEFAULT;
      // 向下取整到整数百分位（例如 62.8 → 0.62），不是四舍五入。
      const cap = Math.floor((reference - margin) * 100 + EPS) / 100;
      if (!(cap > 0)) return null;
      return Math.min(cap, max);
    }

    /** 「重算目标 ≤ 压缩线」时的补充提示（保持「交接线 > 压缩线」现有约束）。 */
    function compactConflictText(capPercent, compactRatio) {
      return `按实际线重算目标 ${capPercent}% 不高于压缩线 ${percentText(compactRatio)}%，请先把压缩线降到 ${capPercent}% 以下。`;
    }

    /**
     * 判定「当前交接线是否会在 DSH 原生压缩之后」。
     *
     * @param {object} [input]
     * @param {number|null} [input.actualRatio] 当前模型实际触发线（state.native.ratio）；算不出/关闭时 null
     * @param {number|null} [input.configuredRatio] 配置阈值（native.thresholdRatio），兜底用
     * @param {number|null} [input.handoffRatio] 当前交接提醒线（thresholds.handoffRatio）
     * @param {number|null} [input.compactRatio] 压缩提醒线（thresholds.compactRatio），判重算冲突
     * @param {boolean} [input.autoEnabled] DSH 原生自动压缩是否开启（false → 不判定，交接线无截止线）
     * @param {number} [input.limit] cap 绝对上限，默认 0.95
     * @param {'none'|'configured'} [input.fallback]
     *   'none'（运行时默认）：实际线算不出就不判定（不告警、不阻断）；
     *   'configured'（服务端保存默认）：实际线算不出时按配置阈值 −1pp 防呆（0.4.1 行为）。
     * @returns {{
     *   source:'actual'|'configured'|null,
     *   actualRatio:number|null, actualPercent:number|null,
     *   configuredRatio:number|null, configuredPercent:number|null,
     *   handoffRatio:number|null, handoffPercent:number|null,
     *   compactRatio:number|null, compactPercent:number|null,
     *   cap:number|null, capPercent:number|null,
     *   ok:boolean, severity:'ok'|'warn'|'late'|'unknown',
     *   reason:'ok'|'late'|'margin'|'fallback'|'no-reference'|'invalid-handoff'|'no-cap',
     *   message:string, target:number|null, compactConflict:boolean
     * }}
     */
    function handoffGuard({
      actualRatio = null,
      configuredRatio = null,
      handoffRatio = null,
      compactRatio = null,
      autoEnabled = true,
      limit = HANDOFF_LIMIT_DEFAULT,
      fallback = 'none',
    } = {}) {
      const actual = ratioOf(actualRatio);
      const configured = ratioOf(configuredRatio);
      const handoff = ratioOf(handoffRatio);
      const compact = ratioOf(compactRatio);
      const neutral = {
        source: null,
        actualRatio: actual,
        actualPercent: percentOf(actual),
        configuredRatio: configured,
        configuredPercent: percentOf(configured),
        handoffRatio: handoff,
        handoffPercent: percentOf(handoff),
        compactRatio: compact,
        compactPercent: percentOf(compact),
        cap: null,
        capPercent: null,
        ok: true,
        severity: 'unknown',
        reason: 'no-reference',
        message: '',
        target: null,
        compactConflict: false,
      };
      // 原生自动压缩关着：DSH 不会自己压，不存在「提醒来不及」的截止线。
      if (autoEnabled === false) return neutral;

      /** 带 cap 的结果骨架（cap 已是整数百分位，×100 即整数）。 */
      const withCap = (source, cap) => {
        const capPercent = cap === null ? null : Math.round(cap * 100);
        return {
          ...neutral,
          source,
          cap,
          capPercent,
          target: source === 'actual' ? cap : null,
          compactConflict: cap !== null && compact !== null && cap <= compact + EPS,
        };
      };

      // 1) 实际触发线可用：唯一口径（−5pp），不再叠加「配置阈值 −1pp」。
      if (actual !== null) {
        const cap = handoffCapOf(actual, { limit });
        if (cap === null) return { ...withCap('actual', null), reason: 'no-cap' };
        const base = withCap('actual', cap);
        if (handoff === null) return { ...base, reason: 'invalid-handoff' };
        const conflict = base.compactConflict ? compactConflictText(base.capPercent, compact) : '';
        // 等于实际触发线也算「晚」：DSH 会在同一位置自己压历史，提醒来不及。
        if (handoff > actual - EPS) {
          return {
            ...base,
            ok: false,
            severity: 'late',
            reason: 'late',
            message:
              `交接线已晚：当前模型实际触发 ${percentText(actual)}%，交接线 ${percentText(handoff)}% 会在原生压缩之后` +
              `（DSH 会先压历史）；最高可设 ${base.capPercent}%。${conflict}`,
          };
        }
        if (handoff > cap + EPS) {
          return {
            ...base,
            ok: false,
            severity: 'warn',
            reason: 'margin',
            message:
              `交接线偏晚：当前模型实际触发 ${percentText(actual)}%，交接线 ${percentText(handoff)}% ` +
              `距原生压缩不足 ${HANDOFF_MARGIN_PP} 个百分点；最高可设 ${base.capPercent}%。${conflict}`,
          };
        }
        return { ...base, ok: true, severity: 'ok', reason: 'ok' };
      }

      // 2) 实际线算不出 + 服务端保存：退回配置阈值防呆（0.4.1 行为，兼容旧客户端）。
      if (fallback === 'configured' && configured !== null) {
        const cap = handoffCapOf(configured, { marginPp: FALLBACK_MARGIN_PP, limit });
        if (cap === null) return { ...withCap('configured', null), reason: 'no-cap' };
        const base = withCap('configured', cap);
        if (handoff === null) return { ...base, reason: 'invalid-handoff' };
        if (handoff > cap + EPS) {
          return {
            ...base,
            ok: false,
            severity: 'warn',
            reason: 'fallback',
            message:
              `「交接提醒线」必须低于 DSH 原生自动压缩线（配置阈值 ${percentText(configured)}%），` +
              `否则原生压缩会先动手；最高只能设到 ${base.capPercent}%。` +
              '想设更高请先在设置里关闭「DSH 原生自动压缩」。',
          };
        }
        return { ...base, ok: true, severity: 'ok', reason: 'ok' };
      }

      // 3) 运行时且算不出：不告警、不阻断。
      return neutral;
    }
    /**
     * 压缩归属的**展示文案**（0.5.6 Phase D2）—— 纯函数、零依赖、零 IO。
     *
     * 为什么单独一层：同一条归属要出现在三处（checkpoint 摘要头、完成 toast/命令卡、
     * 悬停卡与「查看上次压缩」面板），服务端与浏览器半必须用同一份措辞；浏览器半
     * 通过 `scripts/build-client.mjs` 的 `/* @inline *\/` 内联本模块，所以这里：
     *   1. 不许 import（内联会把 import 行原样带进 bundle）；
     *   2. 不许碰 Node API / 时钟 / 随机（内联后浏览器要能直接跑）。
     *
     * 口径（总计划 D2 / task-3 §3.4，冻结）：
     *   trigger：ui-menu→菜单压缩、ui-ring→环压缩、command→命令压缩、handoff→交接压缩、
     *            native-auto→DSH 原生自动、external/unknown/其他→来源不明；
     *   actor：  user→用户、system→系统、unknown/其他→不明。
     *
     * 红线：这里**只做措辞映射**，不做任何推断。trigger 缺失/非法一律「来源不明」，
     * 绝不根据 `turn`/`summaries`/时间等旁证猜测触发者（task-3 §1 第 5 条）。
     */

    /** 没有任何归属记录时的统一文案（历史压缩/老 checkpoint）；不猜、不暗示。 */
    const NO_ATTRIBUTION_LABEL = '来源不明（无归属记录）';

    /** trigger → 中文名（冻结；改这里等于改用户可见文案）。 */
    const TRIGGER_LABELS = Object.freeze({
      'ui-menu': '菜单压缩',
      'ui-ring': '环压缩',
      command: '命令压缩',
      handoff: '交接压缩',
      'native-auto': 'DSH 原生自动',
      external: '来源不明',
      unknown: '来源不明',
    });

    /** actor → 中文名（冻结）。 */
    const ACTOR_LABELS = Object.freeze({
      user: '用户',
      system: '系统',
      unknown: '不明',
    });

    /** merged（是否合并了旧摘要）→ 中文名；null = 不知道。 */
    const MERGED_LABELS = Object.freeze({
      merged: '已合并旧摘要',
      plain: '未合并旧摘要',
      unknown: '合并情况未知',
    });

    /** trigger 归一成已知键；缺失/非法 → 'unknown'（不猜）。 */
    function normalizeTriggerKey(trigger) {
      const key = typeof trigger === 'string' ? trigger.trim().toLowerCase() : '';
      return Object.prototype.hasOwnProperty.call(TRIGGER_LABELS, key) ? key : 'unknown';
    }

    /** trigger 的中文名；未知 → 「来源不明」。 */
    function triggerLabelOf(trigger) {
      return TRIGGER_LABELS[normalizeTriggerKey(trigger)];
    }

    /** actor 的中文名；缺失/非法 → 「不明」。 */
    function actorLabelOf(actor) {
      const key = typeof actor === 'string' ? actor.trim().toLowerCase() : '';
      return Object.prototype.hasOwnProperty.call(ACTOR_LABELS, key) ? ACTOR_LABELS[key] : ACTOR_LABELS.unknown;
    }

    /**
     * 一行归属的括注：`菜单压缩（用户）`。
     * @param {{trigger?:unknown, actor?:unknown}|null} row
     */
    function attributionLabelOf(row) {
      const source = row !== null && typeof row === 'object' ? row : {};
      return `${triggerLabelOf(source.trigger)}（${actorLabelOf(source.actor)}）`;
    }

    /** 归属行 or（无记录时）统一文案；绝不返回任何猜出来的触发者。 */
    function attributionLabelOrNoRecord(row) {
      return row === null || row === undefined ? NO_ATTRIBUTION_LABEL : attributionLabelOf(row);
    }

    /** compactionId 的前 8 位（checkpoint 行/调试位用）；无 id → null。 */
    function compactionIdShort(compactionId) {
      if (typeof compactionId !== 'string') return null;
      const text = compactionId.trim();
      if (text.length === 0) return null;
      return text.slice(0, 8);
    }

    /**
     * token 的短写法：`32.5k` / `900`。
     * 与客户端 `fmt`（32.5K）刻意不同：这里出现在给模型读的 checkpoint 行与悬停卡，
     * 统一小写 k，避免同一数字两处写法不一致。
     * @param {unknown} tokens
     * @returns {string|null} 不是有限数字 → null（调用方显示「未知」，不显示 0）
     */
    function tokensShortOf(tokens) {
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return null;
      if (tokens < 1000) return String(Math.round(tokens));
      const thousands = Math.round(tokens / 100) / 10;
      return `${Number.isInteger(thousands) ? thousands.toFixed(1) : String(thousands)}k`;
    }

    /** merged → 中文名（null/缺失 = 不知道）。 */
    function mergedLabelOf(merged) {
      if (merged === true) return MERGED_LABELS.merged;
      if (merged === false) return MERGED_LABELS.plain;
      return MERGED_LABELS.unknown;
    }

    function countSegmentOf(range) {
      const count = range !== null && typeof range === 'object' ? range.count : null;
      return typeof count === 'number' && Number.isFinite(count) && count >= 0
        ? `${Math.round(count)} 条`
        : '条数未知';
    }

    function tokensSegmentOf(range) {
      const tokens = range !== null && typeof range === 'object' ? range.tokens : null;
      const short = tokensShortOf(tokens);
      return short === null ? 'token 未知' : `${short} tokens`;
    }

    /**
     * checkpoint 摘要头的那一行（**只写不解析**）：
     *   〔压缩归属：菜单压缩·用户｜22 条｜32.5k tokens｜未合并旧摘要｜#a1b2c3d4〕
     *
     * 缺字段时用「未知」占位，绝不填 0 或猜一个值；整行永不为空（至少含来源与角色）。
     * @param {object|null} row 内存中的归属对象（compactionId/trigger/actor/range/merged）
     * @returns {string}
     */
    function attributionLineOf(row) {
      const source = row !== null && typeof row === 'object' ? row : {};
      const segments = [
        `${triggerLabelOf(source.trigger)}·${actorLabelOf(source.actor)}`,
        countSegmentOf(source.range),
        tokensSegmentOf(source.range),
        mergedLabelOf(source.merged),
      ];
      const short = compactionIdShort(source.compactionId);
      if (short !== null) segments.push(`#${short}`);
      return `〔压缩归属：${segments.join('｜')}〕`;
    }

    /**
     * 0.5.6-D2：压缩归属的界面侧派生（纯函数，唯一数据源 = state.lastCompaction）。
     *
     * 服务端 `readState.lastCompaction` 的形状是冻结的（core/attribution.ATTRIBUTION_ROW_KEYS），
     * 这里只做白名单投影：类型不对/缺键 → null（不知道），绝不根据 summaries、时间、
     * 事件顺序等旁证猜一个触发者。
     */

    /** 毫秒 → 本地 `HH:MM`；时间不可用 → ''（不显示假时间）。 */
    const attributionClockOf = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      const d = new Date(ms);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    };

    /**
     * state.lastCompaction → 界面用的小对象；不是对象 → null。
     * @param {unknown} row 服务端下发的归属行
     */
    const lastCompactionViewOf = (row) => {
      if (row === null || row === undefined || typeof row !== 'object' || Array.isArray(row)) return null;
      const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
      const range = row.range !== null && typeof row.range === 'object' ? row.range : {};
      const at = typeof row.at === 'string' && row.at.length > 0 ? row.at : null;
      const atMs = at === null ? NaN : Date.parse(at);
      return {
        compactionId: typeof row.compactionId === 'string' && row.compactionId.length > 0 ? row.compactionId : null,
        // 存归一后的枚举（不是中文名）：渲染时再查文案，口径与检查/投影一致。
        trigger: normalizeTriggerKey(row.trigger),
        actor: typeof row.actor === 'string' && row.actor.length > 0 ? row.actor.toLowerCase() : 'unknown',
        at,
        atMs: Number.isFinite(atMs) ? atMs : null,
        count: num(range.count),
        tokens: num(range.tokens),
        merged: typeof row.merged === 'boolean' ? row.merged : null,
        outcome: typeof row.outcome === 'string' && row.outcome.length > 0 ? row.outcome : null,
      };
    };

    /** 悬停卡一行：`上次压缩：菜单压缩·用户 · 22 条 / 32.5k · 15:40`。 */
    const lastCompactionTextOf = (view) => {
      if (view === null) return '';
      const head = `${triggerLabelOf(view.trigger)}·${actorLabelOf(view.actor)}`;
      const count = view.count === null ? '条数未知' : `${Math.round(view.count)} 条`;
      const tokens = tokensShortOf(view.tokens);
      const parts = [head, tokens === null ? count : `${count} / ${tokens}`];
      const clock = attributionClockOf(view.atMs);
      if (clock !== '') parts.push(clock);
      return `上次压缩：${parts.join(' · ')}`;
    };

    /**
     * 「查看上次压缩」面板里每条压缩的归属行。
     *
     * 只有 compactionId **完全相同**才认（服务端只下发最近一条归属，历史条目不猜）；
     * 其余一律「来源不明（无归属记录）」。
     * @param {object} entry 压缩历史条目（含 compactionId|null）
     * @param {object|null} lastView state.lastCompaction 的投影
     */
    const diffAttributionOf = (entry, lastView) => {
      const id =
        entry !== null && typeof entry === 'object' && typeof entry.compactionId === 'string' && entry.compactionId.length > 0
          ? entry.compactionId
          : null;
      if (id !== null && lastView !== null && lastView.compactionId === id) {
        return { text: `归属：${attributionLabelOf(lastView)}`, trigger: lastView.trigger };
      }
      return { text: `归属：${NO_ATTRIBUTION_LABEL}`, trigger: 'unknown' };
    };

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

    /**
     * 0.4.1：原生自动压缩线「配置阈值 vs 实际触发线」。
     * DSH 按 token 预算触发：min(窗口×配置阈值, 窗口−输出预留−余量)，
     * 所以实际触发点常比配置比例更早（deepseek-flash 配置 80%、实际 67.85%）。
     * autoEnabled=false 时 effective/percentText 为空（未开启），但 actualText 仍给出
     * 「开启后实际会触发多少」，供关闭态文案使用。
     * @param {object|null} native readState 下发的 native 字段
     * @returns {{configured:number|null,configuredText:string|null,actual:number|null,actualText:string,effective:number|null,percentText:string,differs:boolean,autoOff:boolean,why:string}}
     */
    const nativeLineInfo = (native) => {
      const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
      const ratioOf = (value) => {
        const n = num(value);
        return n !== null && n > 0 && n < 1 ? n : null;
      };
      const src = native === null || native === undefined ? null : native;
      const configured = ratioOf(src === null ? null : src.thresholdRatio);
      const actual = ratioOf(src === null ? null : src.ratio);
      const autoOff = src !== null && src.autoEnabled === false;
      const effective = autoOff ? null : actual !== null ? actual : configured;
      const pctText = (value) => {
        const p = value * 100;
        return Math.abs(p - Math.round(p)) < 0.05 ? String(Math.round(p)) : p.toFixed(1);
      };
      const configuredText = configured === null ? null : pctText(configured);
      const actualText = actual === null ? '' : pctText(actual);
      const percentText = effective === null ? '' : pctText(effective);
      const differs = configured !== null && effective !== null && Math.abs(effective - configured) >= 0.005;
      let why = '';
      if (differs) {
        const overridden = src.overridden === true;
        const windowTokens = num(src.contextWindow);
        const reserved = num(src.reservedCompletionTokens);
        const headroom = num(src.headroomTokens);
        // 只有「预算分支确实更小」时，才能把差异归因为输出预留/余量。
        const budgetTokens = windowTokens !== null ? windowTokens - (reserved ?? 0) - (headroom ?? 0) : null;
        const budgetBinding = budgetTokens !== null && configured !== null && budgetTokens < windowTokens * configured;
        const parts = [];
        if (reserved !== null && reserved > 0) parts.push(`模型输出要预留 ${fmt(reserved)}`);
        if (headroom !== null && headroom > 0) parts.push(`DSH 自己还要留 ${fmt(headroom)} 余量`);
        if (overridden) {
          why = `这个模型单独配了阈值（按路由覆盖），实际触发是 ${actualText}%（全局配置 ${configuredText}%）。`;
        } else if (budgetBinding && parts.length > 0) {
          why = `配置阈值 ${configuredText}% 只是理论上限；${parts.join('、')}，所以实际打到 ${percentText}% 就会自动压。`;
        } else if (actual !== null && configured !== null && actual > configured) {
          why = `这个路由的输出预留更小，实际触发晚于配置阈值 ${configuredText}%（实际 ${actualText}%）。`;
        } else {
          why = `实际触发 ${actualText}% 与配置阈值 ${configuredText}% 不同，按宿主 token 预算算的。`;
        }
      }
      return { configured, configuredText, actual, actualText, effective, percentText, differs, autoOff, why };
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
      const [state, setState] = useState({
        advice: 'none',
        pressure: null,
        window: null,
        summaries: 0,
        colors: null,
        compactRange: undefined,
        busy: false,
        // 0.5.1 批 2：stale = 被压缩带走的 pin（失效标注）；atRisk = 下一次原生压缩会覆盖的 pin。
        pins: { count: 0, seqs: [], marks: [], stale: { count: 0, seqs: [], native: 0, other: 0, unknown: 0 }, atRisk: null },
        compressHint: null,
        native: null,
        sessionPinned: null,
        // 0.5.6-C：服务端链号（只读诊断位 data-cr-chain 用；null = 还没有帧/没有链）。
        chainOrdinal: null,
        // 0.5.6-D2：最近一次压缩归属（服务端投影；null = 没有归属记录，不猜）。
        lastCompaction: null,
      });
      // 0.4 P2-3：原生自动压缩的「有效线」——优先真实触发线（thresholdTokens/window），
      // 老宿主/算不出时回落 thresholdRatio（窗口比例）。
      const effectiveNativeRatio = (native) => {
        if (native === null || native === undefined || native.autoEnabled === false) return null;
        if (typeof native.ratio === 'number' && Number.isFinite(native.ratio) && native.ratio > 0 && native.ratio < 1) return native.ratio;
        if (typeof native.thresholdRatio === 'number' && Number.isFinite(native.thresholdRatio) && native.thresholdRatio > 0) return native.thresholdRatio;
        return null;
      };
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
      // 0.5.7：当前长动作的 jobId（取消时发 job-cancel）；进度 toast 的秒数去重（1s 一刷）。
      const runJobRef = useRef(null);
      const previewJobRef = useRef(null);
      const progressSecondRef = useRef(-1);
      // 0.6 预览卡收藏区：只在「这张卡里点成功的收藏」记局部状态（seq → 行数据），
      // 不引入全局星标快照、不改服务端预览数据；失败提示也留在卡内。
      const [favoriteMarks, setFavoriteMarks] = useState({});
      const [favoritePendingSeq, setFavoritePendingSeq] = useState(null);
      const [favoriteError, setFavoriteError] = useState(null);
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
      /** 0.4 P2-1：交接预览里「约束 / 下一步」两段的编辑值（键=段标题；空值回落原文）。 */
      const [handoffEditValues, setHandoffEditValues] = useState({});
      // 0.5.1 批 2：交接后是否归档旧会话（默认开 = 0.5.0 行为；可取消）。
      const [archiveWanted, setArchiveWanted] = useState(true);
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
      // 0.3.7：最后一帧（SSE 帧或轮询响应）的到达时间。远程/代理链路可能让 SSE
      // 「onopen 已连上、之后却一帧都不来」地静默挂住，表现为压缩后界面不刷新
      // （Win 远程客户端实测：手动刷新才变）。帧静默超时后由兜底轮询补拉。
      const lastFrameAtRef = useRef(0);
      const fetchState = useCallback(async () => {
        if (!hasSession) return;
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (data && typeof data === 'object') {
              lastFrameAtRef.current = Date.now();
              applierRef.current(data);
            }
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
                  // 0.3.1 起下发、0.5.1 起环上不再画：锁定消息在历史里的相对位置（0–1）。
                  // 位置标记归 0.6 时间线（数据面保留，0.6 的 timeline 直接消费）。
                  marks: Array.isArray(data.pins.marks)
                    ? data.pins.marks
                        .filter((item) => item !== null && typeof item === 'object' && typeof item.ratio === 'number' && Number.isFinite(item.ratio))
                        .map((item) => ({ seq: Number.isInteger(item.seq) ? item.seq : -1, ratio: Math.max(0, Math.min(1, item.ratio)) }))
                        .slice(0, 20)
                    : [],
                  // 0.5.1 批 2（C 方案）：被压缩带走、已不在 surface 上的 pin（不假装还在，也不消失）。
                  stale:
                    data.pins.stale && typeof data.pins.stale === 'object'
                      ? {
                          count: Number(data.pins.stale.count) || 0,
                          seqs: Array.isArray(data.pins.stale.seqs) ? data.pins.stale.seqs.filter((seq) => Number.isInteger(seq)) : [],
                          native: Number(data.pins.stale.native) || 0,
                          other: Number(data.pins.stale.other) || 0,
                          unknown: Number(data.pins.stale.unknown) || 0,
                        }
                      : { count: 0, seqs: [], native: 0, other: 0, unknown: 0 },
                  // 0.5.1 批 2：原生压缩预判会覆盖的 pin（事前提示；null = 无风险）。
                  atRisk:
                    data.pins.atRisk && typeof data.pins.atRisk === 'object' && Number(data.pins.atRisk.count) > 0
                      ? {
                          count: Number(data.pins.atRisk.count) || 0,
                          seqs: Array.isArray(data.pins.atRisk.seqs) ? data.pins.atRisk.seqs.filter((seq) => Number.isInteger(seq)) : [],
                        }
                      : null,
                }
              : { count: 0, seqs: [], marks: [], stale: { count: 0, seqs: [], native: 0, other: 0, unknown: 0 }, atRisk: null },
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
                  // 0.4 P2-3：真实触发线（thresholdTokens/window）；宿主算不出时为 null。
                  ratio:
                    typeof data.native.ratio === 'number' && Number.isFinite(data.native.ratio)
                      ? Math.max(0, Math.min(1, data.native.ratio))
                      : null,
                  thresholdTokens:
                    typeof data.native.thresholdTokens === 'number' && Number.isFinite(data.native.thresholdTokens)
                      ? data.native.thresholdTokens
                      : null,
                  contextWindow:
                    typeof data.native.contextWindow === 'number' && Number.isFinite(data.native.contextWindow)
                      ? data.native.contextWindow
                      : null,
                  headroomTokens:
                    typeof data.native.headroomTokens === 'number' && Number.isFinite(data.native.headroomTokens)
                      ? data.native.headroomTokens
                      : null,
                  // 0.4.1：悬停卡解释「为什么实际触发比配置阈值早」要用到输出预留。
                  reservedCompletionTokens:
                    typeof data.native.reservedCompletionTokens === 'number' && Number.isFinite(data.native.reservedCompletionTokens)
                      ? data.native.reservedCompletionTokens
                      : null,
                  overridden: data.native.overridden === true,
                  route:
                    data.native.route && typeof data.native.route === 'object' && typeof data.native.route.model === 'string'
                      ? { provider: String(data.native.route.provider ?? ''), model: data.native.route.model }
                      : null,
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
                    // 0.5.6-B：泄压阀状态（老宿主没有 → null，界面不显示合并提示）。
                    merge:
                      data.compactRange.merge !== null && typeof data.compactRange.merge === 'object'
                        ? {
                            merges: data.compactRange.merge.merges === true,
                            normalLeft:
                              typeof data.compactRange.merge.normalLeft === 'number' && Number.isFinite(data.compactRange.merge.normalLeft)
                                ? data.compactRange.merge.normalLeft
                                : null,
                            summaries: Number(data.compactRange.merge.summaries) || 0,
                            maxSummaries: Number(data.compactRange.merge.maxSummaries) || 0,
                          }
                        : null,
                  },
          // 0.3.5：范围存在但会话没有活 agent —— 菜单据此显示「会话未激活…」而不是
          // 「暂无可压缩内容」（applyState 只保留白名单字段，新字段必须显式透传）。
          compactRangeReason: data.compactRangeReason === 'no_agent' ? 'no_agent' : null,
          // 0.5.1 批 2：本会话是否在侧栏置顶（true/false/null=宿主读不到）。
          sessionPinned: data.sessionPinned === true ? true : data.sessionPinned === false ? false : null,
          // 0.5.6-C：服务端链号（只读诊断位 data-cr-chain 用；不是界面数据）。
          // 与接力条的 data-cr-relay-chain 对齐：同一帧 state 的 chain.ordinal，
          // 0.5.6 之前指示灯完全不读 chain（grep 0 处），这里只加不改任何渲染分支。
          chainOrdinal:
            Number.isInteger(data.chain?.ordinal) && data.chain.ordinal > 0 ? data.chain.ordinal : null,
          // 0.5.6-D2：最近一次压缩归属（白名单；老宿主没有该键 → null，不猜）。
          lastCompaction: lastCompactionViewOf(data.lastCompaction),
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
          lastFrameAtRef.current = Date.now();
          // 0.3.7：刚连上先拉一次，补齐「断开期间错过的帧」（重连场景）。
          void fetchState();
        };
        source.onmessage = (event) => {
          lastFrameAtRef.current = Date.now();
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
      //  - 已就绪且 SSE 活着 → 5s 计时器只检查「帧是否静默超时」；
      //  - 0.3.7：SSE 活着但 30s 没来帧（远程/代理链路静默挂住）→ 补拉一次，
      //    修「压缩后远程客户端不刷新、要手动刷新才变」。
      useEffect(() => {
        if (!hasSession) return;
        let timer;
        let dead = false;
        const tick = () => {
          if (dead) return;
          const sseSilent = streamLiveRef.current && Date.now() - lastFrameAtRef.current > 30000;
          if (!readyRef.current || !streamLiveRef.current || sseSilent) void fetchState();
          timer = setTimeout(tick, readyRef.current ? 5000 : 1500);
        };
        tick();
        return () => {
          dead = true;
          clearTimeout(timer);
        };
      }, [fetchState, hasSession]);

      // 0.3.7：窗口重新可见 / 重新获得焦点 / 网络恢复时拉一次——覆盖「页面被挂起后
      // 计时器被节流、SSE 断流」的场景（远程客户端切走再切回来也会走到这里）。
      useEffect(() => {
        if (!hasSession) return;
        const refresh = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          void fetchState();
        };
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('focus', refresh);
        window.addEventListener('online', refresh);
        return () => {
          document.removeEventListener('visibilitychange', refresh);
          window.removeEventListener('focus', refresh);
          window.removeEventListener('online', refresh);
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
      // 0.5.1 批 2（C 方案）：失效 pin（快照里有、surface 上已被压缩带走）与原生压缩预判风险。
      const pinStale =
        pins.stale !== null && typeof pins.stale === 'object'
          ? pins.stale
          : { count: 0, seqs: [], native: 0, other: 0, unknown: 0 };
      const pinStaleCount = Number.isInteger(pinStale.count) && pinStale.count > 0 ? pinStale.count : 0;
      // 失效原因口径与 core/pin-health.staleCauseTextOf 一致（客户端只拿计数，不重读日志）。
      const staleCauseText =
        pinStale.native > 0 && pinStale.other === 0 && pinStale.unknown === 0
          ? '随原生压缩移除'
          : pinStale.native === 0 && pinStale.other > 0 && pinStale.unknown === 0
            ? '随压缩移除'
            : pinStale.native === 0 && pinStale.other === 0 && pinStale.unknown > 0
              ? '随历史变化失效'
              : '随压缩或历史变化失效';
      const staleLabel = pinStaleCount > 0 ? `已失效 ${pinStaleCount} 条（${staleCauseText}）` : '';
      const pinRisk =
        pins.atRisk !== null && typeof pins.atRisk === 'object' && Number(pins.atRisk.count) > 0
          ? { count: Number(pins.atRisk.count) || 0, seqs: Array.isArray(pins.atRisk.seqs) ? pins.atRisk.seqs : [] }
          : null;
      const pinRiskLabel = pinRisk !== null ? `原生压缩预计覆盖 ${pinRisk.count} 条锁定消息` : '';
      // 0.5.1 批 2：交接前「归档会取消置顶」确认的数据源（null=宿主读不到，不弹确认）。
      const sessionPinned = state.sessionPinned === true;
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
      /**
       * 0.4.2（P0-1）：交接线是否已晚 —— 硬上限 = 实际触发线 −5pp（与后台 save() 同一份判定）。
       * 只在宿主算出实际触发线（native.ratio）且原生自动压缩开启时判定；
       * 算不出时按范围定稿「不告警、不阻断」。
       */
      const handoffGuardInfo = handoffGuard({
        actualRatio: state.native === null ? null : state.native.ratio,
        configuredRatio: state.native === null ? null : state.native.thresholdRatio,
        handoffRatio,
        compactRatio,
        autoEnabled: state.native === null ? true : state.native.autoEnabled !== false,
      });
      const handoffLate = handoffGuardInfo.source === 'actual' && handoffGuardInfo.ok === false;
      const handoffWarnText = handoffLate
        ? `⚠ 交接线已晚：实际触发 ${handoffGuardInfo.actualPercent}%，交接线 ${handoffGuardInfo.handoffPercent}% 会在原生压缩之后（最高 ${handoffGuardInfo.capPercent}%）`
        : '';
      // DSH 原生自动压缩线（报警最高阈值）：开着时在环上画一个「径向刻度」（不是沿环的弧），
      // 用紫色 + 主题底色描边——刻意不用五级配色里的颜色，保证在任何分段颜色上都看得清。
      // 越过原生线后：整环红色闪烁（作者 2026-10-20 反馈）。
      const nativeAuto = effectiveNativeRatio(state.native);
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
      // 0.4.2（P1）：交接线已晚时，在环上「交接刻度」旁加一个小警示（径向短线 + 小点）。
      // 只加节点，不改环的分段/断点逻辑（范围定稿：A/B/C 画法不并进 0.4.2）。
      const handoffWarnNodes = [];
      if (handoffLate) {
        const tick = nativeTickAt(handoffRatio); // 复用同一套径向几何，位置换成交接线
        const warnAngle = handoffRatio * Math.PI * 2 - Math.PI / 2;
        handoffWarnNodes.push(
          h('line', {
            key: 'handoff-warn-casing',
            ...tick,
            stroke: theme.dark ? '#26262c' : '#ffffff',
            strokeWidth: 4.4,
            strokeLinecap: 'round',
            opacity: 0.92,
          }),
          h('line', {
            key: 'handoff-warn',
            ...tick,
            stroke: palette.handoff,
            strokeWidth: 2.2,
            strokeLinecap: 'round',
            'data-cr-handoff-warn': '1',
          }),
          h('circle', {
            key: 'handoff-warn-dot',
            cx: Number((10 + 9.4 * Math.cos(warnAngle)).toFixed(3)),
            cy: Number((10 + 9.4 * Math.sin(warnAngle)).toFixed(3)),
            r: 1.05,
            fill: palette.handoff,
            'data-cr-handoff-warn-dot': '1',
          }),
        );
      }
      // 平时给中心一点可见的灰点；交接时红点（外环已分段，红点强调该交接）。
      const dotColor = adviseHandoff ? palette.handoff : palette.idle;
      // 0.5.1 设计定稿（用户拍板）：环只表达容量，不再画 pin 位置块。
      // 位置标记（state.pins.marks）归 0.6 时间线：数据面仍读取（见上方状态归一化），
      // 环上不画；锁定状态只用悬停卡/菜单的「已锁定 N 条 / 已失效 M 条」表达。

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
        const nativeRatio = effectiveNativeRatio(state.native);
        const nativePart =
          nativeRatio === null
            ? 'DSH 原生自动压缩已关闭'
            : `DSH 原生自动压缩线在 ${(nativeRatio * 100).toFixed(1)}%，到那之前先压缩或交接更稳`;
        return `这是上下文指示灯：点它压缩旧会话、收藏重要回复、交接新会话。${nativePart}。环上的小缺口是我判断「该压缩」的位置（模型判断或到线自动出现）。重要的结论/路径先点星收藏，压缩时会把原文写进摘要目录和快照（DSH 原生自动压缩不认收藏，被它压走的消息建议交接前留档）。交接后会默认自动归档旧会话（侧栏收起，可取消勾选「交接后归档」；旧会话在侧栏置顶时会先问你，因为归档会取消置顶）。`;
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

      // 0.4.2（P1）：换模型后首次发现「交接线已晚」弹一次提示（同路由不重复打扰）。
      // 只在「观察到路由变化」（localStorage 记着上一次的 provider/model）时弹；
      // 首次见到某路由不弹（不是换模型导致的），设置页有常驻提示兜底。
      useEffect(() => {
        if (state.native === null || state.native.route === null) return;
        const key = `${state.native.route.provider || ''}/${state.native.route.model}`;
        let previous = null;
        try {
          previous = window.localStorage.getItem('dsh.compact-relay.route.v1');
        } catch {
          previous = null; // 隐私模式：不记、不弹，避免反复打扰
          return;
        }
        if (previous === key) return;
        try {
          window.localStorage.setItem('dsh.compact-relay.route.v1', key);
        } catch {
          /* ignore */
        }
        if (previous === null || previous === '' || !handoffLate) return;
        showToast(`已切换到 ${state.native.route.model}：${handoffWarnText.replace('⚠ ', '')}。可在「设置 → 压缩接力」一键重算。`, 10000);
      }, [state.native, handoffLate, handoffWarnText, showToast]);

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

      // M6：执行中取消。0.5.7：优先发 job-cancel（按 jobId 精确取消），没有 jobId 才回落到
      // legacy action:'cancel'（按 agent.id 取消 inflight，覆盖「客户端还没拿到 jobId」）。
      const cancelRun = useCallback(() => {
        const jobId = runJobRef.current !== null ? runJobRef.current : previewJobRef.current;
        const controller = runAbortRef.current !== null ? runAbortRef.current : handoffPreviewAbortRef.current;
        if (controller !== null) {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }
        runJobRef.current = null;
        previewJobRef.current = null;
        showToast({ text: '正在取消…（已提交的部分不会回滚）' }, 0);
        const body =
          typeof jobId === 'string' && jobId.length > 0
            ? { action: 'job-cancel', jobId }
            : { action: 'cancel', ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}) };
        void fetch('/api/compact-relay-action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => {});
      }, [sessionId, showToast]);

      // M6：预览——只算「能压哪段、多少 token」，不写历史。
      const startPreview = useCallback(async () => {
        if (effectiveBusy) return;
        setOpen(false);
        setHandoffPreview(null);
        setPreview({ loading: true });
        setFavoriteMarks({});
        setFavoritePendingSeq(null);
        setFavoriteError(null);
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        previewAbortRef.current = controller;
        try {
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'preview',
              // 0.5.6 A：归属口径（菜单/确认卡入口；环当前无生产者，保留 ui-ring 枚举不产生）。
              trigger: 'ui-menu',
              ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
            }),
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false || data.preview == null) {
            setPreview(null);
            showToast(
              data && data.message
                ? withFailureCopy(String(data.message), data)
                : '压缩预估失败：现在没有能压缩的内容',
            );
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

      /**
       * 0.5.7：统一的长动作入口——POST job-start，先判 202 pending（code==='pending' 或
       * pending:true）拿 jobId，再轮询 job-status 到终态，返回 done 的 result。
       *
       * pending 不是成功：拿不到 jobId 就按失败处理，绝不把 pending 响应当结果塞给预览/确认卡。
       * 失败抛 {code,message,status}；fetch 抛错 / 非 2xx / 空 body / nojob / 超时
       * 各上报一次 client-error（同一次失败只报一次，token 去重）。
       *
       * @param {object} body 至少含 kind（'handoff-preview'|'compact'|'handoff'）与 trigger
       * @param {{controller?:object,onTick?:Function,onJobId?:(jobId:string)=>void}} [options]
       * @returns {Promise<object>} job 的 result（done）
       */
      const startJobAndPoll = useCallback(
        async (body, options = {}) => {
          const controller = options.controller === undefined ? null : options.controller;
          const signal = controller === null || controller === undefined ? undefined : controller.signal;
          const errorToken = {};
          const fail = (status, bodyHead, code, message) => {
            void reportClientError({
              kind: typeof body.kind === 'string' ? body.kind : 'unknown',
              status,
              bodyHead,
              code,
              message,
              sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
              token: errorToken,
            });
          };
          let res;
          try {
            res = await fetch('/api/compact-relay-action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action: 'job-start',
                ...body,
                ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
              }),
              ...(signal === undefined ? {} : { signal }),
            });
          } catch (error) {
            if (error !== null && typeof error === 'object' && error.name === 'AbortError') throw error;
            const message = error && error.message ? String(error.message) : '未知错误';
            fail(0, '', 'network', message);
            throw jobFailure('network', '连不上宿主：' + message, 0);
          }
          const read = await readActionBody(res);
          const data = read.data;
          // 202 pending：ok:false + code:'pending' + pending:true + jobId。**先于失败判定**——
          // 202 的 ok 为 true（2xx）但 body 里 ok:false，若先走「!res.ok || data.ok === false」
          // 会把 pending 当失败，正好踩中架构 §2 要避免的坑。pending 不是成功，拿到 jobId 继续轮询。
          const pending = data !== null && typeof data === 'object' && (data.code === 'pending' || data.pending === true);
          const jobId = data !== null && typeof data === 'object' && typeof data.jobId === 'string' && data.jobId.length > 0 ? data.jobId : null;
          if (pending) {
            if (jobId === null) {
              fail(res.status, read.bodyHead, 'pending', '任务进行中但没有 jobId，无法继续轮询');
              throw jobFailure('pending', '任务进行中但没有 jobId，无法继续轮询', res.status);
            }
          } else if (!res.ok || data === null || typeof data !== 'object' || data.ok === false) {
            const code =
              data !== null && typeof data === 'object' && typeof data.code === 'string'
                ? data.code
                : res.ok
                  ? 'empty'
                  : 'http';
            const message =
              data !== null && typeof data === 'object' && typeof data.message === 'string'
                ? data.message
                : `请求失败（HTTP ${res.status}）`;
            // busy/changed/cancelled 是业务语义（并发闸/范围变化/取消），不算客户端错误，不刷留档。
            if (code !== 'busy' && code !== 'changed' && code !== 'cancelled') fail(res.status, read.bodyHead, code, message);
            throw jobFailure(code, message, res.status);
          }
          if (jobId === null) {
            // 兼容没有 job 层的旧服务端同步响应：直接当结果，行为与 0.5.6 一致。
            return data;
          }
          if (typeof options.onJobId === 'function') options.onJobId(jobId);
          try {
            return await pollJob(jobId, { signal, onTick: options.onTick });
          } catch (error) {
            const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'job';
            if (code !== 'busy' && code !== 'changed' && code !== 'cancelled') {
              fail(
                error !== null && typeof error === 'object' && Number.isInteger(error.status) ? error.status : 0,
                error !== null && typeof error === 'object' && typeof error.bodyHead === 'string' ? error.bodyHead : '',
                code,
                error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : undefined,
              );
            }
            throw error;
          }
        },
        [sessionId],
      );

      // A1b：交接预览——生成九段草稿 + 就绪清单，不写盘、不建会话、不改历史。
      // 0.5.7：改发 job-start 并轮询；进度 toast 只显示「已 Ns」（不写百分比），可取消。
      const startHandoffPreview = useCallback(async () => {
        if (effectiveBusy) return;
        setOpen(false);
        setPreview(null);
        closeDocs();
        closeDiff();
        setHandoffEditValues({});
        setArchiveWanted(true);
        setHandoffPreview({ loading: true });
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        handoffPreviewAbortRef.current = controller;
        previewJobRef.current = null;
        progressSecondRef.current = -1;
        const progress = (elapsedMs) => {
          const seconds = Math.max(0, Math.floor((Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000));
          if (seconds === progressSecondRef.current) return;
          progressSecondRef.current = seconds;
          showToast({ text: `正在生成交接草稿…（已 ${seconds}s）`, cancel: true }, 0);
        };
        progress(0);
        let previewJobId = null;
        try {
          const data = await startJobAndPoll(
            { kind: 'handoff-preview', trigger: 'ui-menu' },
            {
              controller,
              onTick: (tick) => progress(tick.elapsedMs),
              onJobId: (jobId) => {
                previewJobId = jobId;
                previewJobRef.current = jobId;
              },
            },
          );
          if (data === null || typeof data !== 'object' || data.ok === false) {
            setHandoffPreview(null);
            showToast(
              data && data.message ? withFailureCopy(String(data.message), data) : '交接预览失败：没有拿到草稿',
              6000,
            );
            return;
          }
          // 成功：清掉「已 Ns」进度 toast（0ms 停留的 toast 不会自己消失），直接开草稿面板。
          showToast(null, 0);
          setHandoffPreview({ data });
        } catch (error) {
          setHandoffPreview(null);
          if (error && error.name === 'AbortError') {
            showToast('已取消交接预览（会话记录没有改动）。', 6000);
            return;
          }
          if (error && error.code === 'nojob') {
            showToast('任务已中断（宿主可能重启过），请重试。', 7000);
            return;
          }
          showToast('交接预览失败：' + (error && error.message ? error.message : '未知错误'), 8000);
        } finally {
          // 只清自己那一份（连点两次时不要让先结束的请求清掉后一次的任务 id/控制器）。
          if (handoffPreviewAbortRef.current === controller) handoffPreviewAbortRef.current = null;
          if (previewJobRef.current === previewJobId) previewJobRef.current = null;
        }
      }, [effectiveBusy, sessionId, showToast, closeDocs, closeDiff, startJobAndPoll]);

      // M6：交接单列表（菜单入口）——只读接口，点开可看全文/复制路径。
      // P2-C3/C4：请求带序号 + AbortController；只接受「仍然是当前选中文件」的响应。
      // 0.3.4（BUG-006）：列表先取最近 20 份，「加载更多」再把 limit 提到 50；
      // 端点返回 total，界面据此显示「共 N 份（显示最近 M）」并在无更多时隐藏按钮。
      const loadDocs = useCallback(async (limit = 20) => {
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
          const res = await fetch(`/api/compact-relay-handoffs?limit=${limit}`, {
            cache: 'no-store',
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (reqId !== docsRequestRef.current) return;
          if (!res.ok || data.ok === false) {
            setDocs({ error: data && data.message ? String(data.message) : '读取交接单失败' });
            return;
          }
          const items = Array.isArray(data.items) ? data.items : [];
          const total = typeof data.total === 'number' && Number.isFinite(data.total) ? data.total : items.length;
          setDocs({ items, total, limit, selected: null });
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
          showToast(
            data && data.message
              ? withFailureCopy(String(data.message), data)
              : res.ok
                ? '已更新锁定状态'
                : '锁定操作失败',
            6000,
          );
        } catch (error) {
          showToast('锁定操作失败：' + (error && error.message ? error.message : '未知错误'), 8000);
        } finally {
          setBusy(false);
        }
      }, [effectiveBusy, sessionId]);

      const run = useCallback(
        async (action, extra) => {
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
          runJobRef.current = null;
          progressSecondRef.current = -1;
          // 立刻给反馈：不等结果回来，先告诉用户「在做了」；压缩/交接都可取消。
          // 进度 toast 只显示「已 Ns」（1s 一刷），不写百分比——三个动作都没有可靠的进度回调。
          const progressText = action === 'compact' ? '正在压缩旧会话…' : '正在交接…';
          const progress = (elapsedMs) => {
            const seconds = Math.max(0, Math.floor((Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000));
            if (seconds === progressSecondRef.current) return;
            progressSecondRef.current = seconds;
            showToast({ text: `${progressText}（已 ${seconds}s）`, cancel: true }, 0);
          };
          progress(0);
          try {
            const result = await startJobAndPoll(
              {
                kind: action,
                // 0.5.6 A：菜单/确认卡发起的压缩/交接（外部调用缺省 unknown，不猜）。
                trigger: 'ui-menu',
                ...(expected === undefined ? {} : { expected }),
                // 0.4 P2-1：`extra.edits` = 只含用户真正改过的「约束/下一步」两段。
                ...(extra !== undefined && extra !== null && typeof extra === 'object' ? extra : {}),
              },
              {
                controller,
                onTick: (tick) => progress(tick.elapsedMs),
                onJobId: (jobId) => {
                  runJobRef.current = jobId;
                },
              },
            );
            const data = result !== null && typeof result === 'object' ? result : {};
            if (action === 'handoff' && typeof data.childId === 'string') {
              showToast('交接单已生成，正在打开新会话…', 0);
              try {
                await waitAndOpen(data.childId);
                // 0.5.1 批 2：归档有三种结果（归档 / 按选择不归档 / 置顶未确认不归档），
                // 成功提示要如实说清旧会话去哪了，不能一律说「仍保留」。
                const archiveStatus = data.archive !== null && typeof data.archive === 'object' ? data.archive.status : null;
                showToast(
                  archiveStatus === 'archived' || archiveStatus === 'already'
                    ? '已切换到新会话；旧会话已归档（可在新会话「恢复旧会话」找回）。'
                    : archiveStatus === 'skipped'
                      ? '已切换到新会话；按你的选择未归档旧会话（仍在列表里，置顶保持）。'
                      : archiveStatus === 'pinned'
                        ? '已切换到新会话；旧会话已置顶，本次未自动归档（归档会取消置顶）。'
                        : '已切换到新会话；旧会话归档未完成（仍在列表里）。',
                  8000,
                );
              } catch (error) {
                showToast(`交接单已生成，但自动切换新会话失败：${error && error.message ? error.message : '未知原因'}（新会话 ${data.childId}）`, 8000);
              }
            } else if (data.cancelled === true) {
              // 旧同步动作（无 job 层）的取消形状；job 路径的取消走下面的 error.code。
              showToast(data.message ? String(data.message) : '已取消，会话记录没有改动。', 6000);
            } else {
              showToast(
                data.message
                  ? withFailureCopy(String(data.message), data)
                  : action === 'compact'
                    ? '已开始压缩'
                    : '已开始交接',
                6000,
              );
            }
          } catch (error) {
            if (error && error.name === 'AbortError') {
              showToast('已取消请求（若已提交，会话记录以历史为准）。', 5000);
            } else if (error && error.code === 'changed') {
              // 范围变了：提示并自动重开确认卡，让用户看新范围再决定。
              showToast(error.message ? String(error.message) : '压缩范围已变，请重新预估。', 6000);
              void startPreview();
            } else if (error && error.code === 'cancelled') {
              // 取消不是失败：中性文案（服务端 end 行也是 cancelled，不是 fail）。
              showToast('已取消，会话记录没有改动。', 6000);
            } else if (error && error.code === 'nojob') {
              showToast('任务已中断（宿主可能重启过），请重试。', 7000);
            } else {
              showToast('操作失败：' + (error && error.message ? error.message : '未知错误'), 8000);
            }
          } finally {
            setBusy(false);
            runAbortRef.current = null;
            runJobRef.current = null;
          }
        },
        [sessionId, waitAndOpen, preview, startPreview, showToast, startJobAndPoll],
      );

      // 0.6 预览卡「收藏」按钮：只有用户点击才发请求（绝不自动收藏）。
      // 走既有 action:'favorite-mark'（按 sessionId+seq，含用户发言、不需要活 agent）；
      // 显式 active:true = 只加不切换——即使预览数据过期/重复点，也不会误删已有收藏。
      // 成功只在本卡做局部标记（该行变「已收藏 ✓」、计数本地更新），不重拉预览、不碰压缩计划。
      const markFavoriteFromPreview = useCallback(
        async (item) => {
          const seq = item !== null && typeof item === 'object' && Number.isInteger(item.seq) ? item.seq : null;
          if (seq === null || favoritePendingSeq !== null) return;
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            setFavoriteError('拿不到会话 id，先等会话就绪再收藏');
            return;
          }
          setFavoritePendingSeq(seq);
          setFavoriteError(null);
          try {
            const res = await fetch('/api/compact-relay-action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'favorite-mark', sessionId, seq, active: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (data !== null && typeof data === 'object' && data.ok !== false && data.active === true) {
              setFavoriteMarks((prev) => ({
                ...prev,
                [seq]: {
                  seq,
                  role: typeof item.role === 'string' ? item.role : '',
                  title: typeof item.title === 'string' && item.title.length > 0 ? item.title : typeof item.snippet === 'string' ? item.snippet : '',
                },
              }));
              return;
            }
            setFavoriteError(
              data !== null && typeof data === 'object' && typeof data.message === 'string' && data.message.length > 0
                ? data.message
                : '收藏失败，请重试',
            );
          } catch (error) {
            setFavoriteError('收藏失败：网络或宿主不可用');
          } finally {
            setFavoritePendingSeq(null);
          }
        },
        [sessionId, favoritePendingSeq],
      );

      const adviceText = adviseHandoff ? '建议交接' : adviseCompact ? '建议压缩' : '正常';
      // 0.5.6-B：泄压阀提示——只在「最后 1 次常规压缩」与「已到上限」两档出现，
      // 一律「之后每次」（计数单调不减，阀是单向棘轮，不说一次性说法）。
      const mergeInfo =
        state.compactRange !== null && state.compactRange !== undefined && typeof state.compactRange.merge === 'object'
          ? state.compactRange.merge
          : null;
      const mergeHintText =
        mergeInfo === null
          ? ''
          : mergeInfo.merges === true
            ? `本次压缩就会从会话开头合并全部旧摘要（已 ${mergeInfo.summaries}/${mergeInfo.maxSummaries} 份）· 建议先交接`
            : mergeInfo.normalLeft === 1
              ? // maxSummaries=1 且 0 份时不要显示别扭的「0/1」，进度只在有份数时带。
                `再压一次就到上限${mergeInfo.summaries > 0 ? `（${mergeInfo.summaries}/${mergeInfo.maxSummaries}）` : ''}，之后每次压缩都会全量合并旧摘要 · 建议先交接`
              : '';
      // 0.5.6-D2：上次压缩的归属（悬停卡一行）。有归属行 → 写清来源；
      // 压缩过但事件流里没有归属记录（老会话/事件被轮转）→ 明说「无归属记录」，不猜触发者。
      const lastCompactionTrigger = state.lastCompaction !== null ? state.lastCompaction.trigger : 'unknown';
      const lastCompactionText =
        state.lastCompaction !== null
          ? lastCompactionTextOf(state.lastCompaction)
          : state.summaries > 0
            ? `上次压缩：${NO_ATTRIBUTION_LABEL}`
            : '';
      // 0.3.1：模型判断的断点位置（「这里适合压缩」）；DSH 原生自动压缩线（报警最高阈值）。
      const compressHintText =
        state.compressHint !== null && typeof state.compressHint.ratio === 'number'
          ? `压缩判断点 ${(state.compressHint.ratio * 100).toFixed(0)}%`
          : '';
      const nativeEffective = effectiveNativeRatio(state.native);
      const nativeDetail =
        state.native !== null && state.native.thresholdTokens !== null && state.native.contextWindow !== null
          ? `（${fmt(state.native.thresholdTokens)} / ${fmt(state.native.contextWindow)}${
              state.native.route !== null ? `，${state.native.route.provider}/${state.native.route.model}` : ''
            }${state.native.overridden ? '，按路由覆盖' : ''}）`
          : '';
      const nativeInfo = nativeLineInfo(state.native);
      const nativeLineText =
        nativeEffective !== null
          ? `原生自动压缩线 ${(nativeEffective * 100).toFixed(1)}%${nativeDetail}${
              nativeInfo.differs ? `；${nativeInfo.why}` : ''
            }${ratio > nativeEffective ? '（已越过：整环红色闪烁）' : ''}`
          : 'DSH 原生自动压缩已关闭';
      const pressureKnown = pressureValue !== null;
      const title =
        (pressureKnown
          ? `会话容量已用 ${(ratio * 100).toFixed(1)}%（${fmt(pressureValue)} / ${fmt(windowValue)}）`
          : '正在读取会话容量（会话刚打开，请稍候）') +
        `，已压缩 ${state.summaries} 次｜${adviceText}` +
        (compressHintText !== '' ? `｜${compressHintText}` : '') +
        (nativeLineText !== '' ? `｜${nativeLineText}` : '') +
        (mergeHintText !== '' ? `｜${mergeHintText}` : '') +
        (handoffWarnText !== '' ? `｜${handoffWarnText}` : '') +
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
                `已压缩 ${state.summaries} 次 · ${adviceText}${compressHintText !== '' ? ` · ${compressHintText}` : ''}${nativeLineText !== '' ? ` · ${nativeLineText}` : ''}${effectiveBusy ? ' · 处理中…' : ''}`,
              ),
              // 0.5.6-D2：上次压缩归属（只读一行；无记录时明说「无归属记录」，不显示猜测）。
              // data-cr-last-compaction = trigger 枚举（无记录时 unknown），供 e2e/真机取证。
              lastCompactionText !== ''
                ? h(
                    'div',
                    { 'data-cr-last-compaction': lastCompactionTrigger, style: { marginTop: 2 } },
                    lastCompactionText,
                  )
                : null,
              // 0.5.6-B：泄压阀提示（与 title 同文；merges 时用交接色，属于事前警示）。
              mergeHintText !== ''
                ? h('div', { 'data-cr-merge-hint': '1', style: { marginTop: 2, color: palette.handoff } }, mergeHintText)
                : null,
              // 0.4.2：交接线晚于原生压缩时，悬停卡里给一行显式警示（只告警，不改设置）。
              handoffWarnText !== ''
                ? h('div', { 'data-cr-handoff-warn-text': '1', style: { marginTop: 2, color: palette.handoff } }, handoffWarnText)
                : null,
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
        // 0.4.2：交接线已晚的警示标记（交接刻度旁的小短线 + 小点，不改分段逻辑）。
        ...handoffWarnNodes,
        // 0.5.1 定稿：pin 位置块不画（位置标记归 0.6 时间线；环只表达容量）。
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
          // 0.5.6-C：服务端链号（空串 = 没有链/老宿主没有 chain 字段）。与接力条
          // documentElement.dataset.crRelayChain 对齐，一条表达式就能看两边判断是否一致。
          'data-cr-chain': state.chainOrdinal === null || state.chainOrdinal === undefined ? '' : String(state.chainOrdinal),
          'data-cr-summaries': String(state.summaries),
          'data-cr-pins': String(pins.count),
          // 0.5.1 批 2：失效 pin / 原生压缩预判风险（取证 + 端到端断言用）。
          'data-cr-pins-stale': String(pinStaleCount),
          'data-cr-pins-risk': pinRisk === null ? '' : String(pinRisk.count),
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
            // 禁用态的两行条目也把说明挂到 title：鼠标悬停能读到完整原因（含数字）。
            title: meta.title ?? (oneLine || disabled ? (meta.note ?? sub) : undefined),
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

      // 0.5.1 批 2：交接菜单项的提示（原生压缩预判风险优先于「交接线已晚」，两条都有就并排）。
      const handoffItemNote = handoffLate ? handoffWarnText : '';
      const handoffItemTitle = handoffLate ? handoffGuardInfo.message : undefined;
      // undefined=宿主没上报（老版本/未知）；null=明确没有可压范围；object=可压多少。
      const rangeInfo = state.compactRange;
      // 0.3.5：有可压范围、但会话还没有活 agent（passivized live session）——preview 需要
      // 活 agent，所以按钮仍禁用，但文案要说清「发一条消息唤醒 agent」，不能再报「暂无可压缩内容」。
      const passiveRangeNote =
        rangeInfo !== null && rangeInfo !== undefined && state.compactRangeReason === 'no_agent'
          ? `会话未激活：发一条消息唤醒 agent 后可压 ${rangeInfo.nodes} 条 · 约 ${fmt(rangeInfo.tokens)} tokens`
          : null;
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
            // 0.5.6-B：菜单头第二行——泄压阀提示（正常态无此节点，零噪音）。
            mergeHintText !== ''
              ? h(
                  'div',
                  { 'data-cr-merge-hint': '1', style: { padding: '0 10px 4px', fontSize: 11, lineHeight: '15px', color: palette.handoff } },
                  mergeHintText,
                )
              : null,
            item(
              '压缩旧会话',
              '把较早会话压成摘要，腾出容量（先预估再确认，/bc）',
              'compact',
              adviseCompact ? palette.compact : null,
              {
                ...(rangeInfo === null
                  ? {
                      disabled: true,
                      note: '暂无可压缩内容（会话太短，或近期会话需保留原文）',
                    }
                  : passiveRangeNote !== null
                    ? { disabled: true, title: passiveRangeNote, note: passiveRangeNote }
                    : rangeInfo !== undefined
                      ? {
                          note:
                            (mergeInfo !== null && mergeInfo.merges === true
                              ? '⚠ 全量合并 · '
                              : mergeInfo !== null && mergeInfo.normalLeft === 1
                                ? '最后 1 次常规压缩 · '
                                : '') + `可压 ${rangeInfo.nodes} 条 · 约 ${fmt(rangeInfo.tokens)} tokens · 点击先看压缩预估`,
                        }
                      : { note: '点击先看压缩预估（范围/容量）' }),
                onClick: () => {
                  void startPreview();
                },
              },
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
                    // 0.4.2（P1）：交接线晚于原生压缩时，菜单项旁直接标出来（只告警，仍可点）。
                    // 0.5.1 批 2：原生压缩预计覆盖 pin 时，这里优先提示「先交接保留」。
                    ...(handoffItemNote !== '' ? { note: handoffItemNote, ...(handoffItemTitle === undefined ? {} : { title: handoffItemTitle }) } : {}),
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
      // 0.5.6-B：本次是否走泄压阀（老宿主没有 merge 字段 / merges=false → 不渲染警示块）。
      const previewMergeWarn =
        previewRange !== null && previewRange.merge !== null && typeof previewRange.merge === 'object' && previewRange.merge.merges === true
          ? previewRange.merge
          : null;
      // 0.6 预览卡收藏区：服务端 additive 字段 favoritePreview（老宿主没有 → 整块不渲染）。
      // 只读渲染；「建议补」= 本段未收藏的候选（服务端已用 pinSuggest 同一套识别过滤过）。
      const favoritePreview =
        previewRange !== null && previewRange.favoritePreview !== null && typeof previewRange.favoritePreview === 'object'
          ? previewRange.favoritePreview
          : null;
      const favoriteRowOf = (item) =>
        item !== null && typeof item === 'object' && Number.isInteger(item.seq)
          ? {
              seq: item.seq,
              role: typeof item.role === 'string' ? item.role : '',
              title: typeof item.title === 'string' ? item.title : '',
              reason: typeof item.reason === 'string' ? item.reason : '',
              snippet: typeof item.snippet === 'string' ? item.snippet : '',
            }
          : null;
      const favoriteBaseItems =
        favoritePreview !== null && Array.isArray(favoritePreview.favorited)
          ? favoritePreview.favorited.map(favoriteRowOf).filter((item) => item !== null)
          : [];
      const favoriteSuggestList =
        favoritePreview !== null && Array.isArray(favoritePreview.suggest)
          ? favoritePreview.suggest.map(favoriteRowOf).filter((item) => item !== null)
          : [];
      const favoriteRangeTotal =
        favoritePreview !== null && Number.isInteger(favoritePreview.total) ? favoritePreview.total : (previewRange?.nodes ?? 0);
      // 卡内点成功的收藏：补进「本段已收藏」列表，并从「建议补」计数里扣掉（本地即时，不重拉预览）。
      const favoriteExtraItems = favoriteSuggestList
        .filter((item) => favoriteMarks[item.seq] !== undefined)
        .map((item) => ({ seq: item.seq, role: item.role, title: item.snippet }));
      const favoriteDisplayItems = [...favoriteBaseItems, ...favoriteExtraItems];
      const favoriteFavoritedCount =
        (favoritePreview !== null && Number.isInteger(favoritePreview.favoritedCount)
          ? favoritePreview.favoritedCount
          : favoriteBaseItems.length) + favoriteExtraItems.length;
      const favoriteSuggestRemaining = favoriteSuggestList.length - favoriteExtraItems.length;
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
                  maxHeight: 'min(70vh, 440px)',
                  overflowY: 'auto',
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
                    // 0.5.6-B：泄压阀警示块——只在本次真的合并时出现（语义标签，不是数字强调）。
                    previewMergeWarn !== null
                      ? h(
                          'div',
                          {
                            'data-cr-merge-warning': '1',
                            style: {
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 2,
                              padding: '6px 8px',
                              borderRadius: 8,
                              border: `1px solid ${palette.handoff}`,
                              color: palette.handoff,
                              fontSize: 11,
                              lineHeight: '16px',
                            },
                          },
                          h('div', { style: { fontWeight: 700 } }, '⚠ 本次是合并压缩'),
                          h(
                            'div',
                            null,
                            `已达到摘要上限（${previewMergeWarn.summaries}/${previewMergeWarn.maxSummaries} 份），本次会从会话开头把全部旧摘要连同期间的消息一起压成 1 条，范围会比平时大得多，旧摘要和被压掉的原文都无法还原。`,
                          ),
                          h('div', null, '想保留旧摘要就先取消，去「交接新会话」。'),
                        )
                      : null,
                    favoritePreview !== null
                      ? h(
                          'div',
                          {
                            'data-cr-favorite-preview': '1',
                            style: {
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4,
                              padding: '6px 8px',
                              borderRadius: 8,
                              border: `1px solid ${theme.panelBorder}`,
                              background: theme.hover,
                            },
                          },
                          h(
                            'div',
                            {
                              'data-cr-favorite-summary': '1',
                              style: { fontSize: 11, fontWeight: 700, color: theme.panelFg },
                            },
                            `本段 ${favoriteRangeTotal} 条 · 已收藏 ${favoriteFavoritedCount} 条 · 建议补 ${favoriteSuggestRemaining} 条`,
                          ),
                          favoriteDisplayItems.length > 0
                            ? h(
                                'div',
                                { 'data-cr-favorite-list': '1', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                                h('div', { style: { fontSize: 10, fontWeight: 700, color: theme.subText } }, '本段已收藏'),
                                ...favoriteDisplayItems.map((item) =>
                                  h(
                                    'div',
                                    {
                                      key: `favorite-item-${item.seq}`,
                                      'data-cr-favorite-item': String(item.seq),
                                      style: {
                                        fontSize: 11,
                                        lineHeight: '16px',
                                        color: theme.subText,
                                        whiteSpace: 'normal',
                                        wordBreak: 'break-word',
                                      },
                                    },
                                    `[${item.role}] ${item.title}`,
                                  ),
                                ),
                                favoriteFavoritedCount > favoriteDisplayItems.length
                                  ? h(
                                      'div',
                                      { style: { fontSize: 10, lineHeight: '14px', color: theme.subText } },
                                      `…另有 ${favoriteFavoritedCount - favoriteDisplayItems.length} 条，用 /favorite list 查看`,
                                    )
                                  : null,
                              )
                            : null,
                          favoriteSuggestList.length > 0
                            ? h(
                                'div',
                                { 'data-cr-favorite-suggest': '1', style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                                h('div', { style: { fontSize: 10, fontWeight: 700, color: theme.subText } }, '建议先收藏（本段未收藏）'),
                                ...favoriteSuggestList.map((item) => {
                                  const done = favoriteMarks[item.seq] !== undefined;
                                  const pending = favoritePendingSeq === item.seq;
                                  return h(
                                    'div',
                                    {
                                      key: `favorite-suggest-${item.seq}`,
                                      'data-cr-favorite-suggest-row': String(item.seq),
                                      style: { display: 'flex', alignItems: 'flex-start', gap: 6 },
                                    },
                                    h(
                                      'span',
                                      {
                                        style: {
                                          flex: 1,
                                          minWidth: 0,
                                          fontSize: 11,
                                          lineHeight: '16px',
                                          color: theme.subText,
                                          whiteSpace: 'normal',
                                          wordBreak: 'break-word',
                                        },
                                      },
                                      `[${item.role}] ${item.reason}：${item.snippet}`,
                                    ),
                                    done
                                      ? h(
                                          'span',
                                          {
                                            'data-cr-favorite-done': String(item.seq),
                                            style: { flex: 'none', fontSize: 10, fontWeight: 600, lineHeight: '16px', color: '#2fb344' },
                                          },
                                          '已收藏 ✓',
                                        )
                                      : h(
                                          'button',
                                          {
                                            type: 'button',
                                            'data-cr-favorite-mark': String(item.seq),
                                            disabled: favoritePendingSeq !== null,
                                            onClick: () => {
                                              void markFavoriteFromPreview(item);
                                            },
                                            style: {
                                              flex: 'none',
                                              border: `1px solid ${theme.panelBorder}`,
                                              borderRadius: 6,
                                              padding: '1px 8px',
                                              fontSize: 10,
                                              lineHeight: '16px',
                                              cursor: favoritePendingSeq === null ? 'pointer' : 'default',
                                              background: 'transparent',
                                              color: theme.panelFg,
                                              opacity: favoritePendingSeq === null ? 1 : 0.5,
                                            },
                                          },
                                          pending ? '收藏中…' : '收藏',
                                        ),
                                  );
                                }),
                                h(
                                  'div',
                                  { 'data-cr-favorite-note': '1', style: { fontSize: 10, lineHeight: '14px', color: theme.subText } },
                                  '只提示、不自动收藏；点「收藏」只写一条收藏标记，不改压缩范围。',
                                ),
                              )
                            : null,
                          favoriteError !== null
                            ? h(
                                'div',
                                { 'data-cr-favorite-error': '1', style: { fontSize: 10, lineHeight: '14px', color: COLORS.error } },
                                favoriteError,
                              )
                            : null,
                        )
                      : null,
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
      /**
       * 0.5.1 批 2：交接确认统一入口 —— 只把「用户真的改过、且非空」的两段发给宿主；
       * includeArchive/confirmUnpin 由归档开关和置顶确认决定（服务端还会再兜一层）。
       */
      const beginHandoff = (options = {}) => {
        const editable = handoffData !== null && typeof handoffData === 'object' ? handoffData.editable : null;
        const edits = {};
        if (editable !== null && typeof editable === 'object' && Array.isArray(editable.titles)) {
          for (const title of editable.titles) {
            const original = typeof editable.sections?.[title] === 'string' ? editable.sections[title].trim() : '';
            const current = typeof handoffEditValues[title] === 'string' ? handoffEditValues[title].trim() : '';
            if (current.length > 0 && current !== original) edits[title] = current;
          }
        }
        closeHandoffPreview();
        void run('handoff', {
          archive: options.archive !== false,
          ...(options.confirmUnpin === true ? { confirmUnpin: true } : {}),
          ...(Object.keys(edits).length > 0 ? { edits } : {}),
        });
      };
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
                    {
                      'data-cr-handoff-body': '1',
                      style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flexShrink: 0 },
                    },
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
                        'data-cr-handoff-draft': '1',
                        style: {
                          fontSize: 11,
                          lineHeight: '16px',
                          overflow: 'auto',
                          maxHeight: 220,
                          flexShrink: 0,
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
                    // 0.4 P2-1：只允许编辑「约束」「下一步」两段；其余段由模型/程序生成，UI 不给入口。
                    handoffData !== null && typeof handoffData === 'object' && handoffData.editable !== null && typeof handoffData.editable === 'object'
                      ? h(
                          'div',
                          { 'data-cr-handoff-editable': '1', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                          h('div', { style: { fontSize: 11, fontWeight: 600 } }, '可编辑两段（改完点「确认交接」才生效）'),
                          ...(Array.isArray(handoffData.editable.titles) ? handoffData.editable.titles : []).map((title) => {
                            const original = typeof handoffData.editable.sections?.[title] === 'string' ? handoffData.editable.sections[title] : '';
                            return h(
                              'label',
                              { key: `handoff-edit-${title}`, style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 } },
                              h('span', { style: { color: theme.subText } }, `${title}（留空 = 使用原文）`),
                              h('textarea', {
                                'data-cr-handoff-edit': title,
                                value: typeof handoffEditValues[title] === 'string' ? handoffEditValues[title] : original,
                                rows: 3,
                                maxLength: Number.isInteger(handoffData.editable.maxChars) ? handoffData.editable.maxChars : 4000,
                                onChange: (event) => {
                                  const value = event.target.value;
                                  setHandoffEditValues((previous) => ({ ...previous, [title]: value }));
                                },
                                style: {
                                  width: '100%',
                                  boxSizing: 'border-box',
                                  resize: 'vertical',
                                  fontFamily: 'inherit',
                                  fontSize: 11,
                                  lineHeight: '16px',
                                  color: 'inherit',
                                  background: 'transparent',
                                  border: `1px solid ${theme.panelBorder}`,
                                  borderRadius: 6,
                                  padding: '4px 6px',
                                },
                              }),
                            );
                          }),
                          h('div', { style: { fontSize: 10, lineHeight: '14px', color: theme.subText } }, handoffData.editable.note ?? '程序生成的段不可改。'),
                        )
                      : null,
                    // 0.5.1 批 2：归档开关（默认开 = 0.5.0 行为；取消后只交接、不归档）。
                    h(
                      'label',
                      {
                        'data-cr-handoff-archive-row': '1',
                        style: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11, lineHeight: '16px', color: theme.subText },
                      },
                      h('input', {
                        type: 'checkbox',
                        'data-cr-handoff-archive': '1',
                        checked: archiveWanted,
                        onChange: (event) => setArchiveWanted(event.target.checked === true),
                        style: { marginTop: 2 },
                      }),
                      h(
                        'span',
                        null,
                        '交接后自动归档旧会话（默认开；新会话建好后旧会话从侧栏收起，可在新会话「恢复旧会话」找回）。取消勾选 = 只交接、旧会话留在列表里。',
                      ),
                    ),
                    // 0.5.1 批 2：置顶保护 —— 宿主归档会在同一次写盘里取消置顶，必须用户确认。
                    sessionPinned && archiveWanted
                      ? h(
                          'div',
                          {
                            'data-cr-handoff-pinned-warning': '1',
                            style: {
                              fontSize: 11,
                              lineHeight: '16px',
                              padding: '6px 8px',
                              borderRadius: 8,
                              border: `1px solid ${palette.handoff}`,
                              color: palette.handoff,
                              background: theme.hover,
                            },
                          },
                          '旧会话已在侧栏置顶：归档会取消置顶（宿主行为）。要归档请点「交接并归档（取消置顶）」；想保留置顶就点「只交接，保留置顶」。',
                        )
                      : null,
                    h(
                      'div',
                      { style: { fontSize: 11, color: theme.subText } },
                      '确认后会先压缩旧会话，再按压缩后的历史生成最终交接单；预览不落盘。归档开关只影响旧会话是否从侧栏收起，不影响交接单本身。',
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' } },
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
                      // 置顶 + 勾选归档：给两个明确出口（归档并取消置顶 / 只交接保留置顶）。
                      sessionPinned && archiveWanted
                        ? h(
                            'button',
                            {
                              type: 'button',
                              'data-cr-handoff-keep': '1',
                              onClick: () => beginHandoff({ archive: false }),
                              style: { ...smallBtnStyle, borderRadius: 7, padding: '4px 10px' },
                            },
                            '只交接，保留置顶',
                          )
                        : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-handoff-run': '1',
                          onClick: () => beginHandoff(sessionPinned && archiveWanted ? { archive: true, confirmUnpin: true } : { archive: archiveWanted }),
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
                        sessionPinned && archiveWanted
                          ? '交接并归档（取消置顶）'
                          : archiveWanted
                            ? '确认交接（归档旧会话）'
                            : '确认交接（不归档）',
                      ),
                    ),
                  ),
            );

      // 0.3.4（BUG-006）：total 与当前窗口（20/50），用于列表底部与「加载更多」。
      const docsItems = docs !== null && Array.isArray(docs.items) ? docs.items : [];
      const docsTotal =
        docs !== null && typeof docs.total === 'number' && Number.isFinite(docs.total)
          ? docs.total
          : docsItems.length;
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
                    : `历史交接单（${docsTotal}）`,
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
                            onClick: () => setDocs((prev) => (prev === null ? null : { ...prev, selected: null })),
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
                        'div',
                        {
                          // 0.3.4（BUG-005）：交接单详情从 <pre> 纯文本改成轻量 markdown 渲染。
                          // 解析器是 core/markdown-lite.js（构建时内联），渲染只产生 React
                          // 文本节点，不生成 HTML、不引第三方依赖。
                          'data-cr-doc-content': '1',
                          style: {
                            margin: 0,
                            padding: '8px 12px',
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            wordBreak: 'break-word',
                            fontSize: 11,
                            lineHeight: '16px',
                            maxHeight: 'min(50vh, 320px)',
                          },
                        },
                        docs.contentLoading === true
                          ? '读取中…'
                          : docs.contentError !== undefined && docs.contentError !== null
                            ? h('div', { style: { color: COLORS.error } }, String(docs.contentError))
                            : renderMarkdownLite(docs.content ?? ''),
                      ),
                    )
                  : h(
                      'div',
                      { style: { overflowY: 'auto', padding: 4 } },
                      docs.error !== undefined && docs.error !== null
                        ? h('div', { style: { padding: '8px 10px', fontSize: 11, color: COLORS.error } }, String(docs.error))
                        : docsItems.length > 0
                          ? [...docsItems.map((entry) =>
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
                            ),
                            h(
                              'div',
                              {
                                key: 'docs-footer',
                                style: {
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '6px 10px',
                                  borderTop: `1px solid ${theme.panelBorder}`,
                                  fontSize: 10,
                                  color: theme.subText,
                                },
                              },
                              h('span', { style: { flex: 1, minWidth: 0 } }, `共 ${docsTotal} 份（显示最近 ${docsItems.length}）`),
                              docsItems.length < docsTotal && docsItems.length < 50
                                ? h(
                                    'button',
                                    {
                                      type: 'button',
                                      'data-cr-docs-more': '1',
                                      onClick: () => {
                                        void loadDocs(50);
                                      },
                                      style: smallBtnStyle,
                                    },
                                    '加载更多',
                                  )
                                : null,
                            ),
                          ]
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
                        diff.items.map((entry, index) => {
                          // 0.5.6-D2：只算一次（同一条目两处渲染），且只有 id 完全相同才认归属。
                          const attribution = diffAttributionOf(entry, state.lastCompaction);
                          return h(
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
                            // 0.5.6-D2：每条压缩一行归属。服务端只下发最近一次归属（state.lastCompaction），
                            // 因此只有 compactionId 完全相同才认；历史条目一律「来源不明（无归属记录）」，不猜。
                            h(
                              'span',
                              {
                                'data-cr-diff-attribution': attribution.trigger,
                                style: { fontSize: 10, color: theme.subText },
                              },
                              attribution.text,
                            ),
                            h(
                              'span',
                              { style: { fontSize: 11, lineHeight: '16px', color: entry.error ? COLORS.error : theme.subText, whiteSpace: 'normal', wordBreak: 'break-word' } },
                              entry.error ? `错误：${entry.error.message ?? entry.error.name ?? '未知'}` : entry.preview || '（摘要为空）',
                            ),
                          );
                        }),
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
              // 0.5.6 A3：失败 toast 的「复制诊断」——内容已由服务端脱敏，可直接贴 issue。
              toast !== null && typeof toast === 'object' && typeof toast.copy === 'string'
                ? h(
                    'button',
                    {
                      type: 'button',
                      'data-cr-toast-copy': '1',
                      onClick: () => {
                        void copyTextToClipboard(toast.copy).then(
                          () => showToast('已复制失败诊断（可贴到 issue）', 4000),
                          () => showToast('复制失败：浏览器不允许访问剪贴板', 5000),
                        );
                      },
                      style: { ...smallBtnStyle, flex: 'none' },
                    },
                    '复制诊断',
                  )
                : null,
            )
          : null,
      );
    }

    /* ---------------- 0.5.0 接力条（v1）：输入框上方一行「已接力自 …」 ---------------- */

    /**
     * 0.5.0 接力条 v1 —— 只做「一行摘要 + 向上弹出的下拉菜单」。
     *
     * 位置：`conversation.input.dock`（list / session scope；宿主文档原文
     *       “Full-width entries above the composer card”，即输入卡上方通栏）。
     * 显示：`readState.chain` 非 null，且这条记录是**本会话的入站记录**
     *       （childId === sessionId）。出站记录（本会话交接给了下一代）不显示
     *       「已接力自」；老宿主/没有 chain 字段时组件返回 null，不占高度。
     * 数据：GET `/api/compact-relay-state?sessionId=…`；
     *       完整链优先 GET `/api/compact-relay-chain?sessionId=…`（一次读全，祖先未加载也行），
     *       老宿主回落逐级 state。会话刚打开、宿主还没装日志
     *       时短重试几次（拿到本会话的 sessionId 后就停，不做常驻轮询/SSE）。
     *       子会话的 relay record 不带 path（F3 只写链号），缺 path 时再只读一次父
     *       会话状态，用父记录里的 path 打开交接单（childId/ordinal 校验）。
     * 交互：点击这一行 → fixed 定位、向上弹出的菜单（不被输入区裁切）：
     *       查看交接单 / 回到原会话 / 路线图（即将上线，占位禁用）。
     */

    /**
     * readState.chain → 接力条可用的最小结构；无效时返回 null（不猜、不补默认值）。
     *
     * 只接受 ordinal 为正整数的链；baseTitle/parentId/path 缺了就保持 null，
     * 由 UI 决定禁用或回落文案。老宿主的响应里没有 chain 字段 → null → 不渲染。
     *
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @param {string|undefined} sessionId 当前会话 id（dock 的 session scope 参数）
     * @returns {{ordinal:number, baseTitle:string|null, parentId:string|null, childId:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}|null}
     */
    function relayBarChainOf(data, sessionId) {
      const chain = relayChainProjectionOf(data);
      if (chain === null) return null;
      // 出站记录（本会话把接力棒交给下一代）：它不是「已接力自」，v1 不显示。
      // childId 缺失时（旧链路记录形态）不据此隐藏，遵守「chain 非 null 就显示」。
      if (chain.childId !== null && typeof sessionId === 'string' && sessionId.length > 0 && chain.childId !== sessionId) return null;
      return chain;
    }

    /**
     * 只做字段投影，不做「是不是本会话入站记录」的判断。
     *
     * 单独拆出来是给「父记录补 path」用：父会话里的同一条记录是出站的
     * （childId=本会话），用 relayBarChainOf 会被入站判断过滤掉，但它的 path
     * 恰恰是子会话要打开的那份交接单。
     *
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {{ordinal:number, baseTitle:string|null, parentId:string|null, childId:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}|null}
     */
    function relayChainProjectionOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      const chain = data.chain;
      if (chain === null || typeof chain !== 'object') return null;
      if (!Number.isInteger(chain.ordinal) || chain.ordinal <= 0) return null;
      const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
      return {
        ordinal: chain.ordinal,
        baseTitle: text(chain.baseTitle),
        parentId: text(chain.parentId),
        childId: text(chain.childId),
        scheme: chain.scheme === 'handoff-n' || chain.scheme === 'history-n' ? chain.scheme : null,
        path: text(chain.path),
      };
    }

    /**
     * 服务端状态里「这一跳」的**出站**投影（0.5.1 DCR-01）。
     *
     * 父会话请求拿到的是它自己的状态：`chain` 是**父会话的入站**记录（它的上一代），
     * `next` 才是它交接给子会话的那条出站记录 —— 子会话要补的交接单 path 在 next 里。
     * 老插件（0.5.0）没有 next 字段，那时 chain 就是「最近一条记录」，直接回落到它，
     * 保证旧服务端仍可用。校验仍在调用方（childId/链号必须对得上）。
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {{ordinal:number, baseTitle:string|null, parentId:string|null, childId:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}|null}
     */
    function relayOutboundProjectionOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      const next = data.next;
      if (next !== null && next !== undefined) {
        const projection = relayChainProjectionOf({ ok: true, chain: next });
        if (projection !== null) return projection;
      }
      // 老插件：没有 next，chain 就是最近一条记录（出站）。
      return relayChainProjectionOf(data);
    }

    /**
     * 0.5.1 DCR-03：宿主有没有恢复归档会话的接缝（readState.capabilities.unarchive）。
     *
     * 三重取值：true / false / null（老插件没有 capabilities 字段 → 不知道，按「可尝试」
     * 处理，恢复调用本身幂等）。
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {boolean|null}
     */
    function relayBarUnarchiveCapabilityOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      const capabilities = data.capabilities;
      if (capabilities === null || typeof capabilities !== 'object') return null;
      return typeof capabilities.unarchive === 'boolean' ? capabilities.unarchive : null;
    }

    /**
     * 0.5.0：旧会话是否已被交接流程自动归档。
     *
     * 宿主 `readState` 在链有父会话时下发 `parentArchived`（boolean；服务不可用为 null）。
     * 老宿主没有这个字段 → null（客户端按「可尝试恢复」处理，恢复调用本身幂等）。
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {boolean|null}
     */
    function relayBarParentArchivedOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      return typeof data.parentArchived === 'boolean' ? data.parentArchived : null;
    }

    /**
     * 0.5.2 L 项：宿主有没有强制归档的接缝（`readState.capabilities.forceArchive`）。
     *
     * 三重取值：true / false / null（老插件没有这个字段 → 不知道，仍显示入口；
     * 调用失败会给可读错误，不静默）。false = 宿主没有 `archiveSession` → 隐藏死入口。
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {boolean|null}
     */
    function relayBarForceArchiveCapabilityOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      const capabilities = data.capabilities;
      if (capabilities === null || typeof capabilities !== 'object') return null;
      return typeof capabilities.forceArchive === 'boolean' ? capabilities.forceArchive : null;
    }

    /**
     * 0.5.2 L 项：链上旧会话（入站 parentId）是否在侧栏置顶（`readState.parentPinned`）。
     *
     * 置顶与归档互斥：宿主 `archiveSession` 在同一笔写盘里把该 id 从置顶集合移除。
     * 强制归档的二次确认要在置顶时明确写「会同时取消置顶」，所以这里只读判断。
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {boolean|null}
     */
    function relayBarParentPinnedOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      return typeof data.parentPinned === 'boolean' ? data.parentPinned : null;
    }

    /**
     * 接力条摘要：新链「历史 N：原名」，旧链「交接第 N 次：原名」。
     * @param {object} chain relayBarChainOf 的结果
     * @returns {string}
     */
    function relayBarLabelOf(chain) {
      const baseTitle = chain.baseTitle === null ? '会话' : chain.baseTitle;
      return chain.scheme === 'history-n' ? `历史 ${chain.ordinal}：${baseTitle}` : `交接第 ${chain.ordinal} 次：${baseTitle}`;
    }

    /**
     * 0.5.1 批 3：父会话侧的**出站目标**（`readState.next` 的投影，父→子入口用）。
     *
     * 与 relayOutboundProjectionOf 的区别：这里**不回落到 chain**。老插件没有 next 字段
     * （那里 chain 是「最近一条记录」，可能是本会话的入站记录），拿它当出站目标会生出
     * 「去新会话」却跳回自己的死入口。另外 childId 指回本会话的脏记录也一律不认。
     *
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @param {string|undefined} sessionId 当前会话 id
     * @returns {{ordinal:number, baseTitle:string|null, parentId:string|null, childId:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}|null}
     */
    function relayBarNextOf(data, sessionId) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      if (data.next === null || data.next === undefined) return null;
      const projection = relayChainProjectionOf({ ok: true, chain: data.next });
      if (projection === null || projection.childId === null) return null;
      if (typeof sessionId === 'string' && sessionId.length > 0 && projection.childId === sessionId) return null;
      return projection;
    }

    /**
     * 0.5.1 批 3：出站目标（下一代会话）是否已在归档集合里（readState.nextArchived）。
     *
     * 三重取值：true / false / null（老插件没有这个字段 → 不知道，按「可尝试恢复」处理，
     * unarchive 幂等）。父会话侧「去新会话」据此决定要不要先 unarchive 再 open。
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {boolean|null}
     */
    function relayBarNextArchivedOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      return typeof data.nextArchived === 'boolean' ? data.nextArchived : null;
    }

    /**
     * 交接单绝对路径 → `/api/compact-relay-handoffs?file=` 只接受的 handoff-*.md 文件名。
     * 服务端只认文件名（不是全路径），这里取 basename 并做同一形态校验；不合法 → null。
     * @param {string|null} path
     * @returns {string|null}
     */
    function relayBarDocNameOf(path) {
      if (typeof path !== 'string' || path.length === 0) return null;
      const name = path.split(/[\\/]/).pop();
      return typeof name === 'string' && /^handoff-[0-9A-Za-z][0-9A-Za-z.\-_]*\.md$/.test(name) ? name : null;
    }

    /**
     * 完整交接链最多回看多少跳（0.5.1 批 3）。
     *
     * 硬上限：链路异常成环、或从某个 0.4 老链一路接力下来时，不能让界面无限逐级
     * 打接口。正常用户几跳内就到根，8 跳足够长；到顶时界面明说「只显示最近 8 层」。
     */
    const MAX_CHAIN_HOPS = 8;

    /**
     * 0.5.1 DCR-05：完整交接链一次读完的只读端点。
     *
     * 服务端直接读持久化日志/header（不加载祖先会话），因此重启后祖先都没加载也能
     * 一次拿到整条链；老插件/老宿主没有这个端点时客户端回落到逐级 state 读法。
     */
    const RELAY_CHAIN_ENDPOINT = '/api/compact-relay-chain';

    /**
     * 服务端整链响应 → 行数组；形状不合法返回 null（调用方回落旧逐级读法）。
     *
     * 行只保留画一行需要的字段；`sessionId` 是这一层会话自己的 id（不是 childId）。
     * @param {object|null|undefined} data `/api/compact-relay-chain` 的响应
     * @returns {Array<{sessionId:string, ordinal:number, baseTitle:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}>|null}
     */
    function relayChainRowsOf(data) {
      if (data === null || typeof data !== 'object' || data.ok !== true || !Array.isArray(data.rows)) return null;
      const rows = [];
      for (const row of data.rows) {
        if (row === null || typeof row !== 'object') continue;
        if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) continue;
        const projection = relayChainProjectionOf({ ok: true, chain: row });
        if (projection === null) continue;
        rows.push({
          sessionId: row.sessionId,
          ordinal: projection.ordinal,
          baseTitle: projection.baseTitle,
          scheme: projection.scheme,
          path: projection.path,
        });
      }
      return rows;
    }

    /**
     * 0.5.6-C：整链端点 `rows[0]` → 接力条认识的**入站** chain（兜底合成）。
     *
     * 服务端按「子记录优先、父出点补」给出每一行；`rows[0]` 就是直接父会话那一行
     * （`sessionId` = 父会话 id），这条链的 childId 就是当前会话自己。字段口径与
     * `relayBarChainOf` 完全一致：ordinal 必须是正整数，缺失的标题/路径保持 null，
     * scheme 只认两种合法值 —— 不编造、不补默认值。
     *
     * @param {Array<{sessionId:string, ordinal:number, baseTitle:string|null, scheme:string|null, path:string|null}>|null} rows relayChainRowsOf 的结果
     * @param {string|undefined} sessionId 当前会话 id（dock 的 session scope 参数）
     * @returns {{ordinal:number, baseTitle:string|null, parentId:string|null, childId:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}|null}
     */
    function relayBarChainFromRows(rows, sessionId) {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      const row = rows[0];
      if (row === null || typeof row !== 'object') return null;
      if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) return null;
      if (!Number.isInteger(row.ordinal) || row.ordinal <= 0) return null;
      const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
      return {
        ordinal: row.ordinal,
        baseTitle: text(row.baseTitle),
        // 行里的 sessionId 是「这一层会话自己」；对 rows[0] 就是直接父会话。
        parentId: row.sessionId,
        childId: sessionId,
        scheme: row.scheme === 'handoff-n' || row.scheme === 'history-n' ? row.scheme : null,
        path: text(row.path),
      };
    }

    /** 接力条菜单里的一行（和指示灯菜单同一套视觉，但更轻）。 */
    function relayBarItem(label, sub, key, action, meta = {}) {
      const disabled = meta.disabled === true;
      return h(
        'button',
        {
          type: 'button',
          key,
          role: 'menuitem',
          'data-cr-relay-action': key,
          disabled,
          title: meta.title ?? (disabled ? sub : undefined),
          onClick: () => {
            if (disabled || typeof action !== 'function') return;
            action();
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            minHeight: 32,
            padding: '5px 10px',
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            textAlign: 'left',
            cursor: disabled ? 'default' : 'pointer',
            color: 'var(--dsw-alias-label-primary, inherit)',
            opacity: disabled ? 0.55 : 1,
            font: 'inherit',
          },
          onMouseEnter: (event) => {
            if (!disabled) event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))';
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.background = 'transparent';
          },
        },
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 } },
          h('span', { style: { fontSize: 12, fontWeight: 500 } }, label),
          sub !== null
            ? h(
                'span',
                { style: { fontSize: 10, lineHeight: '14px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } },
                sub,
              )
            : null,
        ),
        h(
          'span',
          { style: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))', whiteSpace: 'nowrap' } },
          meta.right ?? (disabled ? '' : '›'),
        ),
      );
    }

    /**
     * 接力条本体（`conversation.input.dock`，输入卡上方一行）。
     *
     * 0.5.1 批 3 起这一行有两个方向：
     *   - 入站（`chain`，子会话侧）：「已接力自 历史 N：原名」+ 回到原会话 / 完整交接链；
     *   - 出站（`next`，父会话侧）：「已交接给新会话」+ 去新会话；
     *   - 两个都有（中段会话）：同时显示两个方向的入口。
     *
     * @param {object} props ctx.slots.register 注入的 props
     * @param {string} [props.sessionId] 当前会话 id（session scope）
     * @param {(sessionId:string)=>unknown} [props.openSession] 切到某个会话（ctx.uiWorkspace.openSession）
     * @param {(sessionId:string)=>Promise<unknown>|undefined} [props.unarchiveSession] 恢复归档会话
     *   （ctx.uiWorkspace.unarchiveSession；老宿主没有 → 走本插件 HTTP recover 兜底）
     */
    function CompactRelayBar(props) {
      const sessionId = props === null || props === undefined ? undefined : props.sessionId;
      const openSession = props === null || props === undefined ? undefined : props.openSession;
      const unarchiveSession = props === null || props === undefined ? undefined : props.unarchiveSession;
      const hasSession = typeof sessionId === 'string' && sessionId.length > 0;
      const [chain, setChain] = useState(null);
      // 0.5.1 批 3：出站投影（本会话把接力棒交给了谁）。父会话侧据此显示「去新会话」。
      const [next, setNext] = useState(null);
      // null = 宿主没给归档状态（老宿主）；true/false = readState.parentArchived。
      const [parentArchived, setParentArchived] = useState(null);
      // 0.5.1 批 3：出站目标（next.childId）的归档状态（readState.nextArchived）。
      const [nextArchived, setNextArchived] = useState(null);
      // 0.5.1 DCR-03：服务端能不能恢复归档会话（readState.capabilities.unarchive）。
      // null = 老插件没有这个字段（不知道 → 仍显示入口，恢复调用幂等）。
      const [serverUnarchive, setServerUnarchive] = useState(null);
      // 0.5.2 L 项：服务端能不能强制归档（readState.capabilities.forceArchive）。
      // null = 老插件没有这个字段（不知道 → 仍显示入口，失败会给可读错误）。
      const [serverForceArchive, setServerForceArchive] = useState(null);
      // 0.5.2 L 项：旧会话（入站 parentId）是否在侧栏置顶（readState.parentPinned）。
      // 置顶时二次确认要提前说明「归档会同时取消置顶」。
      const [parentPinned, setParentPinned] = useState(null);
      // 0.5.2 L 项：强制归档面板 —— null = 关；否则
      // {phase:'confirm'|'busy'|'error'|'done', status?, note?, message?}。
      const [forceView, setForceView] = useState(null);
      // 0.5.1 DCR-03：打开菜单时 +1，触发一次静默刷新（别处归档/取消归档能立刻反映）。
      const [refreshKey, setRefreshKey] = useState(0);
      // 0.5.1 批 3：完整交接链（null = 没展开；点「完整交接链」后才逐级去读）。
      const [chainView, setChainView] = useState(null);
      // 0.5.6-C：服务端 readState 认的会话 id（诊断位 data-cr-relay-state 用；null = 还没加载）。
      const [stateSession, setStateSession] = useState(null);
      // 上一次渲染时的 sessionId：只有真的换会话才清链（刷新不清，避免闪一下）。
      const lastSessionRef = useRef(null);
      const [open, setOpen] = useState(false);
      const [doc, setDoc] = useState(null);
      const [notice, setNotice] = useState(null);
      const [anchor, setAnchor] = useState(null);
      const theme = useAutoTheme();
      const rootRef = useRef(null);
      const triggerRef = useRef(null);
      const menuRef = useRef(null);
      const docRequestRef = useRef(0);
      const docAbortRef = useRef(null);
      // 完整链接力式的请求序号（关菜单/换会话/重试时让晚到的响应失效）与断点。
      const chainRequestRef = useRef(0);
      const chainResumeRef = useRef(null);
      // 0.5.6-C：整链端点兜底只做一次（每次换会话重置）——避免静默刷新/重试反复读整份日志。
      const chainFallbackRef = useRef(false);

      /** 取消未完成的交接单读取；同时让晚到的响应失效（requestId 对不上）。 */
      const abortDoc = useCallback(() => {
        docRequestRef.current += 1;
        if (docAbortRef.current !== null) {
          try {
            docAbortRef.current.abort();
          } catch {
            /* ignore */
          }
          docAbortRef.current = null;
        }
      }, []);

      // 0.5.1 批 3：完整链的「收摊」——让晚到的逐级响应失效，并丢掉列表与断点。
      const closeChainView = useCallback(() => {
        chainRequestRef.current += 1;
        chainResumeRef.current = null;
        setChainView(null);
      }, []);

      const closeMenu = useCallback(() => {
        abortDoc();
        closeChainView();
        setOpen(false);
        setDoc(null);
        setNotice(null);
        setForceView(null);
      }, [abortDoc, closeChainView]);

      // 从交接单详情回到菜单列表：取消读取，避免「返回后又被晚到的响应撑开」。
      const backToMenu = useCallback(() => {
        abortDoc();
        setDoc(null);
      }, [abortDoc]);

      // 读链状态。会话刚打开时宿主可能还没把日志装进内存（readState.sessionId 为
      // null），这时要重试几次；一旦宿主确认「就是这个会话且没有 chain」就停，
      // 普通会话不会无限打接口。fetch 失败/老宿主没有 chain → setChain(null) → 不渲染。
      //
      // 0.5.6-C 磁盘兜底：state 只认内存（没加载的会话 target=null、chain=null），所以
      // 下面两处会用 0.5.1 已有的整链端点（读持久化、不要求 live）再试一次：
      //   1. state 已加载、但说 `hasParent:true` 却没有 chain（“有父会话但没链”）；
      //   2. state 连续 12 次都认不出本会话（宿主一直没把它装进内存）。
      // 兜底每会话只做一次（chainFallbackRef）：普通根会话（hasParent:false）零额外请求，
      // 也不会因为静默刷新/重试反复读整份日志。
      useEffect(() => {
        // 换会话/没有会话时才清掉上一条链（dock 组件可能被复用而不是重挂）。
        // 0.5.1 DCR-03：`refreshKey`（打开菜单后刷新）**不清链**——否则菜单一打开、
        // 接力条会先消失再出现。
        const sessionChanged = lastSessionRef.current !== sessionId;
        lastSessionRef.current = sessionId;
        if (sessionChanged) {
          setChain(null);
          setNext(null);
          setParentArchived(null);
          setNextArchived(null);
          setServerUnarchive(null);
          setServerForceArchive(null);
          setParentPinned(null);
          setForceView(null);
          setOpen(false);
          setDoc(null);
          setNotice(null);
          setStateSession(null);
          // 换会话：完整链的断点与结果都不再属于当前会话。
          chainRequestRef.current += 1;
          chainResumeRef.current = null;
          setChainView(null);
          // 0.5.6-C：兜底额度属于「这一次会话」，换会话重新给一次。
          chainFallbackRef.current = false;
        }
        if (!hasSession) return undefined;
        let dead = false;
        let timer = 0;
        let attempts = 0;
        // 静默刷新（菜单打开时）：链已经在显示，失败/未加载就不再排队重试，也不清链。
        const silent = sessionChanged === false;
        const url = `/api/compact-relay-state?sessionId=${encodeURIComponent(sessionId)}`;
        /**
         * 0.5.6-C：磁盘兜底 —— 用整链端点（0.5.1 已有）合成入站 chain。
         *
         * 整链端点读持久化日志/header（不要求会话 live），`rows[0]` 就是直接父会话那一行；
         * 因此「宿主没加载本会话（state 认不出）」时也能画出接力条（0.5.6 的 A2 兜底）。
         * 老宿主没有端点（404/unsupported）/磁盘也读不到 → false，保持原状（不渲染、不报错）。
         * @returns {Promise<boolean>} true = 已 setChain（接力条可以渲染）
         */
        async function rescueFromDisk() {
          if (chainFallbackRef.current) return false;
          chainFallbackRef.current = true;
          try {
            const res = await fetch(`${RELAY_CHAIN_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, {
              cache: 'no-store',
            });
            if (dead) return false;
            // 4xx（老插件没有这个端点/鉴权）：等下去也不会变，静默保持现状。
            if (!res.ok) return false;
            const payload = await res.json().catch(() => null);
            if (dead) return false;
            if (payload === null || typeof payload !== 'object' || payload.ok === false) return false;
            const synthesized = relayBarChainFromRows(relayChainRowsOf(payload), sessionId);
            if (synthesized === null) return false;
            setChain(synthesized);
            // 兜底只拿到链本身；归档/置顶/能力位仍以 state 为准（state 认不出会话时保持
            // null=不知道，菜单按「可尝试恢复」处理，与老宿主语义一致）。
            if (synthesized.path === null && synthesized.parentId !== null) void loadParentPath(synthesized);
            return true;
          } catch {
            /* 宿主不在/网络失败：保持「没有链」 */
            return false;
          }
        }
        const schedule = () => {
          if (dead || silent) return;
          attempts += 1;
          if (attempts > 12) {
            // 0.5.6-C：宿主一直没加载本会话（重试耗尽）→ 磁盘兜底一次；失败就静默放弃。
            void rescueFromDisk();
            return;
          }
          timer = setTimeout(() => {
            void load();
          }, Math.min(500 * attempts, 3000));
        };
        async function loadParentPath(localChain) {
          try {
            const res = await fetch(`/api/compact-relay-state?sessionId=${encodeURIComponent(localChain.parentId)}`, {
              cache: 'no-store',
            });
            if (dead || !res.ok) return;
            const parentData = await res.json().catch(() => null);
            if (dead) return;
            // 0.5.1 DCR-01：父会话的 chain 是它自己的入站记录，这一跳的出站在 next 里。
            const parentChain = relayOutboundProjectionOf(parentData);
            if (
              parentChain === null ||
              parentChain.childId !== sessionId ||
              parentChain.ordinal !== localChain.ordinal ||
              parentChain.path === null
            ) {
              return;
            }
            setChain((previous) => (previous === null ? previous : { ...previous, path: parentChain.path }));
          } catch {
            /* 父会话读不到（未加载/已归档）：保持「暂无交接单」，不影响接力条本身 */
          }
        }
        async function load() {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (dead) return;
            if (!res.ok) {
              // 4xx（鉴权/端点不存在）等下去也不会变；5xx/网络抖动才重试。
              if (res.status >= 400 && res.status < 500) return;
              schedule();
              return;
            }
            const data = await res.json().catch(() => null);
            if (dead) return;
            if (data !== null && typeof data === 'object' && data.ok === false) return;
            // 0.5.6-C：诊断位要能看出「服务端认的是哪个会话」（'null' = 还没加载）。
            setStateSession(
              data !== null && typeof data === 'object' && typeof data.sessionId === 'string' && data.sessionId.length > 0
                ? data.sessionId
                : null,
            );
            const parsed = relayBarChainOf(data, sessionId);
            // 0.5.1 批 3：父会话侧的出站目标。它和 chain 是两条独立的投影：子会话只有
            // chain，父会话只有 next，中段会话两个都有 —— 任一存在就要渲染接力条。
            const outbound = relayBarNextOf(data, sessionId);
            if (parsed !== null || outbound !== null) {
              setChain(parsed);
              setNext(outbound);
              setParentArchived(relayBarParentArchivedOf(data));
              setNextArchived(relayBarNextArchivedOf(data));
              setServerUnarchive(relayBarUnarchiveCapabilityOf(data));
              // 0.5.2 L 项：强制归档的能力位与旧会话置顶状态（二次确认文案用）。
              setServerForceArchive(relayBarForceArchiveCapabilityOf(data));
              setParentPinned(relayBarParentPinnedOf(data));
              // F3 的子会话记录不带 path（交接单路径只写在父记录里）：向父会话读回
              // 同一条链，childId 指回本会话且链号一致时才采用它的 path。只读、失败
              // 就保持「暂无交接单」；不碰宿主逻辑，也不改交接流程。
              if (parsed !== null && parsed.path === null && parsed.parentId !== null) void loadParentPath(parsed);
              return;
            }
            // sessionId 对不上/为 null → 宿主还没加载本会话，继续等；对得上 → 确定没有链。
            const loaded =
              data !== null && typeof data === 'object' && typeof data.sessionId === 'string' && data.sessionId === sessionId;
            // 0.5.6-C：宿主说「这个会话可能有父会话」但没有链（A1 类）→ 走磁盘兜底一次。
            // hasParent=false 的普通会话不请求链端点（避免每次打开都读整份日志）。
            const mayHaveParent = data !== null && typeof data === 'object' && data.hasParent === true;
            if (loaded && mayHaveParent) {
              // 兜底链条目里的「恢复旧会话 / 强制归档」仍需要宿主能力位（state 有就落地）。
              setServerUnarchive(relayBarUnarchiveCapabilityOf(data));
              setServerForceArchive(relayBarForceArchiveCapabilityOf(data));
              if (await rescueFromDisk()) return;
            }
            if (loaded) {
              // 静默刷新时宿主确认「没有链」也不清（保持在显示的接力条，避免误伤）。
              if (!silent) {
                setChain(null);
                setNext(null);
                setParentArchived(null);
                setNextArchived(null);
                setServerUnarchive(null);
                setServerForceArchive(null);
                setParentPinned(null);
              }
            } else schedule();
          } catch {
            /* 宿主不在/网络失败：保持「没有链」—— 不显示，不占高度；稍后再试 */
            schedule();
          }
        }
        void load();
        return () => {
          dead = true;
          if (timer !== 0) clearTimeout(timer);
        };
      }, [hasSession, sessionId, refreshKey]);

      // 0.5.6-C：接力条诊断位（零布局影响、零额外请求）——真机一条表达式即可分清
      // 「dock 没挂载 / 组件崩过被宿主下线 / 挂了但没链 / 服务端没认会话」：
      //   documentElement.dataset.crRelayDock   '1'（组件确实挂载且 effect 跑过）
      //   documentElement.dataset.crRelayChain  '<ordinal>' 或 'none'
      //   documentElement.dataset.crRelayState  服务端 readState 认的 sessionId 或 'null'
      // 判读表与取证步骤见 docs/relay-bar-debug.md。写失败（SSR/老宿主无 dataset）不影响接力条。
      useEffect(() => {
        try {
          const root = typeof document === 'undefined' || document === null ? null : document.documentElement;
          const dataset = root === null || root === undefined ? null : root.dataset;
          if (dataset === null || dataset === undefined) return;
          dataset.crRelayDock = '1';
          dataset.crRelayChain = chain !== null ? String(chain.ordinal) : next !== null ? String(next.ordinal) : 'none';
          dataset.crRelayState = stateSession === null ? 'null' : stateSession;
        } catch {
          /* 诊断位写失败不影响接力条本身 */
        }
      }, [chain, next, stateSession]);

      // 菜单打开时按这一行的真实位置重算锚点（滚动/缩放不漂）。
      useEffect(() => {
        if (!open) return undefined;
        const update = () => {
          const root = rootRef.current;
          const el = root === null || root === undefined ? null : root.firstElementChild;
          if (el === null || el === undefined || typeof el.getBoundingClientRect !== 'function') return;
          const rect = el.getBoundingClientRect();
          setAnchor({
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
          });
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
          window.removeEventListener('scroll', update, true);
          window.removeEventListener('resize', update);
        };
      }, [open]);

      // 点外面 / Esc 关闭菜单与交接单查看。
      useEffect(() => {
        if (!open) return undefined;
        const inside = (target) => {
          const root = rootRef.current;
          const menu = menuRef.current;
          return (root !== null && root !== undefined && root.contains(target)) || (menu !== null && menu !== undefined && menu.contains(target));
        };
        const onDown = (event) => {
          if (inside(event.target)) return;
          closeMenu();
        };
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          closeMenu();
          const trigger = triggerRef.current;
          if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') {
            window.setTimeout(() => trigger.focus(), 0);
          }
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open, closeMenu]);

      // 打开后把焦点送进第一个可操作项（键盘用户不用再 Tab 找）。
      useEffect(() => {
        if (!open || doc !== null) return;
        const menu = menuRef.current;
        if (menu === null || menu === undefined || typeof menu.querySelector !== 'function') return;
        const first = menu.querySelector('button:not(:disabled)');
        if (first !== null && first !== undefined && typeof first.focus === 'function') first.focus();
      }, [open, doc]);

      const toggleMenu = useCallback((event) => {
        const current = event === null || event === undefined ? null : event.currentTarget;
        if (current !== null && current !== undefined && typeof current.getBoundingClientRect === 'function') {
          const rect = current.getBoundingClientRect();
          setAnchor({
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
          });
        }
        abortDoc();
        setNotice(null);
        setDoc(null);
        // 0.5.2 L 项：重开菜单一律回到主列表（强制归档确认面板不残留、不误触）。
        setForceView(null);
        // 每次开/关都把完整链收掉：重开菜单从主列表开始（不预加载，也不留旧会话的链）。
        closeChainView();
        // 0.5.1 DCR-03：打开菜单前刷新一次 state —— 归档集合可能在别处被改（侧栏
        // 取消归档 / 另一个窗口归档），沿用打开前的旧状态会让「恢复旧会话」变死入口。
        if (!open) setRefreshKey((key) => key + 1);
        setOpen((value) => !value);
      }, [abortDoc, closeChainView, open]);

      const loadDoc = useCallback(async (name) => {
        if (typeof name !== 'string' || name.length === 0) return;
        if (docAbortRef.current !== null) {
          try {
            docAbortRef.current.abort();
          } catch {
            /* ignore */
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        docAbortRef.current = controller;
        const requestId = ++docRequestRef.current;
        setDoc({ loading: true, name });
        setNotice(null);
        try {
          const res = await fetch(`/api/compact-relay-handoffs?file=${encodeURIComponent(name)}`, {
            cache: 'no-store',
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (requestId !== docRequestRef.current) return;
          if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '读取失败');
          setDoc({
            loading: false,
            name,
            content: typeof data.content === 'string' ? data.content : '',
            path: typeof data.path === 'string' ? data.path : null,
          });
        } catch (error) {
          if (requestId !== docRequestRef.current || (error && error.name === 'AbortError')) return;
          setDoc({
            loading: false,
            name,
            error: '读取失败：' + (error && error.message ? error.message : '未知错误'),
          });
        } finally {
          if (requestId === docRequestRef.current) docAbortRef.current = null;
        }
      }, []);

      /** 切到某个会话（不碰归档状态）；成功发起返回 true。 */
      const openTarget = useCallback(
        (target, failureText) => {
          if (typeof openSession !== 'function') {
            setNotice('这个宿主不支持切换会话，无法自动打开会话。');
            setOpen(true);
            return false;
          }
          const failed = (error) => {
            setNotice(failureText + '：' + (error && error.message ? error.message : '未知错误'));
            setOpen(true);
          };
          try {
            const result = openSession(target);
            if (result !== null && result !== undefined && typeof result.then === 'function') {
              result.catch(failed);
            }
            setOpen(false);
            setDoc(null);
            closeChainView();
            return true;
          } catch (error) {
            failed(error);
            return false;
          }
        },
        [closeChainView, openSession],
      );

      /**
       * 0.5.0 / 0.5.1 DCR-03：恢复归档会话并切过去（父会话、完整链上任意一层、下一代都走这里）。
       *
       * 两条通道：
       *   1. 宿主 Client 侧 `ctx.uiWorkspace.unarchiveSession`（与侧栏「取消归档」同一条
       *      接缝，会同步更新本地归档集合）；
       *   2. 本插件 HTTP `action:'recover'`（服务端 workspaceRegistry.unarchiveSession）——
       *      老宿主没有客户端 API 时的兜底。
       * 失败重试：一轮 unarchive+open 失败后换另一条通道再试一次（只有一条通道时同通道
       * 重试），仍失败才提示错误。unarchive 幂等：重试不会把会话再归档，未归档时是 no-op。
       *
       * @param {string} target 目标会话 id
       * @param {{markParent?:boolean, failureText?:string, restoredText?:string}} [options]
       *   markParent：成功后把本地「父会话归档状态」改成未归档（只有父会话需要）。
       */
      /**
       * 恢复归档会话的两条通道（0.5.1 DCR-03 抽出，DCR-05 的「打开并继续」复用）。
       *
       *   1. 宿主 Client 侧 `ctx.uiWorkspace.unarchiveSession`（与侧栏「取消归档」同一条
       *      接缝，会同步更新本地归档集合）；
       *   2. 本插件 HTTP `action:'recover'`（服务端 workspaceRegistry.unarchiveSession）——
       *      老宿主没有客户端 API 时的兜底。
       *
       * 返回按优先级排好的尝试序列；调用方逐个 await，失败换下一条。
       * @param {string} target 目标会话 id
       * @returns {Array<() => Promise<unknown>>}
       */
      const unarchiveChannels = useCallback(
        (target) => {
          const unarchiveViaHost = async () => {
            if (typeof unarchiveSession !== 'function') throw new Error('这个宿主没有 unarchiveSession');
            await unarchiveSession(target);
          };
          const unarchiveViaHttp = async () => {
            const res = await fetch('/api/compact-relay-action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              cache: 'no-store',
              body: JSON.stringify({ action: 'recover', sessionId: target }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || data === null || data.ok === false) {
              throw new Error(data !== null && typeof data.message === 'string' ? data.message : '恢复接口不可用');
            }
          };
          // 通道顺序：宿主 API 优先；只有一条通道时同通道重试（「失败重试 unarchive+open」）。
          return typeof unarchiveSession === 'function'
            ? [unarchiveViaHost, unarchiveViaHttp]
            : [unarchiveViaHttp, unarchiveViaHttp];
        },
        [unarchiveSession],
      );

      const restoreAndOpen = useCallback(
        (target, options = {}) => {
          const markParent = options.markParent === true;
          const failureText = typeof options.failureText === 'string' ? options.failureText : '恢复旧会话失败';
          const restoredText =
            typeof options.restoredText === 'string'
              ? options.restoredText
              : '旧会话已恢复，但这个宿主不支持自动切换；请从侧栏打开。';
          setNotice(null);

          const channels = unarchiveChannels(target);

          // 一轮 = unarchive 成功后再 open。open 失败也走下一轮（可能恢复没生效/宿主还没刷新）。
          const attempt = async (unarchive) => {
            await unarchive();
            if (markParent) setParentArchived(false);
            if (typeof openSession !== 'function') {
              setNotice(restoredText);
              setOpen(true);
              return;
            }
            await openSession(target);
            setOpen(false);
            setDoc(null);
            closeChainView();
          };

          return (async () => {
            let failure = null;
            for (const channel of channels) {
              try {
                await attempt(channel);
                return;
              } catch (error) {
                failure = error;
              }
            }
            setNotice(failureText + '：' + (failure && failure.message ? failure.message : '未知错误'));
            setOpen(true);
          })();
        },
        [closeChainView, openSession, unarchiveChannels],
      );

      // 0.5.1 DCR-03：能不能恢复 = 客户端有宿主 API，或服务端说它有 registry.unarchiveSession。
      // serverUnarchive === null（老插件没有 capabilities 字段）按「可尝试」处理（recover 幂等）。
      const canRestore = typeof unarchiveSession === 'function' || serverUnarchive !== false;

      const goParent = useCallback(() => {
        setNotice(null);
        if (chain === null || chain.parentId === null) return;
        // 已归档（true）或宿主没给归档状态（null）：都不能假设「未归档」直接打开 ——
        // 打开被归档的会话会被宿主拒绝，这个入口就成了死路（DCR-03）。
        // 有恢复能力时先 unarchive 再 open（unarchive 幂等，未归档时是 no-op）。
        if (parentArchived !== false && canRestore) {
          void restoreAndOpen(chain.parentId, { markParent: true });
          return;
        }
        openTarget(chain.parentId, '打不开原会话');
      }, [canRestore, chain, openTarget, parentArchived, restoreAndOpen]);

      /**
       * 0.5.1 批 3（TD-01）：父会话侧「去新会话」—— 用出站记录的目标 childId 切过去。
       *
       * 下一代可能已经被用户归档（`nextArchived`），宿主同样拒绝打开归档会话，所以
       * 和「回到原会话」同口径：归档/不知道就先 unarchive 再 open（unarchive 幂等）。
       */
      const goNext = useCallback(() => {
        setNotice(null);
        if (next === null || next.childId === null) return;
        if (nextArchived !== false && canRestore) {
          void restoreAndOpen(next.childId, {
            failureText: '恢复新会话失败',
            restoredText: '新会话已恢复，但这个宿主不支持自动切换；请从侧栏打开。',
          });
          return;
        }
        openTarget(next.childId, '打不开新会话');
      }, [canRestore, next, nextArchived, openTarget, restoreAndOpen]);

      /** 完整链某一层：跳过去（旧会话默认已归档，同口径先恢复再切）。 */
      const openAncestor = useCallback(
        (target) => {
          if (typeof target !== 'string' || target.length === 0) return;
          setNotice(null);
          if (canRestore) {
            void restoreAndOpen(target, {
              failureText: '打不开旧会话',
              restoredText: '旧会话已恢复，但这个宿主不支持自动切换；请从侧栏打开。',
            });
            return;
          }
          openTarget(target, '打不开旧会话');
        },
        [canRestore, openTarget, restoreAndOpen],
      );

      /**
       * 0.5.1 DCR-05：优先让服务端一次读出整条链（只读持久化日志，不加载祖先会话）。
       *
       * 返回 true = 端点可用且已把结果写进 chainView（成功或带 unreadable 的部分结果）；
       * false = 老插件/老宿主没有这个端点、或响应形状不对 —— 调用方回落到旧的逐级读法。
       *
       * 为什么能解决「只显示 1 层」：宿主对未加载的会话返回 `sessionId:null`，旧逐级
       * GET 只能停住；新端点从持久化 header/log 里读，祖先没打开也能列全。
       *
       * @param {number} requestId 与 chainRequestRef 对齐的请求序号（晚到响应作废）
       * @returns {Promise<boolean>}
       */
      const loadChainViaServer = useCallback(
        async (requestId) => {
          let res = null;
          let data = null;
          try {
            res = await fetch(`${RELAY_CHAIN_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, {
              cache: 'no-store',
            });
            if (res.ok) data = await res.json().catch(() => null);
          } catch {
            res = null;
            data = null;
          }
          if (requestId !== chainRequestRef.current) return true;
          if (res === null || !res.ok || data === null || typeof data !== 'object' || data.ok !== true) return false;
          const rows = relayChainRowsOf(data);
          if (rows === null) return false;
          const unreadable = data.unreadable;
          const unreadableId =
            unreadable !== null && typeof unreadable === 'object' && typeof unreadable.sessionId === 'string'
              ? unreadable.sessionId
              : null;
          // not-found = 持久化里根本没有这个会话（已删除/从未落盘）：打开也救不回来，
          // 只给「重试」，不造一个必然失败的入口（与 DCR-03 隐藏死入口同口径）。
          // error = 读日志临时失败：会话可能只是没加载/没落盘，允许「打开并继续」。
          const blocked =
            unreadableId !== null && unreadable.reason !== 'not-found'
              ? { sessionId: unreadableId, reason: 'error' }
              : null;
          // 服务端已经一次读完：这里没有逐级断点，重试就是重发一次整链请求。
          chainResumeRef.current = null;
          setChainView({
            rows,
            loading: false,
            error: unreadableId === null ? null : '无法读取更早的链路',
            done: unreadableId === null && data.done !== false,
            capped: data.capped === true,
            blocked,
          });
          return true;
        },
        [sessionId],
      );

      /**
       * 0.5.1 批 3 / DCR-05：完整交接链 —— **按需**读祖先会话（不预加载、无常驻轮询）。
       *
       * 先走一次整链端点（见上）；老宿主没有端点时回落逐级 state 读法：
       * 每一行来自「下一层（子）会话的入站 chain」，ordinal/baseTitle 正好是那一层会话
       * 改名后的「历史 N：原名」；交接单路径优先用它自己记录里的 path，缺了再向那一层
       * 会话的 state 要出站 next 的 path（和接力条补 path 同口径，childId/链号都要对得上）。
       *
       * 频率口径：点开「完整交接链」后才开始拉；回落路径每层一次 state GET（不并发、不轰炸）；
       * 最多 `MAX_CHAIN_HOPS` 跳；`seen` 按 sessionId 去重（链路万一成环也不会转圈）。
       * 某层读不到就停在断点：已读到的行保留；未加载给「打开并继续」，其它失败给「重试」。
       *
       * @param {{cursor:object|null, childId:string, rows:Array, seen:Set<string>}|null} resume
       *   断点；null/undefined = 从本会话重新开始（先试整链端点）。
       */
      const loadChain = useCallback(
        async (resume) => {
          const requestId = ++chainRequestRef.current;
          // 0.5.1 DCR-05：先试一次整链端点；老宿主没有就回落逐级 state（下面的旧逻辑）。
          if (resume === undefined || resume === null) {
            const handled = await loadChainViaServer(requestId);
            if (handled) return;
            if (requestId !== chainRequestRef.current) return;
          }
          const start =
            resume === undefined || resume === null
              ? {
                  cursor: chain === null ? null : { ...chain },
                  childId: sessionId,
                  rows: [],
                  seen: new Set(typeof sessionId === 'string' && sessionId.length > 0 ? [sessionId] : []),
                }
              : resume;
          let cursor = start.cursor;
          let childId = start.childId;
          let seen = start.seen;
          let rows = start.rows;
          const publish = (patch) => {
            if (requestId !== chainRequestRef.current) return;
            setChainView({ rows, loading: true, error: null, done: false, capped: false, blocked: null, ...patch });
          };
          publish({});
          while (cursor !== null && cursor.parentId !== null) {
            if (rows.length >= MAX_CHAIN_HOPS) {
              publish({ loading: false, done: true, capped: true });
              return;
            }
            const parentId = cursor.parentId;
            if (seen.has(parentId)) {
              // 链路成环/自指：到此为止，不重复列同一条会话。
              publish({ loading: false, done: true, capped: false });
              return;
            }
            let data = null;
            try {
              const res = await fetch(`/api/compact-relay-state?sessionId=${encodeURIComponent(parentId)}`, {
                cache: 'no-store',
              });
              if (requestId !== chainRequestRef.current) return;
              // 4xx（鉴权/端点不存在）与 5xx 一样当作「这一层读不到」：不再自动重试，
              // 交给用户的「重试」入口（自动重试只留给接力条自己那次 state）。
              if (res.ok) data = await res.json().catch(() => null);
            } catch {
              data = null;
            }
            if (requestId !== chainRequestRef.current) return;
            // 读不到 = HTTP/解析失败，或者**宿主还没把这一层加载进内存**（`sessionId` 对不上，
            // 重启后祖先会话通常就是这样 —— 不能把「没加载」当成「没有父会话」到头了）。
            // 两种都停在断点：已读到的行保留。宿主明确回 sessionId:null 时给出可操作入口
            // 「上一层会话未打开 → 打开并继续」（DCR-05 兜底）；其它失败仍只给「重试」。
            const loaded =
              data !== null &&
              typeof data === 'object' &&
              data.ok !== false &&
              typeof data.sessionId === 'string' &&
              data.sessionId === parentId;
            if (!loaded) {
              chainResumeRef.current = { cursor, childId, rows, seen };
              const notLoaded =
                data !== null && typeof data === 'object' && data.ok !== false && data.sessionId === null;
              publish({
                loading: false,
                error: notLoaded ? '上一层会话未打开' : '无法读取更早的链路',
                done: false,
                blocked: notLoaded ? { sessionId: parentId, reason: 'unloaded' } : null,
              });
              return;
            }
            const outbound = relayBarNextOf(data, parentId);
            const path =
              cursor.path !== null
                ? cursor.path
                : outbound !== null && outbound.childId === childId && outbound.ordinal === cursor.ordinal
                  ? outbound.path
                  : null;
            rows = [
              ...rows,
              { sessionId: parentId, ordinal: cursor.ordinal, baseTitle: cursor.baseTitle, scheme: cursor.scheme, path },
            ];
            seen = new Set([...seen, parentId]);
            publish({});
            childId = parentId;
            // 这一层自己的入站 chain 才是「更早的链路」；没有就说明到头了。
            cursor = relayChainProjectionOf(data);
          }
          chainResumeRef.current = null;
          publish({ loading: false, done: true, capped: false });
        },
        [chain, loadChainViaServer, sessionId],
      );

      const openChainList = useCallback(() => {
        setNotice(null);
        setDoc(null);
        chainResumeRef.current = null;
        void loadChain(null);
      }, [loadChain]);

      /** 某层读不到之后的「重试」：从断点继续，已读到的层不重复拉。 */
      const retryChain = useCallback(() => {
        const resume = chainResumeRef.current;
        if (resume === null || resume === undefined) {
          void loadChain(null);
          return;
        }
        void loadChain(resume);
      }, [loadChain]);

      /**
       * 0.5.1 DCR-05 兜底：等宿主把刚刚 openSession 的会话装进内存。
       *
       * 只读 `/api/compact-relay-state?sessionId=`，`sessionId` 对得上才算加载完成；
       * 最多 8 次（约 1 秒）。宿主打开会话需要一点时间，立刻续读会再次撞上「未加载」。
       * @param {string} target 刚打开的会话 id
       * @returns {Promise<boolean>}
       */
      const waitForSessionLoaded = useCallback(async (target) => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            const res = await fetch(`/api/compact-relay-state?sessionId=${encodeURIComponent(target)}`, {
              cache: 'no-store',
            });
            if (res.ok) {
              const data = await res.json().catch(() => null);
              if (
                data !== null &&
                typeof data === 'object' &&
                data.ok !== false &&
                data.sessionId === target
              ) {
                return true;
              }
            }
          } catch {
            /* 宿主还没加载：继续等 */
          }
          if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return false;
      }, []);

      /**
       * 0.5.1 DCR-05 兜底：断点处「打开并继续」。
       *
       *   1. 双通道 unarchive（复用现有；幂等，未归档时 no-op，失败也继续尝试 open）；
       *   2. `openSession(parentId)` 打开上一层会话；
       *   3. 等宿主加载后自动 `loadChain(resume)`；加载不上就提示「已打开，再点完整交接链继续」。
       *
       * 注意：真实宿主打开会话会切路由，组件可能被卸载——此时后续 setState 是 no-op，
       * 不会报错；用户在新会话里点「完整交接链」也能接着看。
       */
      const openAndResumeChain = useCallback(async () => {
        const blocked = chainView === null ? null : chainView.blocked;
        if (blocked === null || blocked === undefined || typeof blocked.sessionId !== 'string') return;
        const target = blocked.sessionId;
        const resume = chainResumeRef.current;
        setNotice(null);
        setChainView((previous) =>
          previous === null ? previous : { ...previous, loading: true, error: null, blocked: null },
        );

        // 先恢复（两条通道都试；都失败也不阻塞打开——也许本来就没归档）。
        for (const channel of unarchiveChannels(target)) {
          try {
            await channel();
            break;
          } catch {
            /* 换下一条通道；仍失败就直接尝试打开 */
          }
        }

        if (typeof openSession !== 'function') {
          setNotice('这个宿主不支持切换会话，无法自动打开上一层会话。');
          setChainView((previous) =>
            previous === null ? previous : { ...previous, loading: false, error: '上一层会话未打开', blocked },
          );
          return;
        }
        try {
          await openSession(target);
        } catch (error) {
          setNotice('打开上一层会话失败：' + (error && error.message ? error.message : '未知错误'));
          setChainView((previous) =>
            previous === null ? previous : { ...previous, loading: false, error: '上一层会话未打开', blocked },
          );
          return;
        }

        if (!(await waitForSessionLoaded(target))) {
          setNotice('已打开上一层会话，再点「完整交接链」继续。');
          setChainView((previous) =>
            previous === null ? previous : { ...previous, loading: false, error: '上一层会话未打开', blocked },
          );
          return;
        }
        await loadChain(resume);
      }, [chainView, loadChain, openSession, unarchiveChannels, waitForSessionLoaded]);

      /** 从完整链返回主菜单（保留断点？不：回主菜单再从主菜单进来就是重新拉一遍）。 */
      const backFromChain = useCallback(() => {
        closeChainView();
      }, [closeChainView]);

      // ------------------------------------------------------------------
      // 0.5.2 L 项：强制归档旧会话（显式二次确认；唯一会 stopActivity 的用户入口）
      //
      // 0.5.6-C 修复（hooks 顺序 —— 已用 React 18.3 复现）：这两个 useCallback 以及
      // 下面的 backFromForce 原本写在「两个方向都没有 → return null」之后（0.5.2 加进来）。
      // 首帧 chain/next 都是 null → 组件少调用 3 个 hook 后返回 null；等链路到达的下一帧
      // 却多调用 3 个 hook → React 抛 "Rendered more hooks than during the previous render."
      // → 宿主 SlotErrorBoundary 捕获并 abdicate 这个 list 条目 → 该会话里接力条**永久**
      // 不显示（与 Win「完全无条、刷新依旧」同形；这条路径与数据是否齐全无关）。
      // 修复 = 把 hook 调用全部提到提前 return 之前；运行逻辑/依赖数组一个字节不改。
      // ------------------------------------------------------------------

      /**
       * 打开强制归档的二次确认面板（只改本地视图，不发请求）。
       *
       * 默认行为不变：自动归档遇到活跃会话仍然「保留可见不归档」；只有用户在这个
       * 确认面板里再点一次「强制归档（停止任务）」才会调用服务端。
       * @param {string} target 旧会话 id（入站 parentId）
       */
      const openForceConfirm = useCallback(
        (target) => {
          if (typeof target !== 'string' || target.length === 0) return;
          abortDoc();
          setNotice(null);
          setDoc(null);
          closeChainView();
          setForceView({ phase: 'confirm', target });
        },
        [abortDoc, closeChainView],
      );

      /**
       * 执行强制归档：POST `action:'force-archive'`（服务端 → registry.archiveSession(id,{stopActivity:true})）。
       *
       * 只有用户点过确认才会走到这里。成功时复用 `handoffArchiveNoteOf` 的现有三套文案
       * （archived / already / pinned，含「归档会取消置顶」的置顶提示）；失败时可读错误
       * 写进面板，不静默。`pinned` 不是失败：它表示宿主里旧会话其实还置顶、需要用户
       * 再确认一次「归档并取消置顶」，面板会给出这个出口。
       *
       * @param {string} target 旧会话 id（入站 parentId）
       * @param {{confirmUnpin?:boolean}} [options] true = 用户已确认「归档会取消置顶」
       */
      const runForceArchive = useCallback((target, options = {}) => {
        const confirmUnpin = options.confirmUnpin === true;
        if (typeof target !== 'string' || target.length === 0) return Promise.resolve();
        setNotice(null);
        setForceView({ phase: 'busy', target, confirmUnpin });
        return (async () => {
          try {
            const res = await fetch('/api/compact-relay-action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              cache: 'no-store',
              body: JSON.stringify({
                action: 'force-archive',
                sessionId: target,
                // 二次确认的凭证：服务端没有 confirmStop:true 一律拒绝（不会静默停任务）。
                confirmStop: true,
                ...(confirmUnpin ? { confirmUnpin: true } : {}),
              }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || data === null || typeof data !== 'object' || data.ok === false) {
              const message =
                data !== null && typeof data === 'object' && typeof data.message === 'string' && data.message.length > 0
                  ? data.message
                  : '强制归档接口不可用';
              throw new Error(message);
            }
            // archived / already 都意味着旧会话已在归档集合里（already 幂等，没有重复停任务）。
            if (data.status === 'archived' || data.status === 'already') setParentArchived(true);
            setForceView({
              phase: 'done',
              target,
              status: typeof data.status === 'string' ? data.status : 'archived',
              note:
                typeof data.note === 'string' && data.note.length > 0
                  ? data.note
                  : '旧会话已归档（可在新会话输入框上方「已接力自 …」→「恢复旧会话」找回）。',
            });
          } catch (error) {
            setForceView({
              phase: 'error',
              target,
              confirmUnpin,
              message: '强制归档失败：' + (error && error.message ? error.message : '未知错误'),
            });
          }
        })();
      }, []);

      /** 从确认/错误/结果面板回到主菜单列表（不关整个菜单，用户可继续用其他入口）。 */
      const backFromForce = useCallback(() => {
        setNotice(null);
        setForceView(null);
      }, []);

      // 两个方向都没有 → 什么都不渲染（不占 composerStack 的高度）。
      // 0.5.6-C：这一行必须在**所有** hook 调用之后（见上面强制归档段的注释）。
      if (chain === null && next === null) return null;

      const hasParent = chain !== null && chain.parentId !== null;
      const hasNext = next !== null && next.childId !== null;
      // 父会话侧（只有出站记录）这一行的摘要文案：它没有「已接力自」的来路。
      const label = chain !== null ? relayBarLabelOf(chain) : '已交接给新会话';
      // 「查看交接单」：子会话侧看进站那一跳，父会话侧看出站那一跳（不混用）。
      const docPath = chain !== null ? chain.path : next === null ? null : next.path;
      const docName = relayBarDocNameOf(docPath);
      // 归档状态已知且未归档 → 不需要恢复入口；true（已归档）或 null（老宿主不知道）
      // 都显示——恢复调用幂等，宁可多一个入口，也不让用户的旧会话找不回来。
      // 0.5.1 DCR-03：宿主客户端与服务端都没有恢复能力时**隐藏**入口（点了必然失败）。
      const showRestore = hasParent && parentArchived !== false && canRestore;
      // 0.5.2 L 项：强制归档入口 —— 旧会话**还没归档**时才需要它（已归档没什么可强制的）；
      // 服务端明确说没有 archiveSession 能力（false）时隐藏死入口；null（老插件没字段）
      // 仍显示，失败时会给出可读错误。
      const canForceArchive = serverForceArchive !== false;
      const showForceArchive = hasParent && parentArchived !== true && canForceArchive;
      const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
      const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
      const chainOpen = chainView !== null && doc === null;
      const forceOpen = forceView !== null && doc === null && chainView === null;
      const menuWidth = Math.min(doc !== null ? 420 : chainOpen ? 336 : forceOpen ? 320 : 272, Math.max(240, vw - 16));
      const estimatedHeight = doc !== null ? 360 : chainOpen ? 380 : forceOpen ? 300 : 168;
      const anchorTop = anchor === null ? vh - 96 : anchor.top;
      const anchorBottom = anchor === null ? vh - 40 : anchor.bottom;
      const openUp = anchorTop >= Math.min(estimatedHeight, vh - 16) + 12;
      const left = Math.max(8, Math.min(anchor === null ? 8 : anchor.left, Math.max(8, vw - menuWidth - 8)));
      const position = openUp
        ? { left, bottom: Math.max(8, vh - anchorTop + 6) }
        : { left, top: Math.min(Math.max(8, anchorBottom + 6), Math.max(8, vh - Math.min(estimatedHeight, vh - 16) - 8)) };

      const docPanel =
        doc === null
          ? null
          : h(
              'div',
              { role: 'dialog', 'aria-label': '交接单', 'data-cr-relay-doc': '1', style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    borderBottom: `1px solid ${theme.panelBorder}`,
                    fontSize: 12,
                    fontWeight: 600,
                  },
                },
                h('span', { style: { flex: 1, minWidth: 0 } }, '交接单'),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-cr-relay-doc-back': '1',
                    onClick: backToMenu,
                    style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                  },
                  '← 返回',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-cr-relay-doc-close': '1',
                    onClick: closeMenu,
                    style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                  },
                  '关闭',
                ),
              ),
              doc.loading === true
                ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: theme.subText } }, '读取中…')
                : doc.error !== undefined && doc.error !== null
                  ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: COLORS.error } }, String(doc.error))
                  : h(
                      'div',
                      { style: { overflowY: 'auto', overflowX: 'hidden', padding: '8px 12px', fontSize: 11, lineHeight: '16px', maxHeight: 'min(52vh, 320px)', wordBreak: 'break-word' } },
                      renderMarkdownLite(doc.content ?? ''),
                    ),
            );

      /**
       * 完整链的一行：整行点「跳到这一层会话」，行尾单独一个「交接单」入口。
       *
       * 交接单路径只认 handoff-*.md 的 basename（与接力条同一套校验；接口只收
       * basename），没有 path 就禁用——不给必然失败的入口。
       * @param {{sessionId:string, ordinal:number|null, baseTitle:string|null, scheme:string|null, path:string|null}} row
       */
      const chainRowItemOf = (row) => {
        const rowDoc = relayBarDocNameOf(row.path);
        return h(
          'div',
          {
            key: row.sessionId,
            'data-cr-relay-chain-row': row.sessionId,
            style: { display: 'flex', alignItems: 'stretch', gap: 6, borderRadius: 8 },
          },
          h(
            'button',
            {
              type: 'button',
              'data-cr-relay-chain-open': row.sessionId,
              title: `打开 ${relayBarLabelOf(row)}`,
              onClick: () => openAncestor(row.sessionId),
              style: {
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                padding: '5px 8px',
                border: 'none',
                borderRadius: 8,
                background: 'transparent',
                textAlign: 'left',
                color: 'var(--dsw-alias-label-primary, inherit)',
                font: 'inherit',
                cursor: 'pointer',
              },
              onMouseEnter: (event) => {
                event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))';
              },
              onMouseLeave: (event) => {
                event.currentTarget.style.background = 'transparent';
              },
            },
            h('span', { style: { fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, relayBarLabelOf(row)),
            h(
              'span',
              { style: { fontSize: 10, lineHeight: '14px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } },
              '打开这个会话（已归档会自动恢复）',
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              'data-cr-relay-chain-doc': row.sessionId,
              disabled: rowDoc === null,
              title: rowDoc === null ? '暂无交接单：这一层没有记录交接单路径' : '打开这一跳的交接单',
              onClick: () => {
                if (rowDoc !== null) void loadDoc(rowDoc);
              },
              style: {
                flex: 'none',
                alignSelf: 'center',
                border: `1px solid ${theme.panelBorder}`,
                borderRadius: 6,
                padding: '3px 8px',
                fontSize: 11,
                background: 'transparent',
                color: 'inherit',
                cursor: rowDoc === null ? 'default' : 'pointer',
                opacity: rowDoc === null ? 0.55 : 1,
              },
            },
            '交接单',
          ),
        );
      };

      /**
       * 完整交接链面板（点「完整交接链」后才出现；doc === null 时替换主列表）。
       *
       * 数据是按需逐级读来的（见 loadChain）：读取中显示进度行，读不到显示错误 +
       * 重试，到 8 跳上限显示「只显示最近 8 层」。「← 返回」回主菜单 —— 出错也只
       * 影响这一块，不阻断其他入口。
       */
      const chainPanel =
        chainView === null
          ? null
          : h(
              'div',
              { 'data-cr-relay-chain': '1', style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    borderBottom: `1px solid ${theme.panelBorder}`,
                    fontSize: 12,
                    fontWeight: 600,
                  },
                },
                h('span', { style: { flex: 1, minWidth: 0 } }, '完整交接链'),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-cr-relay-chain-back': '1',
                    onClick: backFromChain,
                    style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                  },
                  '← 返回',
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 5px', overflowY: 'auto', overflowX: 'hidden', maxHeight: 'min(46vh, 300px)' } },
                chainView.rows.map((row) => chainRowItemOf(row)),
                chainView.loading === true
                  ? h(
                      'div',
                      { 'data-cr-relay-chain-loading': '1', style: { padding: '5px 10px', fontSize: 11, color: theme.subText } },
                      '读取更早的链路…',
                    )
                  : null,
                chainView.capped === true
                  ? h(
                      'div',
                      { 'data-cr-relay-chain-capped': '1', style: { padding: '5px 10px', fontSize: 10, color: theme.subText } },
                      `只显示最近 ${MAX_CHAIN_HOPS} 层`,
                    )
                  : null,
                chainView.error !== null
                  ? h(
                      'div',
                      {
                        'data-cr-relay-chain-error': '1',
                        // 0.5.1 DCR-05：断点处是哪一层没读到（空串 = 普通读取失败，没有可打开的会话）。
                        'data-cr-relay-chain-blocked':
                          chainView.blocked === null || chainView.blocked === undefined
                            ? ''
                            : chainView.blocked.sessionId,
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 10px',
                          fontSize: 11,
                          color: 'var(--dsw-alias-state-error-primary, #D92D20)',
                        },
                      },
                      h('span', { style: { flex: 1, minWidth: 0 } }, String(chainView.error)),
                      chainView.blocked !== null && chainView.blocked !== undefined
                        ? h(
                            'button',
                            {
                              type: 'button',
                              'data-cr-relay-chain-open-parent': chainView.blocked.sessionId,
                              onClick: () => {
                                void openAndResumeChain();
                              },
                              title: `打开上一层会话 ${chainView.blocked.sessionId}，加载后自动续读`,
                              style: { flex: 'none', border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                            },
                            '打开并继续',
                          )
                        : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-relay-chain-retry': '1',
                          onClick: retryChain,
                          style: { flex: 'none', border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                        },
                        '重试',
                      ),
                    )
                  : null,
              ),
            );

      /**
       * 0.5.2 L 项：强制归档的二次确认 / 执行中 / 失败 / 结果面板。
       *
       * 破坏性后果写在标题下的第一段（「会停止旧会话上正在跑的任务」），而不是只靠
       * 按钮文案；置顶时再补一行「归档会同时取消置顶（宿主行为）」，与交接前的置顶
       * 确认同一口径。只有「强制归档（停止任务）」这个按钮会真的发请求。
       */
      const forcePanel =
        forceView === null
          ? null
          : h(
              'div',
              {
                role: 'dialog',
                'aria-label': '强制归档旧会话',
                'data-cr-force-archive': '1',
                'data-cr-force-phase': forceView.phase,
                'data-cr-force-target': typeof forceView.target === 'string' ? forceView.target : '',
                style: { display: 'flex', flexDirection: 'column', minHeight: 0 },
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    borderBottom: `1px solid ${theme.panelBorder}`,
                    fontSize: 12,
                    fontWeight: 600,
                  },
                },
                h('span', { style: { flex: 1, minWidth: 0 } }, '强制归档旧会话'),
                forceView.phase === 'busy'
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        'data-cr-force-back': '1',
                        onClick: backFromForce,
                        style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                      },
                      '← 返回',
                    ),
              ),
              forceView.phase === 'confirm'
                ? h(
                    'div',
                    {
                      'data-cr-force-confirm': '1',
                      style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', fontSize: 11, lineHeight: '16px' },
                    },
                    h('div', { style: { fontWeight: 600, color: theme.panelFg } }, `将强制归档旧会话「${label}」。`),
                    h(
                      'div',
                      {
                        'data-cr-force-warning': '1',
                        style: {
                          padding: '6px 8px',
                          borderRadius: 8,
                          border: `1px solid ${COLORS.error}`,
                          color: COLORS.error,
                          background: theme.hover,
                        },
                      },
                      '会停止旧会话上正在跑的任务（turn / 子代理 / 后台任务 / 定时任务），中断后无法恢复。',
                    ),
                    parentPinned === true
                      ? h('div', { 'data-cr-force-pin': '1', style: { color: theme.subText } }, '旧会话已在侧栏置顶：归档会同时取消置顶（宿主行为）。')
                      : parentPinned === null
                        ? h('div', { 'data-cr-force-pin': '1', style: { color: theme.subText } }, '宿主没提供置顶状态：若旧会话在侧栏置顶，归档会同时取消置顶（宿主行为）。')
                        : null,
                    h(
                      'div',
                      { style: { color: theme.subText } },
                      '这是显式操作：默认自动归档遇到活跃会话会「保留可见、不停止任务」，只有你在这里确认后才会停止旧会话上的任务。',
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-force-cancel': '1',
                          onClick: backFromForce,
                          style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 7, padding: '4px 10px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                        },
                        '取消',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-force-run': '1',
                          onClick: () => {
                            void runForceArchive(forceView.target, { confirmUnpin: parentPinned === true });
                          },
                          style: {
                            border: 'none',
                            borderRadius: 7,
                            padding: '4px 10px',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer',
                            background: COLORS.error,
                            color: '#ffffff',
                          },
                        },
                        parentPinned === true ? '强制归档并取消置顶（停止任务）' : '强制归档（停止任务）',
                      ),
                    ),
                  )
                : forceView.phase === 'busy'
                  ? h(
                      'div',
                      { 'data-cr-force-busy': '1', style: { padding: '12px', fontSize: 11, lineHeight: '16px', color: theme.subText } },
                      '正在强制归档并停止旧会话上的任务…',
                    )
                  : forceView.phase === 'error'
                    ? h(
                        'div',
                        { 'data-cr-force-error': '1', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', fontSize: 11, lineHeight: '16px' } },
                        h('div', { style: { color: COLORS.error } }, String(forceView.message)),
                        h(
                          'div',
                          { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
                          h(
                            'button',
                            {
                              type: 'button',
                              'data-cr-force-error-back': '1',
                              onClick: backFromForce,
                              style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 7, padding: '4px 10px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                            },
                            '返回菜单',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              'data-cr-force-retry': '1',
                              onClick: () => {
                                void runForceArchive(forceView.target, { confirmUnpin: forceView.confirmUnpin === true });
                              },
                              style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                            },
                            '重试',
                          ),
                        ),
                      )
                    : h(
                        'div',
                        { 'data-cr-force-done': '1', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', fontSize: 11, lineHeight: '16px' } },
                        h('div', { 'data-cr-force-note': '1', style: { color: theme.panelFg } }, String(forceView.note)),
                        // pinned = 宿主里旧会话其实还置顶（状态过期）：不静默取消置顶，
                        // 给一个明确的二次出口，用户点了才带 confirmUnpin 重发。
                        forceView.status === 'pinned'
                          ? h(
                              'div',
                              { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  'data-cr-force-close': '1',
                                  onClick: closeMenu,
                                  style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 7, padding: '4px 10px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                                },
                                '关闭',
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  'data-cr-force-unpin': '1',
                                  onClick: () => {
                                    void runForceArchive(forceView.target, { confirmUnpin: true });
                                  },
                                  style: { border: 'none', borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', background: COLORS.error, color: '#ffffff' },
                                },
                                '仍然归档（取消置顶）',
                              ),
                            )
                          : h(
                              'div',
                              { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  'data-cr-force-close': '1',
                                  onClick: closeMenu,
                                  style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 7, padding: '4px 10px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                                },
                                '关闭',
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  'data-cr-force-done-back': '1',
                                  onClick: backFromForce,
                                  style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 7, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                                },
                                '返回菜单',
                              ),
                            ),
                      ),
            );

      const menu =
        open === true
          ? h(
              'div',
              {
                ref: menuRef,
                role: 'menu',
                'aria-label': '接力菜单',
                'data-cr-relay-menu': '1',
                style: {
                  position: 'fixed',
                  ...position,
                  width: menuWidth,
                  maxWidth: 'calc(100vw - 16px)',
                  maxHeight: 'min(65vh, 460px)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  padding: doc === null && chainView === null && forceView === null ? 5 : 0,
                  borderRadius: 12,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  // 顶层：高于指示灯菜单/确认卡（39–44），避免被输入区或其它浮层盖住。
                  zIndex: 60,
                },
              },
              notice !== null
                ? h(
                    'div',
                    { 'data-cr-relay-notice': '1', style: { padding: '7px 10px', fontSize: 11, lineHeight: '15px', color: 'var(--dsw-alias-state-error-primary, #D92D20)' } },
                    notice,
                  )
                : null,
              // 交接单面板 / 完整链面板 / 强制归档确认面板都替换主列表；「← 返回」按来源回主菜单。
              docPanel ??
                chainPanel ??
                forcePanel ??
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column' } },
                  relayBarItem('查看交接单', docName === null ? '这一链没有记录交接单路径' : '打开本次交接的九段交接单', 'doc', () => {
                    void loadDoc(docName);
                  }, {
                    disabled: docName === null,
                    // 需求文案：无 path 时明确提示「暂无交接单」。
                    right: docName === null ? '暂无交接单' : '›',
                    title: docName === null ? '暂无交接单：这条接力记录里没有交接单路径（旧记录，或父会话已不在）' : '打开交接单',
                  }),
                  // 0.5.1 批 3（TD-01）：父会话侧的去向 —— 出站记录里的 childId。
                  hasNext
                    ? relayBarItem('去新会话', '切到这次交接出来的新会话', 'next', goNext, {
                        right: '›',
                        title: `打开新会话 ${next.childId}${nextArchived === true ? '（已归档：打开前先恢复）' : ''}`,
                      })
                    : null,
                  chain !== null
                    ? relayBarItem('回到原会话', hasParent ? '切到上一个会话，继续看那边历史' : '这条记录没有父会话 id', 'parent', goParent, {
                        disabled: !hasParent,
                        right: hasParent ? '›' : '不可用',
                        title: hasParent ? `打开原会话 ${chain.parentId}` : undefined,
                      })
                    : null,
                  showRestore
                    ? relayBarItem(
                        '恢复旧会话',
                        parentArchived === true
                          ? '旧会话已归档：恢复后切回上一代'
                          : '宿主没提供归档状态；恢复调用是幂等的，仍可直接尝试',
                        'unarchive',
                        () => {
                          void restoreAndOpen(chain.parentId, { markParent: true });
                        },
                        {
                          right: parentArchived === true ? '已归档' : '恢复',
                          title: `从归档中恢复旧会话 ${chain.parentId}`,
                        },
                      )
                    : null,
                  hasParent && showForceArchive
                    ? relayBarItem(
                        '强制归档旧会话（会停止后台任务）',
                        parentPinned === true
                          ? '旧会话已置顶：归档会同时取消置顶；会先二次确认'
                          : '旧会话还有任务在跑也能收起；会先二次确认',
                        'force-archive',
                        () => {
                          openForceConfirm(chain.parentId);
                        },
                        {
                          right: '›',
                          title: `强制归档旧会话 ${chain.parentId}：二次确认后会停止它上面正在跑的任务再归档`,
                        },
                      )
                    : null,
                  hasParent
                    ? relayBarItem('完整交接链', '一次读取整条链，回看前几次会话与交接单', 'chain', openChainList, {
                        right: '›',
                        title: `完整交接链：一次读取整条链（最多 ${MAX_CHAIN_HOPS} 层；祖先未加载也能读）`,
                      })
                    : null,
                  relayBarItem('路线图（即将上线）', '跨会话时间线，0.6 之后', 'roadmap', null, {
                    disabled: true,
                    right: '即将上线',
                  }),
                ),
            )
          : null;

      return h(
        'div',
        {
          ref: rootRef,
          'data-cr-relay-root': '1',
          style: {
            boxSizing: 'border-box',
            flex: 'none',
            // 与宿主 TodoPanel（同一 dock 槽）一致：两侧留出 composer 的边距，
            // 宽度跟着输入卡走，避免通栏压到侧栏。
            width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) * 2 - var(--dsh-composer-dock-inset, 8px) * 4)',
            maxWidth: 'calc(var(--dsh-composer-card-max-width, 920px) - var(--dsh-composer-dock-inset, 8px) * 4)',
            margin: '0 auto',
          },
        },
        // 卡片外观放在内层：backdrop-filter 会给 fixed 子元素造 containing block，
        // 菜单必须留在这一层之外，才能相对视口定位（不被输入区裁切）。
        h(
          'div',
          {
            'data-cr-relay-card': '1',
            style: {
              borderRadius: 'var(--dsw-radius-lg, 12px)',
              border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.24))',
              // 底色/字体全部走 DSH 主题 token：切深浅色不需要重挂组件；老宿主用 theme 兜底。
              background: `var(--dsw-specific-menu, ${theme.panelBg})`,
              backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
              WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
              boxShadow: 'var(--dsw-elevation-panel, 0 1px 2px rgba(0,0,0,0.06))',
              color: 'var(--dsw-alias-label-primary, inherit)',
              overflow: 'hidden',
            },
          },
          h(
            'button',
            {
              type: 'button',
              ref: triggerRef,
              'data-cr-relay-bar': '1',
              'data-cr-relay-ordinal': String(chain !== null ? chain.ordinal : next.ordinal),
              'data-cr-relay-scheme': (chain !== null ? chain.scheme : next.scheme) ?? '',
              'data-cr-relay-parent': chain === null || chain.parentId === null ? '' : chain.parentId,
              'data-cr-relay-path': docPath ?? '',
              // 空串 = 宿主没给归档状态（老宿主），'true'/'false' = readState.parentArchived。
              'data-cr-relay-parent-archived': parentArchived === null ? '' : String(parentArchived),
              // 0.5.1 批 3：出站目标（父会话侧「去新会话」）与它的归档状态。
              'data-cr-relay-next': hasNext ? next.childId : '',
              'data-cr-relay-next-archived': nextArchived === null ? '' : String(nextArchived),
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              'aria-label': chain !== null ? `已接力自 ${label}，打开接力菜单` : `${label}，打开接力菜单`,
              onClick: toggleMenu,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                minHeight: 30,
                padding: '3px 10px',
                border: 'none',
                borderRadius: 'inherit',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
              },
              onMouseEnter: (event) => {
                event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))';
              },
              onMouseLeave: (event) => {
                event.currentTarget.style.background = 'transparent';
              },
            },
            h(
              'span',
              { style: { flex: 'none', fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } },
              // 末尾留一个空格：flex gap 负责视觉间距，文本内容（读屏/可访问性树）也要读得通。
              // 父会话侧没有「来路」，只显示「已交接给新会话」（见 label）。
              chain !== null ? '已接力自 ' : '',
            ),
            h(
              'span',
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  fontWeight: 500,
                  lineHeight: '20px',
                  color: 'var(--dsw-alias-label-primary, inherit)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              label,
            ),
            h(
              'span',
              {
                'aria-hidden': true,
                style: {
                  flex: 'none',
                  fontSize: 10,
                  lineHeight: 1,
                  color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))',
                  transform: open ? 'rotate(180deg)' : 'none',
                  transition: 'transform 120ms ease',
                },
              },
              '▾',
            ),
          ),
        ),
        menu,
      );
    }
    /**
     * 收藏星标（0.6）—— 挂在助手消息底部的动作行（conversation.chat.assistant-actions）。
     *
     * 数据：GET /api/compact-relay-state?sessionId=… 的 favorites.messageIds（判断是否已收藏）；
     * 点击：POST /api/compact-relay-action { action:'favorite-toggle', messageId, sessionId }。
     *
     * 2026-10-29 真机 BUG：以前 state 请求不带 sessionId，宿主回「最后一个活 agent」的会话
     * （多工作区同时开着时那是别的会话）→ 点星 POST 到错会话 → 「找不到这条消息」→ 点了没反应。
     * 现在会话 id 只认 slot 的 session 作用域注入（register 的 inject），state 也按它请求。
     * 另外：点失败要出声（宿主可能回「已被压缩」/「没有活动会话」），不再静默。
     */
    const FAVORITE_STAR_PATH = 'M12 2.8l2.82 5.72 6.31.92-4.57 4.45 1.08 6.29L12 17.2l-5.64 2.98 1.08-6.29-4.57-4.45 6.31-.92z';

    // 收藏状态共享快照：几十个星标组件共用一个请求（避免每条助手消息各发一次 GET）。
    // 30s 内复用；并发挂载共用同一个 pending Promise。快照按 sessionId 区分（切会话不会串）。
    const FAVORITE_SNAPSHOT_TTL_MS = 30000;
    let favoriteSnapshot = null; // { sessionId, ids, suggested, freshUntil }
    let favoriteSnapshotPending = null;
    let favoriteSnapshotPendingSession = null;
    /** 点亮色（配置 colors.base.favorite；设计稿到位后改配置值即可）。 */
    let favoriteTint = '#F5C542';

    /**
     * 推荐态样式只注入一次：金色呼吸光晕（0.5.3 UI）。
     * 静态 1.5px 细环在长消息流里太容易漏看；改成 2.4s 呼吸 + 更亮的峰值。
     * 系统开了「减少动态效果」就退回静态加亮版本。
     *
     * 0.5.5：已收藏的星标要「常亮」（用户反馈：收藏后星标自动消失）。
     * 根因是宿主的 hover 动作行默认 opacity:0（hover/focus-within 才显示），星标跟着整行一起透明；
     * 星标本身、aria-pressed/数据都没问题。这里用 :has() 只把「含已收藏星标的动作行」强制可见，
     * 并且非 hover/焦点时把同行其它按钮与同 slot 的其它插件按钮保持隐藏（pointer-events 也关掉，
     * 不给看不见的按钮留可点区域），让常亮的只有已收藏星标本身；未收藏的消息完全不受影响。
     * 选择器刻意不依赖宿主哈希类名（ZITbJG_actions 之类会随构建变）：
     *   - 锚点：稳定契约 [data-slot="conversation.chat.assistant-actions"]（我们注册的 slot）；
     *   - 开关：宿主稳定属性 [data-actions-reveal="hover"]（仅 hover 才显示的行才有）。
     * 不支持 :has() 的旧浏览器整段规则被忽略 → 行为回到修复前，不会误伤布局。
     */
    function ensureFavoriteStyle() {
      try {
        if (typeof document === 'undefined' || document.head === null) return;
        const cssText =
          '@keyframes dcr-favorite-pulse {' +
          '0%,100% { box-shadow: 0 0 0 2px rgba(245,197,66,0.78), 0 0 6px rgba(245,197,66,0.45); }' +
          '50% { box-shadow: 0 0 0 2.5px rgba(245,197,66,0.98), 0 0 12px rgba(245,197,66,0.85); }' +
          '}' +
          // 与宿主助手消息动作行（._action）完全对齐：基础用 label-tertiary，
          // hover 切 label-secondary + 交互背景（与邻座逐项相同）。
          '.dcr-favorite-star { background: transparent; color: var(--dsw-alias-label-tertiary, currentColor); }' +
          '.dcr-favorite-star:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16)); color: var(--dsw-alias-label-secondary, currentColor); }' +
          '@media (prefers-reduced-motion: reduce) { .dcr-favorite-star { animation: none !important; } }' +
          // 0.5.5：含「已收藏星标」的 hover 动作行常亮。
          '@media (hover: hover) {' +
          '[data-actions-reveal="hover"] div:has(> [data-slot="conversation.chat.assistant-actions"] > button.dcr-favorite-star[aria-pressed="true"]) { opacity: 1 !important; }' +
          // 非 hover / 非键盘焦点：动作行其它按钮与同 slot 其它插件按钮保持视觉隐藏且不可点。
          '[data-actions-reveal="hover"]:not(:hover):not(:focus-within) div:has(> [data-slot="conversation.chat.assistant-actions"] > button.dcr-favorite-star[aria-pressed="true"]) > :not([data-slot="conversation.chat.assistant-actions"]) { opacity: 0; pointer-events: none; }' +
          '[data-actions-reveal="hover"]:not(:hover):not(:focus-within) div:has(> [data-slot="conversation.chat.assistant-actions"] > button.dcr-favorite-star[aria-pressed="true"]) [data-slot="conversation.chat.assistant-actions"] > :not(button.dcr-favorite-star[aria-pressed="true"]) { opacity: 0; pointer-events: none; }' +
          '}';
        // 插件热重载（bundle 在同页重跑）时旧 style 还在：覆盖成最新 CSS，避免新规则不生效。
        const existing = document.getElementById('dcr-favorite-style');
        if (existing !== null) {
          existing.textContent = cssText;
          return;
        }
        const style = document.createElement('style');
        style.id = 'dcr-favorite-style';
        style.textContent = cssText;
        document.head.appendChild(style);
      } catch (error) {
        /* 样式注入失败不影响收藏功能 */
      }
    }
    ensureFavoriteStyle();

    /** 轻提示：收藏失败/被压缩时告诉用户一声（不依赖宿主 toast API）。 */
    function favoriteNotify(text) {
      try {
        if (typeof document === 'undefined' || document.body === null) return;
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText =
          'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483000;max-width:80vw;' +
          'padding:8px 14px;border-radius:8px;background:rgba(30,30,30,0.92);color:#fff;font-size:13px;' +
          'line-height:1.4;box-shadow:0 6px 24px rgba(0,0,0,0.25);pointer-events:none;';
        document.body.appendChild(el);
        setTimeout(() => {
          try {
            el.remove();
          } catch (error) {
            /* ignore */
          }
        }, 4000);
      } catch (error) {
        /* 提示失败不影响收藏 */
      }
    }

    /**
     * 收藏列表（按会话缓存）。
     * @param {string|null} sessionId 当前会话（来自 slot 注入；拿不到就退回旧行为）
     * @returns {Promise<string[]|null>}
     */
    function favoriteIdsOf(sessionId) {
      const sid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
      if (favoriteSnapshot !== null && favoriteSnapshot.sessionId === sid && Date.now() < favoriteSnapshot.freshUntil) {
        return Promise.resolve(favoriteSnapshot.ids);
      }
      if (favoriteSnapshotPending !== null && favoriteSnapshotPendingSession === sid) return favoriteSnapshotPending;
      favoriteSnapshotPendingSession = sid;
      favoriteSnapshotPending = (async () => {
        try {
          const url =
            sid === null ? '/api/compact-relay-state' : `/api/compact-relay-state?sessionId=${encodeURIComponent(sid)}`;
          const res = await fetch(url);
          const data = await res.json();
          const fav = data !== null && typeof data === 'object' ? data.favorites : null;
          const ids = fav !== null && typeof fav === 'object' && Array.isArray(fav.messageIds) ? fav.messageIds : [];
          // 0.5.3 P1-6：推荐收藏建议（只点亮星标，不写收藏）。按 messageId 建索引，组件 O(1) 查。
          const suggested = {};
          const suggestList =
            data !== null && typeof data === 'object' && Array.isArray(data.favoriteSuggest) ? data.favoriteSuggest : [];
          for (const item of suggestList) {
            if (item === null || typeof item !== 'object') continue;
            if (typeof item.messageId !== 'string' || item.messageId.length === 0) continue;
            suggested[item.messageId] = {
              score: typeof item.score === 'number' ? item.score : null,
              reason: typeof item.reason === 'string' ? item.reason : '',
            };
          }
          // 只有「没带 sessionId」的兜底请求才信响应里的会话；带了就以请求的为准。
          const effectiveSid =
            sid !== null ? sid : data !== null && typeof data === 'object' && typeof data.sessionId === 'string' ? data.sessionId : null;
          const color = data !== null && typeof data === 'object' && data.colors && data.colors.base ? data.colors.base.favorite : null;
          if (typeof color === 'string' && color.length > 0) favoriteTint = color;
          favoriteSnapshot = {
            sessionId: effectiveSid,
            ids: ids.slice(),
            suggested,
            freshUntil: Date.now() + FAVORITE_SNAPSHOT_TTL_MS,
          };
          return favoriteSnapshot.ids;
        } catch (error) {
          return null;
        } finally {
          favoriteSnapshotPending = null;
          favoriteSnapshotPendingSession = null;
        }
      })();
      return favoriteSnapshotPending;
    }

    // 点击后同步共享快照，避免同屏其它星标（或稍后挂载的）显示旧状态。
    function rememberFavorite(messageId, active) {
      if (favoriteSnapshot === null) return;
      const ids = favoriteSnapshot.ids;
      const index = ids.indexOf(messageId);
      if (active && index === -1) ids.push(messageId);
      else if (!active && index !== -1) ids.splice(index, 1);
      // 已收藏的条目不再算「推荐」（取消收藏后本回合内也不重新点亮，等下一条回复）。
      if (active && favoriteSnapshot.suggested !== null && typeof favoriteSnapshot.suggested === 'object') {
        delete favoriteSnapshot.suggested[messageId];
      }
      favoriteSnapshot.freshUntil = Date.now() + FAVORITE_SNAPSHOT_TTL_MS;
    }

    /** 查某条消息是否有推荐（当前快照会话内）；返回 {score, reason} 或 null。 */
    function favoriteSuggestionOf(sessionId, messageId) {
      if (favoriteSnapshot === null || messageId === null) return null;
      if (favoriteSnapshot.sessionId !== sessionId) return null;
      const suggested = favoriteSnapshot.suggested;
      if (suggested === null || typeof suggested !== 'object') return null;
      const hit = suggested[messageId];
      return hit !== undefined && hit !== null ? hit : null;
    }

    function FavoriteStar(props) {
      const messageId =
        props !== null && props !== undefined && typeof props.messageId === 'string' ? props.messageId : null;
      const sessionId =
        props !== null && props !== undefined && typeof props.sessionId === 'string' && props.sessionId.length > 0
          ? props.sessionId
          : null;
      const [active, setActive] = useState(false);
      const [busy, setBusy] = useState(false);
      const [tint, setTint] = useState('#F5C542');
      const [suggested, setSuggested] = useState(null);

      useEffect(() => {
        if (messageId === null) return undefined;
        let cancelled = false;
        (async () => {
          const ids = await favoriteIdsOf(sessionId);
          if (cancelled || ids === null) return;
          setActive(ids.includes(messageId));
          setSuggested(favoriteSuggestionOf(sessionId, messageId));
          setTint(favoriteTint);
        })();
        return () => {
          cancelled = true;
        };
      }, [messageId, sessionId]);

      const toggle = useCallback(async () => {
        if (messageId === null || busy) return undefined;
        setBusy(true);
        try {
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'favorite-toggle',
              messageId,
              ...(sessionId === null ? {} : { sessionId }),
            }),
          });
          const data = await res.json();
          if (data !== null && typeof data === 'object' && typeof data.active === 'boolean') {
            setActive(data.active);
            if (data.active) setSuggested(null);
            rememberFavorite(messageId, data.active);
            return undefined;
          }
          // 失败要出声：宿主回「找不到这条消息（会话可能被压缩过）」等具体原因。
          const message =
            data !== null && typeof data === 'object' && typeof data.message === 'string' && data.message.length > 0
              ? data.message
              : '收藏失败：请重试';
          favoriteNotify(message);
          return undefined;
        } catch (error) {
          favoriteNotify('收藏失败：网络或宿主不可用');
          return undefined;
        } finally {
          setBusy(false);
        }
      }, [messageId, sessionId, busy]);

      if (messageId === null) return null;
      const isSuggested = active !== true && suggested !== null;
      const label = active
        ? '取消收藏'
        : isSuggested
          ? `推荐收藏${suggested.score !== null ? `（${suggested.score} 分）` : ''}`
          : '收藏这条';
      return h(
        'button',
        {
          type: 'button',
          className: 'dcr-favorite-star',
          title: label,
          'aria-label': label,
          'aria-pressed': active ? 'true' : 'false',
          onClick: toggle,
          disabled: busy,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: isSuggested ? 'auto' : '28px',
            height: '28px',
            gap: isSuggested ? '4px' : '0',
            padding: isSuggested ? '6px 8px 6px 6px' : '6px',
            margin: '0',
            border: 'none',
            cursor: busy ? 'default' : 'pointer',
            ...(active || isSuggested ? { color: tint } : {}),
            opacity: busy ? 0.5 : 1,
            borderRadius: '8px',
            // 推荐态：金色光晕（只点亮、不自动收藏；点击仍走同一 toggle）。
            boxShadow: isSuggested ? '0 0 0 2px rgba(245,197,66,0.9), 0 0 8px rgba(245,197,66,0.6)' : 'none',
            animation: isSuggested ? 'dcr-favorite-pulse 2.4s ease-in-out infinite' : 'none',
            lineHeight: 1,
            verticalAlign: 'middle',
          },
        },
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 24 24',
            fill: active ? 'currentColor' : 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 0 : 1.8,
            strokeLinejoin: 'round',
          },
          h('path', { d: FAVORITE_STAR_PATH }),
        ),
        // 推荐态：加一个金色「推荐」小标签（用户确认要提高可见度，允许轻微打断阅读）。
        // 标签在按钮内部 —— 点击任意位置都走同一个 toggle，不新增交互面。
        isSuggested
          ? h(
              'span',
              {
                style: {
                  fontSize: '11px',
                  lineHeight: '1.5',
                  letterSpacing: '0.02em',
                  whiteSpace: 'nowrap',
                },
              },
              '推荐',
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

    /** 百分比上限徽标：「最高 62%」——让上限一眼可见，但不用它夹紧输入。 */
    const percentCapChipStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      height: 20,
      padding: '0 8px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28))',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
      color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.95))',
      fontSize: 11,
      lineHeight: '20px',
      whiteSpace: 'nowrap',
    };

    /**
     * 行内提示块（告警 / 失败）：淡色底 + 同色描边，深浅主题都靠 DSH 状态 token 自适应。
     * 红色只用在真正的失败上，且用 7% 透明底而不是整块红，避免刺眼。
     * @param {'warning'|'error'} kind
     */
    function alertBoxStyle(kind) {
      const warning = kind === 'warning';
      return {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '8px 10px',
        borderRadius: 8,
        border: `1px solid ${warning ? 'var(--dsw-alias-state-warning-primary, #d97706)' : 'var(--dsw-alias-state-error-primary, #D92D20)'}`,
        background: warning ? 'rgba(217, 119, 6, 0.08)' : 'rgba(217, 45, 32, 0.07)',
        color: warning ? 'var(--dsw-alias-state-warning-primary, #b45309)' : 'var(--dsw-alias-state-error-primary, #D92D20)',
        fontSize: 12,
        lineHeight: '17px',
        fontWeight: 600,
      };
    }

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
      /** 0.4 P1-3：轻账本累计数字（独立账本文件算出来的；null = 没有数据/读不到，显示引导文案）。 */
      const [ledger, setLedger] = useState(null);
      const [confirmNative, setConfirmNative] = useState(null); // null | 'disable' | 'enable'
      /** 0.4.2：按实际线重算交接线（先二次确认，{ratio,percent}）。 */
      const [confirmRecalc, setConfirmRecalc] = useState(null);
      /**
       * 0.4.2 修复（真机 bug「输入 80 他直接改成 99」）：百分比输入框的**本地草稿**。
       *
       * 根因：输入框的 value 以前是派生值 `Math.round(ratio*100)`（受控、无草稿），
       * 每次按键都经过 `Math.min(0.99, …)` 夹紧再四舍五入回写。于是「60 后面按 8」这种
       * 中间态（608）会被夹成 0.99 → 显示 99，用户输入被静默吃掉，保存再报错。
       *
       * 现在：按键只记草稿（用户输入什么就显示什么，除非非数字），表单同步原样写入
       * `value/100`（不夹紧）；失焦/加载/保存成功时丢弃草稿，回到表单的派生值。
       * 超限一律留给服务端拒绝（guard.message 给目标值），不在客户端改写。
       * @type {[Record<string,string>, Function]}
       */
      const [percentDrafts, setPercentDrafts] = useState({});
      const [nativeBusy, setNativeBusy] = useState(false);
      /** UI-003：结果提示就地显示在开关旁（以前只写页面底部，用户看不到）。 */
      const [nativeStatus, setNativeStatus] = useState(null);
      // 0.5.3 P1-7：推荐收藏「试算」的输入与结果（只读，不写收藏）。
      const [trialText, setTrialText] = useState('');
      const [trialResult, setTrialResult] = useState(null);
      const [trialBusy, setTrialBusy] = useState(false);
      /** 作者 2026-10-20：设置页「再看一次初次引导」的就地提示。 */
      const [onboardingNotice, setOnboardingNotice] = useState(null);
      const nativeConfirmRef = useRef(null);
      /**
       * 0.4 P0-2：诊断信息（只在本机生成；可预览/复制，插件不会把它发到任何地方）。
       * diagData 是端点返回的 {schema,version,generatedAt,markdown,json,issueUrl}。
       */
      const [diagData, setDiagData] = useState(null);
      const [diagLoading, setDiagLoading] = useState(false);
      const [diagOpen, setDiagOpen] = useState(false);
      /** 弹层顶部说明卡：只在本会话第一次生成时出现一次。 */
      const [diagIntroSeen, setDiagIntroSeen] = useState(false);
      const [diagStatus, setDiagStatus] = useState(null);
      /** 复制/打开结果的小 toast 计时器（A4：成功与失败都要有 toast 反馈）。 */
      const diagToastTimer = useRef(null);

      /** 就地提示 + 4.2 秒后自动消失的 toast。 */
      const flashDiagStatus = useCallback((next) => {
        setDiagStatus(next);
        if (diagToastTimer.current !== null) clearTimeout(diagToastTimer.current);
        diagToastTimer.current = setTimeout(() => setDiagStatus(null), 4200);
      }, []);

      useEffect(
        () => () => {
          if (diagToastTimer.current !== null) clearTimeout(diagToastTimer.current);
        },
        [],
      );

      /** 0.4.1：设置接口只给「配置阈值」，实际触发线要从 state 接口补（同一套 readState 数据）。 */
      const nativeLineExtra = useRef(null);
      const mergeNative = useCallback((view) => {
        if (view === null || view === undefined) return null;
        const extra = nativeLineExtra.current;
        return extra === null ? view : { ...view, ...extra };
      }, []);

      /** 把服务端返回的 view 落到表单：同时更新「已保存」快照和设置文件错误。 */
      const applyLoaded = useCallback((data) => {
        setForm(data.config);
        setSavedSnapshot(JSON.stringify(data.config));
        // 服务端回来的配置是新的权威值：丢掉输入草稿，输入框重新按表单派生（加载/保存成功都走这里）。
        setPercentDrafts({});
        setSettingsError(data.settingsError ?? null);
        setNative(mergeNative(data.native && typeof data.native === 'object' ? data.native : null));
        if (typeof data.version === 'string') setVersion(data.version);
        if (typeof data.path === 'string') setSettingsPath(data.path);
        setLedger(data.ledger !== null && typeof data.ledger === 'object' ? data.ledger : null);
      }, [mergeNative]);

      const load = useCallback(async () => {
        try {
          const [settingsRes, stateRes] = await Promise.all([
            fetch('/api/compact-relay-settings', { cache: 'no-store' }),
            fetch('/api/compact-relay-state', { cache: 'no-store' }).catch(() => null),
          ]);
          const data = await settingsRes.json().catch(() => ({}));
          if (!settingsRes.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '读取设置失败');
          // 0.4.1：补上实际触发线相关字段（配置接口没有这些，只有 state 接口有）。
          let extra = null;
          if (stateRes !== null && stateRes.ok) {
            const stateData = await stateRes.json().catch(() => ({}));
            const sn = stateData !== null && stateData.native !== null && typeof stateData.native === 'object' ? stateData.native : null;
            if (sn !== null) {
              extra = {
                ratio: typeof sn.ratio === 'number' ? sn.ratio : null,
                thresholdTokens: typeof sn.thresholdTokens === 'number' ? sn.thresholdTokens : null,
                contextWindow: typeof sn.contextWindow === 'number' ? sn.contextWindow : null,
                reservedCompletionTokens: typeof sn.reservedCompletionTokens === 'number' ? sn.reservedCompletionTokens : null,
                headroomTokens: typeof sn.headroomTokens === 'number' ? sn.headroomTokens : null,
                overridden: sn.overridden === true,
                route: sn.route !== null && typeof sn.route === 'object' ? sn.route : null,
              };
            }
          }
          nativeLineExtra.current = extra;
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
        setConfirmRecalc(null);
        // 0.4.2 修复：一改值就清掉上一次的保存结果/失败提示，避免旧错误一直挂着像没生效。
        setStatus(null);
      };

      /* ---------------- 百分比输入：草稿优先，绝不静默改写 ---------------- */

      /**
       * 输入框显示值：有草稿就用草稿（用户打什么显示什么），否则按表单比例派生整数百分位。
       * @param {'minRatio'|'compactRatio'|'handoffRatio'} key
       * @param {number} ratio
       * @returns {string}
       */
      const percentText = (key, ratio) => {
        const draft = percentDrafts[key];
        return typeof draft === 'string' ? draft : String(Math.round(ratio * 100));
      };

      /**
       * 百分比输入变化：先记草稿，再把「用户输入的数字 / 100」原样写进表单。
       * - 空串 = 用户正在删旧值准备重打：只留草稿，不动表单（以前空串会被夹成 5%，用户根本打不出新值）；
       * - 非数字（type=number 下浏览器给空串或字母被吞）：只显示，不动表单；
       * - 其余：不夹紧、不四舍五入，超限交给保存时服务端拒绝并给目标值。
       * @param {'minRatio'|'compactRatio'|'handoffRatio'} key
       * @param {string} text
       */
      const changePercent = (key, text) => {
        const raw = typeof text === 'string' ? text : '';
        setPercentDrafts((prev) => ({ ...prev, [key]: raw }));
        if (raw.trim() === '') {
          setStatus(null);
          setConfirmReset(false);
          setConfirmRecalc(null);
          return;
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        patch(['thresholds', key], value / 100);
      };

      /** 丢弃某个草稿，显示回到表单派生值（失焦时用；不会改表单）。 */
      const restorePercentDraft = (key) => {
        setPercentDrafts((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      };

      /**
       * 聚焦/点击即全选：阈值框只有 2–3 位数，点进去直接打字就是「替换」，
       * 不会出现「60 后面接着打 80 变成 6080」这种叠加（真机上「输入 80 变成 99」的一半原因）。
       *
       * 为什么还要 setTimeout(0) 再选一次：点进输入框时，浏览器会在 focus 事件之后
       * 才把光标落到鼠标位置（把刚做的选区冲掉）。下一轮事件循环再选一次 = 打字一定是替换。
       */
      const selectOnFocus = (event) => {
        const el = event === null || event === undefined ? null : event.target;
        if (el === null || el === undefined || typeof el.select !== 'function') return;
        try {
          el.select();
        } catch {
          /* 个别浏览器不允许对 number 输入做选区：忽略，不影响输入 */
        }
        setTimeout(() => {
          try {
            if (el.ownerDocument !== null && el.ownerDocument !== undefined && el.ownerDocument.activeElement === el) el.select();
          } catch {
            /* 元素已卸载：忽略 */
          }
        }, 0);
      };

      /** 表单与已保存快照不一致 → 有未保存修改。 */
      const dirty = form !== null && savedSnapshot !== null && JSON.stringify(form) !== savedSnapshot;
      // 0.5.3 P1-6：推荐收藏表单（旧设置 payload 可能没有 favorite 块 → 用默认值兜底，不崩）。
      const favoriteForm =
        form !== null && typeof form === 'object' && form.favorite !== null && form.favorite !== undefined && typeof form.favorite === 'object'
          ? form.favorite
          : { enabled: true, level: 'standard', mustWords: [], muteWords: [] };

      /**
       * 保存设置。0.4.2：body 带上 `nativeRatio`（当前模型实际触发线），
       * 服务端据此按「实际线 −5pp」同口径校验交接线；算不出/原生关闭时不带（服务端兜底）。
       * @param {object} [override] 「按实际线重算」用：一次性覆盖表单（不依赖 setState 的异步生效）
       */
      const save = useCallback(async (override) => {
        if (form === null || saving) return;
        const payload = override !== undefined && override !== null ? override : form;
        setSaving(true);
        setStatus(null);
        setConfirmReset(false);
        try {
          const info = nativeLineInfo(native);
          const nativeRatio = native !== null && native.autoEnabled !== false && info.actual !== null ? info.actual : null;
          const res = await fetch('/api/compact-relay-settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(nativeRatio === null ? payload : { ...payload, nativeRatio }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            // 0.4.2 修复：服务端会带 field（交接线校验失败时是 thresholds.handoffRatio），
            // 带出来才能在交接线行内就地标红，而不是只在页面底部写一行。
            const failure = new Error(data && data.message ? String(data.message) : '保存失败');
            if (data !== null && typeof data === 'object' && typeof data.field === 'string') failure.field = data.field;
            throw failure;
          }
          applyLoaded(data);
          setStatus({ text: '已保存（立即生效，不需要重启）' });
        } catch (error) {
          setStatus({
            error: true,
            text: `保存失败：${error && error.message ? error.message : '未知错误'}`,
            field: error !== null && typeof error === 'object' && typeof error.field === 'string' ? error.field : null,
          });
        } finally {
          setSaving(false);
        }
      }, [form, saving, applyLoaded, native]);

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

      /**
       * 0.4.2：「按实际线重算」——目标 = 实际触发线 −5pp（整数百分位，guard 已算好）。
       * 二次确认后一次性保存（不走 patch + save 的异步状态，避免发出旧表单）。
       */
      const applyRecalc = useCallback(async () => {
        if (form === null || confirmRecalc === null || saving) return;
        const next = setIn(form, ['thresholds', 'handoffRatio'], confirmRecalc.ratio);
        setConfirmRecalc(null);
        // 目标值是 guard 算出来的权威值：丢掉输入草稿，避免输入框还显示用户手打的旧数字。
        setPercentDrafts({});
        await save(next);
      }, [form, confirmRecalc, saving, save]);

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

      /** 0.5.3 P1-7：词表输入（逗号/空格分隔）→ 规范化数组。 */
      const parseFavoriteWords = (text) =>
        String(text)
          .split(/[,，、\s]+/)
          .map((word) => word.trim())
          .filter((word) => word.length > 0)
          .slice(0, 20);

      /** 0.5.3 P1-7：试算——按当前表单里的档位/词表跑一次打分，只读结果。 */
      const runTrial = useCallback(async () => {
        if (trialBusy) return;
        const text = trialText.trim();
        if (text.length === 0) {
          setTrialResult({ error: true, text: '先粘一段文本再试算' });
          return;
        }
        setTrialBusy(true);
        setTrialResult(null);
        try {
          // 试算需要模型路由：先取当前活会话 id（设置页不是会话作用域）。
          const stateRes = await fetch('/api/compact-relay-state', { cache: 'no-store' });
          const state = await stateRes.json().catch(() => ({}));
          const sessionId = state !== null && typeof state === 'object' && typeof state.sessionId === 'string' ? state.sessionId : '';
          if (sessionId.length === 0) throw new Error('没有活动会话，先发一条消息唤醒 agent 再试算');
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'favorite-score-trial',
              sessionId,
              text,
              level: favoriteForm.level,
              mustWords: favoriteForm.mustWords,
              muteWords: favoriteForm.muteWords,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '试算失败');
          const scoreText = typeof data.score === 'number' ? `${data.score} 分` : '没拿到分数';
          const verdict = data.suggest === true ? '会点亮' : '不点亮';
          const why =
            data.decisionReason === 'mute-word'
              ? `（命中屏蔽词「${data.matched}」）`
              : data.decisionReason === 'must-word'
                ? `（命中必亮词「${data.matched}」）`
                : data.decisionReason === 'too-short'
                  ? '（太短）'
                  : data.decisionReason === 'unknown-score'
                    ? '（模型没给分）'
                    : '';
          setTrialResult({ text: `${scoreText} → ${verdict}${why}` });
        } catch (error) {
          setTrialResult({ error: true, text: error && error.message ? error.message : '试算失败' });
        } finally {
          setTrialBusy(false);
        }
      }, [trialBusy, trialText, favoriteForm]);

      // UI-003：确认块出现时滚进视野（以前它渲染在设置页底部以外，用户以为「点了没反应」）。
      useEffect(() => {
        if (confirmNative !== null && nativeConfirmRef.current && typeof nativeConfirmRef.current.scrollIntoView === 'function') {
          nativeConfirmRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }, [confirmNative]);

      /**
       * 0.4 P0-2：生成诊断信息。
       *
       * 唯一的网络调用是同源只读 GET（`/api/compact-relay-diagnostics`，仅此一次）；
       * 产物由宿主生成（白名单 + 已脱敏），这里只负责展示/复制。
       */
      const generateDiagnostics = useCallback(
        async ({ openPreview = true } = {}) => {
          if (diagLoading) return null;
          setDiagLoading(true);
          setDiagStatus(null);
          try {
            const res = await fetch('/api/compact-relay-diagnostics', { cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '生成失败');
            setDiagData(data);
            if (openPreview) setDiagOpen(true);
            return data;
          } catch (error) {
            setDiagStatus({ error: true, text: `生成失败：${error && error.message ? error.message : '未知错误'}` });
            return null;
          } finally {
            setDiagLoading(false);
          }
        },
        [diagLoading],
      );

      /** 「打开问题报告页」：没生成就先生成，再打开宿主拼好的短字段 URL（不碰诊断正文）。 */
      const openIssueReport = useCallback(async () => {
        let data = diagData;
        if (data === null || typeof data.issueUrl !== 'string') data = await generateDiagnostics({ openPreview: false });
        if (data === null || typeof data.issueUrl !== 'string') return;
        try {
          window.open(data.issueUrl, '_blank', 'noopener');
        } catch {
          flashDiagStatus({ error: true, text: '打开问题报告页失败：新窗口被浏览器拦截了' });
        }
      }, [diagData, generateDiagnostics, flashDiagStatus]);

      /** 复制 Markdown / JSON：统一走 navigator.clipboard?.writeText，失败就地提示。 */
      const copyDiagnostics = useCallback(
        (format) => {
          if (diagData === null) {
            flashDiagStatus({ error: true, text: '还没有可复制的诊断信息，请先生成' });
            return;
          }
          const text =
            format === 'json' ? JSON.stringify(diagData.json, null, 2) : typeof diagData.markdown === 'string' ? diagData.markdown : '';
          if (typeof text !== 'string' || text.length === 0) {
            flashDiagStatus({ error: true, text: '还没有可复制的诊断信息，请先生成' });
            return;
          }
          const done = () => flashDiagStatus({ text: '已复制诊断信息（脱敏）' });
          const failed = () => flashDiagStatus({ error: true, text: '复制失败：浏览器不允许访问剪贴板，可手动选中预览文本' });
          try {
            const written = navigator.clipboard?.writeText(text);
            if (written !== undefined && typeof written.then === 'function') written.then(done, failed);
            else done();
          } catch {
            failed();
          }
        },
        [diagData, flashDiagStatus],
      );

      const closeDiagnosticsPreview = useCallback(() => {
        setDiagOpen(false);
        setDiagIntroSeen(true);
      }, []);

      if (form === null) {
        return h(
          'div',
          { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))', padding: '8px 0' } },
          status && status.error ? status.text : '读取设置中…',
        );
      }

      const percent = (ratio) => Math.round(ratio * 100);
      const compactPercent = percent(form.thresholds.compactRatio);
      const count = (value) => (Number.isFinite(value) ? value : 0);
      // 0.4 P1-3：轻账本一行累计数字（只读；数据来自宿主账本，与账本文件同源）。
      const ledgerLine = (() => {
        if (ledger === null) return '累计：暂无记录（完成一次压缩/交接后开始统计）';
        const freed = count(ledger.freedTokens);
        const freedText = freed >= 1_000_000 ? `${(freed / 1_000_000).toFixed(1)}M` : freed >= 1000 ? `${(freed / 1000).toFixed(1)}K` : String(freed);
        const avg = ledger.avgDurationMs !== null && Number.isFinite(ledger.avgDurationMs) ? `${(ledger.avgDurationMs / 1000).toFixed(1)}s` : '—';
        return `累计：已压缩 ${count(ledger.compactCount)} 次 · 交接 ${count(ledger.handoffCount)} 次 · 腾出约 ${freedText} tokens · 平均耗时 ${avg}`;
      })();

      const autoOnNative = native !== null && native.autoEnabled !== false;
      // 0.4.1：配置阈值（thresholdRatio）只是理论上限；实际触发线由宿主按 token 预算算。
      const nativeInfo = nativeLineInfo(native);
      const nativePercent = nativeInfo.configured !== null ? Math.round(nativeInfo.configured * 100) : 80;
      // 原生压缩已关闭时 effective/percentText 为空：回落到「开启后实际会触发多少」，再回落配置阈值。
      const nativeActualText = nativeInfo.percentText !== '' ? nativeInfo.percentText : nativeInfo.actualText !== '' ? nativeInfo.actualText : nativeInfo.configuredText !== null ? nativeInfo.configuredText : String(nativePercent);
      /**
       * 0.4.2（P0-1/P1）：交接线硬上限 = 实际触发线 −5pp（整数百分位），与后台 save() 同一份判定。
       * 实际线算不出时退回配置阈值 −1pp 兜底（与 0.4.1 一致，仅限制输入上限，不告警）。
       * 注意：这里读 nativeInfo.actual（真实触发线），不能用 effective（autoOff/算不出时它会回落配置阈值）。
       */
      const handoffGuardInfo = handoffGuard({
        actualRatio: nativeInfo.actual,
        configuredRatio: nativeInfo.configured,
        handoffRatio: form.thresholds.handoffRatio,
        compactRatio: form.thresholds.compactRatio,
        autoEnabled: autoOnNative,
        fallback: 'configured',
      });
      const handoffCapPercent = handoffGuardInfo.capPercent;
      const handoffLate = handoffGuardInfo.source === 'actual' && handoffGuardInfo.ok === false;
      const handoffCapHint =
        handoffGuardInfo.source === 'actual'
          ? `当前模型实际触发 ${nativeInfo.actualText}%，最高可设 ${handoffCapPercent}%（实际触发线 −5pp）。`
          : autoOnNative && handoffCapPercent !== null
            ? `实际触发线未知（会话未就绪或算不出），暂按配置阈值最高 ${handoffCapPercent}%。`
            : '';
      /**
       * 0.4.2 修复（真机反馈）：交接线被服务端拒绝时，错误文案就地显示在交接线行内。
       * 文案沿用 guard.message（含实际线与目标值），去掉「保存失败：」前缀避免重复。
       */
      const handoffSaveError =
        status !== null && status.error && status.field === 'thresholds.handoffRatio'
          ? String(status.text).replace(/^保存失败：/, '')
          : null;
      // 重算目标 ≤ 压缩线时（保持「交接线 > 压缩线」现有约束）点按钮直接拒绝并提示先降压缩线。
      const handoffRecalcConflict =
        handoffGuardInfo.compactConflict && handoffCapPercent !== null
          ? `按实际线重算目标 ${handoffCapPercent}% 不高于压缩线 ${compactPercent}%，请先把压缩线降到 ${handoffCapPercent}% 以下。`
          : '';
      const previewLight = paletteForScheme(form.colors, 'light');
      const previewDark = paletteForScheme(form.colors, 'dark');
      // 0.4 P0-2：诊断预览弹层复用指示灯那套浮层材质（15-shared.panelChrome）。
      const theme = detectTheme();
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
        { style: { display: 'flex', flexDirection: 'column', maxWidth: 680, padding: '4px 0 8px' } },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '压缩接力'),
        h(
          'p',
          { style: { margin: '0 0 4px', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.95))' } },
          '功能：看上下文容量、到线提醒并帮你压缩旧会话 / 交接新会话、收藏重要回复；边界：只动本插件的压缩与交接历史，不改模型回复，也不接管 DSH 原生自动压缩（只在本页开关、改了要重启）。',
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
                type: 'number',
                inputMode: 'numeric',
                min: 1,
                max: 60,
                step: 1,
                value: percentText('minRatio', form.thresholds.minRatio),
                'aria-label': '最小压缩线（百分比）',
                style: { ...settingsInputStyle, width: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
                onFocus: selectOnFocus,
                onClick: selectOnFocus,
                // 0.4.2 修复：不再按键就夹紧/四舍五入（以前清空会立刻变 5%），草稿优先，越界交服务端拒绝。
                onChange: (event) => changePercent('minRatio', event.target.value),
                onBlur: () => restorePercentDraft('minRatio'),
              }),
              h('span', { style: settingsHintStyle }, '% 窗口'),
            ),
          ),
          settingsRow(
            '压缩提醒线',
            '指示灯到这条线开始变琥珀色，菜单也会建议「压缩旧会话」。',
            '调高 → 更晚提醒、压得更少但上下文更长；调低 → 更早提醒、压得更勤。',
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('input', {
                type: 'number',
                inputMode: 'numeric',
                min: 5,
                max: 95,
                step: 1,
                value: percentText('compactRatio', form.thresholds.compactRatio),
                'aria-label': '压缩提醒线（百分比）',
                style: { ...settingsInputStyle, width: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
                onFocus: selectOnFocus,
                onClick: selectOnFocus,
                onChange: (event) => changePercent('compactRatio', event.target.value),
                onBlur: () => restorePercentDraft('compactRatio'),
              }),
              h('span', { style: settingsHintStyle }, '% 窗口'),
              h('span', { style: settingsHintStyle }, `（1M 窗口 ≈ ${Math.round(1000000 * form.thresholds.compactRatio / 1000)}K）`),
            ),
          ),
          settingsRow(
            '交接提醒线',
            '到这条线内圆亮红点，菜单建议「交接新会话」。',
            '调高 → 更晚换会话、单会话更久；调低 → 更早换会话、单会话更短。必须大于压缩线。',
            h(
              'div',
              { 'data-cr-handoff-field': '1', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              // 控制行：输入框 + 单位 + 上限徽标（上限只做提示，不用来夹紧输入）
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('input', {
                  type: 'number',
                  inputMode: 'numeric',
                  min: 5,
                  // 0.4.2 修复：max 用真实上限（如 62），只作浏览器提示；不再靠代码夹紧改写用户输入。
                  max: handoffCapPercent !== null ? handoffCapPercent : 100,
                  step: 1,
                  value: percentText('handoffRatio', form.thresholds.handoffRatio),
                  'aria-label': '交接提醒线（百分比）',
                  'aria-describedby': 'cr-handoff-cap-hint',
                  style: { ...settingsInputStyle, width: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
                  onFocus: selectOnFocus,
                  onClick: selectOnFocus,
                  // 0.4.2 修复（真机 bug「输入 80 变成 99」）：输入原样保留，不夹紧/不取整/不替用户改。
                  onChange: (event) => changePercent('handoffRatio', event.target.value),
                  onBlur: () => restorePercentDraft('handoffRatio'),
                }),
                h('span', { style: settingsHintStyle }, '% 窗口'),
                handoffCapPercent === null
                  ? null
                  : h('span', {
                      'data-cr-handoff-cap-chip': '1',
                      title: `超过 ${handoffCapPercent}% 保存会被拒绝（会告诉你目标值）；这里不会自动改写你的输入。`,
                      style: percentCapChipStyle,
                    }, `最高 ${handoffCapPercent}%`),
              ),
              // 体量估算单独一行：和上限、告警挤在同一排会显得拥挤。
              h('div', { style: settingsHintStyle }, `（1M 窗口 ≈ ${Math.round(1000000 * form.thresholds.handoffRatio / 1000)}K）`),
              handoffCapHint === '' ? null : h('div', { 'data-cr-handoff-cap': '1', id: 'cr-handoff-cap-hint', style: settingsHintStyle }, handoffCapHint),
              // 超限告警：保存前就可见（amber），保存被拒后由红色失败块接棒（两者不同时出现）。
              handoffLate && handoffSaveError === null
                ? h('div', { 'data-cr-handoff-late': '1', role: 'status', style: alertBoxStyle('warning') }, `⚠ ${handoffGuardInfo.message}`)
                : null,
              // 保存失败（服务端 guard.message）：就地在交接线行内显示，滚动到页面任何位置都不用回头找。
              handoffSaveError === null
                ? null
                : h('div', { 'data-cr-handoff-error': '1', role: 'alert', style: alertBoxStyle('error') }, handoffSaveError),
              // 违规时给「按实际线重算」：目标 = 实际触发线 −5pp（整数百分位），保存前二次确认。
              // 0.4.2 修复：从 11px 灰色小字里挪到独立动作行（右对齐），和告警同属一块可视区，不再跟单位/估算挤在一排。
              handoffLate && handoffCapPercent !== null
                ? h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'flex-end' } },
                    h('button', {
                      type: 'button',
                      'data-cr-recalc': '1',
                      disabled: saving,
                      title: `按当前模型实际触发线 ${nativeInfo.actualText}% 重算：最高可设 ${handoffCapPercent}%`,
                      style: { ...settingsButtonStyle, height: 28, fontSize: 12, padding: '0 12px', whiteSpace: 'nowrap', cursor: saving ? 'wait' : 'pointer' },
                      onClick: () => {
                        if (handoffRecalcConflict !== '') {
                          setConfirmRecalc(null);
                          setStatus({ error: true, text: handoffRecalcConflict, field: 'thresholds.handoffRatio' });
                          return;
                        }
                        setStatus(null);
                        setConfirmRecalc({ ratio: handoffGuardInfo.target, percent: handoffCapPercent });
                      },
                    }, `按实际线重算（${handoffCapPercent}%）`),
                  )
                : null,
            ),
          ),
          confirmRecalc === null
            ? null
            : h(
                'div',
                {
                  'data-cr-recalc-confirm': '1',
                  style: {
                    margin: '0 0 14px',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-state-warning-primary, #d97706)',
                    background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
                  },
                },
                h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, `确认把「交接提醒线」改为 ${confirmRecalc.percent}%？`),
                h(
                  'div',
                  { style: { ...settingsHintStyle, marginBottom: 8 } },
                  `当前模型实际触发 ${nativeInfo.actualText}%，按「实际线 −5pp」向下取整到 ${confirmRecalc.percent}%；` +
                    '点「确认重算」会立即保存生效（不改压缩线、不动其它设置）。',
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: saving,
                      'data-cr-recalc-ok': '1',
                      style: { padding: '4px 12px', borderRadius: 6, border: '1px solid #d97706', background: '#d97706', color: '#fff', cursor: saving ? 'wait' : 'pointer', fontSize: 12 },
                      onClick: () => {
                        void applyRecalc();
                      },
                    },
                    saving ? '保存中…' : '确认重算',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: saving,
                      style: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))', background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer', fontSize: 12 },
                      onClick: () => setConfirmRecalc(null),
                    },
                    '取消',
                  ),
                ),
              ),
        ),
        sectionHeading('推荐收藏'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '推荐收藏' },
          settingsRow(
            '推荐收藏',
            '助手回复落地后，用一个小模型打分（0-100）；够分的星标会金色微亮，提示「这条值得收藏」。',
            '只点亮、**绝不自动收藏**；确认仍要你点星或 /favorite mark。关掉后不再打分（也就不花这份钱）。',
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 } },
              h('input', {
                type: 'checkbox', 'aria-label': '开启推荐收藏', checked: favoriteForm.enabled !== false,
                onChange: (event) => patch(['favorite', 'enabled'], event.target.checked),
              }),
              '开启推荐收藏',
            ),
          ),
          settingsRow(
            '推荐档位',
            '分高才亮：宽松 60 / 标准 75 / 严格 85。',
            '标准档每 4 条回复亮 1 次（准确率约 76%）；严格档更少但更准（约 89%）。',
            h('select', {
              'aria-label': '推荐档位',
              value: favoriteForm.level ?? 'standard',
              style: { ...settingsInputStyle, width: 120 },
              onChange: (event) => patch(['favorite', 'level'], event.target.value),
            },
              h('option', { value: 'loose' }, '宽松（60）'),
              h('option', { value: 'standard' }, '标准（75）'),
              h('option', { value: 'strict' }, '严格（85）'),
            ),
          ),
          settingsRow(
            '必亮词',
            '出现这些词就直接点亮，跳过打分（模型失败也亮）。',
            '多个词用逗号或空格分隔，最多 20 个；适合「定案」「结论」这类固定说法。',
            h('input', {
              type: 'text', 'aria-label': '必亮词', placeholder: '例如：定案，结论，就按这个',
              value: (favoriteForm.mustWords ?? []).join('，'),
              style: { ...settingsInputStyle, width: '100%' },
              onChange: (event) => patch(['favorite', 'mustWords'], parseFavoriteWords(event.target.value)),
            }),
          ),
          settingsRow(
            '屏蔽词',
            '出现这些词就绝不点亮（优先于必亮词和分数）。',
            '屏蔽词优先；比如「测试」「随便试试」这类不该进收藏的说法。',
            h('input', {
              type: 'text', 'aria-label': '屏蔽词', placeholder: '例如：测试，随便',
              value: (favoriteForm.muteWords ?? []).join('，'),
              style: { ...settingsInputStyle, width: '100%' },
              onChange: (event) => patch(['favorite', 'muteWords'], parseFavoriteWords(event.target.value)),
            }),
          ),
          settingsRow(
            '试算',
            '粘一段助手回复原文，按上面的档位/词表跑一次真实打分（只读，不写收藏）。',
            '试算会真的调一次小模型（约 1-2 秒、少量 token）；结果只用来调档位。',
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%' } },
              h('textarea', {
                'aria-label': '试算文本',
                rows: 3,
                placeholder: '粘贴一段助手回复原文…',
                value: trialText,
                style: { ...settingsInputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 60 },
                onChange: (event) => setTrialText(event.target.value),
              }),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('button', { type: 'button', style: settingsButtonStyle, disabled: trialBusy, onClick: runTrial }, trialBusy ? '试算中…' : '试算'),
                trialResult === null
                  ? null
                  : h('span', { style: { ...settingsHintStyle, color: trialResult.error ? 'var(--dsw-alias-state-warning-primary, #b45309)' : undefined } }, trialResult.text),
              ),
            ),
          ),
        ),
        sectionHeading('压缩行为'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '压缩行为' },
          settingsRow(
            '摘要份数上限',
            '摘要攒到这么多份后，压缩不再只压最后一个摘要之后的内容，而是从会话开头连同全部旧摘要一起压成 1 条；之后每次压缩都会这样，压掉的原文和旧摘要都回不来。想到这一步之前换会话，就用「交接新会话」。',
            '调高 → 可以多压几轮再交接（默认 6）；调低 → 更早交接，但旧摘要会更早被合并，且合并后不可逆。',
            h('input', {
              type: 'number', min: 1, max: 20, step: 1, value: count(form.thresholds.maxSummaries), 'aria-label': '摘要份数上限', style: { ...settingsInputStyle, width: 90 },
              onChange: (event) => patch(['thresholds', 'maxSummaries'], Math.max(1, Math.round(Number(event.target.value)))),
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
                ? `当前开启：容量到 ${nativeActualText}% 时，DSH 会自己把历史压成摘要（不读本插件的锁定）。`
                : '当前已关闭：DSH 不再自动压历史，只有你主动压缩/交接才会动历史。',
            autoOnNative
              ? `开启时：容量到 ${nativeActualText}% DSH 会自己压历史（不读锁定）；关闭后：只在你主动压缩/交接时才动历史。${nativeInfo.differs ? `（${nativeInfo.why}）` : ''}`
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
              h('span', { style: settingsHintStyle }, native !== null
                ? (nativeInfo.autoOff
                  ? (nativeInfo.actualText !== ''
                    ? `原生阈值 配置 ${nativeInfo.configuredText ?? nativePercent}%（已关闭；开启后实际触发 ${nativeInfo.actualText}%）`
                    : `原生阈值 配置 ${nativeInfo.configuredText ?? nativePercent}%（已关闭）`)
                  : (nativeInfo.differs ? `原生阈值 配置 ${nativeInfo.configuredText}%（实际触发 ${nativeInfo.percentText}%）` : `原生阈值 ${nativeActualText}%`))
                : ''),
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
                      `改变：DSH 不再在容量到 ${nativeActualText}% 时自动压缩历史；锁定的消息不会被压掉；本插件的提醒和手动压缩照常。需要重启 DSH 生效。`
                    : `操作内容：在 DSH profile 的 cordis.patch.yml 里把 compaction-basic 的 auto 改回 true（写前备份，可回滚）。` +
                      `改变：DSH 重新在容量到 ${nativeActualText}% 时自动压历史，可能压掉锁定的消息。需要重启 DSH 生效。`,
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
            if (native !== null && native.autoEnabled !== false && nativeInfo.effective !== null) {
              legend.push({
                ratio: Math.min(0.95, nativeInfo.effective + 0.06),
                hint: null,
                nativeAt: nativeInfo.effective,
                title: '原生自动压缩线',
                text: nativeInfo.differs
                  ? `实际 ${nativeInfo.percentText}%：DSH 会自己压历史（配置阈值 ${nativeInfo.configuredText}%，越过整环红色闪烁）`
                  : `${nativeInfo.percentText}%：DSH 会自己压历史（越过整环红色闪烁）`,
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
          // 0.4 P0-2：诊断信息 —— 本机生成、白名单、已脱敏；只提供「生成/预览/复制」。
          h(
            'div',
            { style: { marginBottom: 18, paddingTop: 12, borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.25))' }, 'data-cr-diagnostics': '1' },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, '诊断信息'),
            h('p', { style: { ...settingsHintStyle, margin: '0 0 2px' } }, '只在本机生成，不会自动外发；生成后可以先预览，再决定把哪部分粘贴到哪里。'),
            h(
              'p',
              { style: settingsHintStyle },
              '内容只有版本、平台、配置数值、状态摘要、计数、耗时与错误码；不含聊天内容、摘要、交接单正文、文件路径、用户名、会话 id、密钥或 cookie。',
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
              h(
                'button',
                {
                  type: 'button',
                  'data-cr-diagnostics-generate': '1',
                  style: settingsButtonStyle,
                  disabled: diagLoading,
                  onClick: () => void generateDiagnostics(),
                },
                diagLoading ? '生成中…' : '生成并预览',
              ),
              h(
                'button',
                { type: 'button', 'data-cr-diagnostics-issue': '1', style: settingsButtonStyle, onClick: () => void openIssueReport() },
                '打开问题报告页',
              ),
              diagStatus === null
                ? null
                : h(
                    'span',
                    {
                      'data-cr-diagnostics-status': diagStatus.error ? 'error' : 'ok',
                      style: {
                        fontSize: 11,
                        lineHeight: '16px',
                        color: diagStatus.error ? 'var(--dsw-alias-state-error-primary, #D92D20)' : 'var(--dsw-alias-state-success-primary, #15803D)',
                      },
                    },
                    diagStatus.text,
                  ),
            ),
            h('p', { style: { ...settingsHintStyle, marginTop: 6 } }, 'issue 页是公开的；粘贴前请自己再看一眼。'),
          ),
        ),
        sectionHeading('关于与危险操作'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '关于与危险操作' },
          h('p', { style: settingsHintStyle }, `版本：${version || '—'}`),
          h('p', { style: settingsHintStyle, 'data-cr-ledger': '1' }, ledgerLine),
          h('p', { style: settingsHintStyle }, `设置文件：${settingsPath || '—'}`),
          h('p', { style: { ...settingsHintStyle, marginTop: 8 } }, '输入框左侧的上下文指示灯：看容量、提醒压缩/交接、收藏重要回复；到线了用 /bc 或 /handoff，重要内容用 /fin 锁住。'),
          h('p', { style: settingsHintStyle }, '遇到 bug 或想提改进：走上面「帮助」里的 GitHub Issues；也欢迎直接发邮件。'),
          h('p', { style: settingsHintStyle }, '联系方式：cfanzx@136.com（合作、安全问题，以及不便公开讨论的事项）。'),
          h('p', { style: settingsHintStyle }, 'npm 包页面：https://www.npmjs.com/package/dsh-compact-relay'),
          h('p', { style: settingsHintStyle }, '致谢：DeepSeek Harness；设置栏实现参考了 dsh-plugin-memory；也谢谢帮忙测试的朋友们。'),
          h(
            'p',
            { style: { ...settingsHintStyle, marginTop: 20, paddingTop: 14, borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.25))' } },
            '危险操作：恢复默认会删除你的设置文件。入口在页面底部常驻的保存工具条里，点一次后还需要再确认一次（不会误删）。',
          ),
        ),
        /**
         * 0.4.2 修复（真机反馈「保存按键太靠下了」）：设置页很长，保存/恢复默认改成
         * 粘性底部工具条 —— 页面滚到哪都固定在视口底部，不用滚到页尾才能点保存。
         *
         * 为什么用 sticky 而不是 fixed：它是流内元素，天然只占页面末尾那一格，
         * 不会盖住最后一块内容；滚动中固定在底部时给宿主弹层留出 12px 内边距 +
         * 安全区 padding，避免贴边/遮挡。
         *
         * 0.4.2 视觉打磨：按钮组靠左、状态靠右（marginLeft:auto 对齐，不再错位），
         * 状态做成淡色小胶囊（失败红 / 成功绿 / 无状态时占位提示，行高不跳）；
         * 底色/投影用现有 DSH token + theme.dark 兜底，深色浅色都不糊。
         */
        h(
          'div',
          {
            'data-cr-savebar': '1',
            style: {
              position: 'sticky',
              bottom: 0,
              zIndex: 20,
              marginTop: 20,
              marginLeft: -8,
              marginRight: -8,
              padding: '8px 10px calc(8px + env(safe-area-inset-bottom, 0px))',
              borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22))',
              background: `var(--dsw-alias-bg-layer-1, ${theme.dark ? 'rgba(32,33,36,0.94)' : 'rgba(255,255,255,0.94)'})`,
              backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(10px))',
              WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, blur(10px))',
              boxShadow: theme.dark ? '0 -6px 18px rgba(0,0,0,0.42)' : '0 -6px 18px rgba(0,0,0,0.08)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                'data-cr-save': '1',
                disabled: saving,
                style: {
                  ...settingsButtonStyle,
                  height: 30,
                  padding: '0 16px',
                  fontWeight: 600,
                  background: 'var(--dsw-alias-button-primary, #2563eb)',
                  color: '#fff',
                  border: 'none',
                  cursor: saving ? 'wait' : 'pointer',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
                },
                onClick: () => void save(),
              },
              saving ? '保存中…' : dirty ? '保存修改' : '保存',
            ),
            h(
              'button',
              {
                type: 'button',
                'data-cr-reset': '1',
                disabled: saving,
                style: { ...settingsButtonStyle, height: 30, cursor: saving ? 'wait' : 'pointer' },
                onClick: () => setConfirmReset(true),
              },
              '恢复默认',
            ),
            dirty
              ? h('span', { 'data-cr-dirty': '1', style: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-state-warning-primary, #b45309)' } }, '有未保存的修改')
              : h('span', { 'data-cr-dirty': '0', style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } }, '已是最新'),
            // 没有状态时右侧放提示占位：按钮行高度稳定，不会因为状态出现/消失而跳。
            status === null
              ? h('span', { style: { ...settingsHintStyle, marginLeft: 'auto', textAlign: 'right' } }, '改完随时点「保存」，不用滚到页尾。')
              : null,
          ),
          // 状态单独一行（失败文案可能两行）：淡色胶囊 + 状态色文字，条内也看得清，且不把按钮挤歪。
          status === null
            ? null
            : h(
                'div',
                {
                  'data-cr-save-status': status.error ? 'error' : 'ok',
                  role: status.error ? 'alert' : 'status',
                  style: {
                    padding: '4px 8px',
                    borderRadius: 6,
                    background: status.error ? 'rgba(217, 45, 32, 0.10)' : 'rgba(21, 128, 61, 0.10)',
                    color: status.error
                      ? 'var(--dsw-alias-state-error-primary, #D92D20)'
                      : 'var(--dsw-alias-state-success-primary, #15803D)',
                    fontSize: 11,
                    lineHeight: '16px',
                    fontWeight: status.error ? 600 : 500,
                  },
                },
                status.text,
              ),
          confirmReset
            ? h(
                'div',
                {
                  'data-cr-reset-confirm': '1',
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    paddingTop: 6,
                    borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
                  },
                },
                h('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary, #d92d20)' } }, '确定恢复默认？（会删除你的设置文件）'),
                h('button', { type: 'button', style: settingsButtonStyle, disabled: saving, onClick: () => void reset() }, '确定恢复'),
                h('button', { type: 'button', style: settingsButtonStyle, disabled: saving, onClick: () => setConfirmReset(false) }, '取消'),
              )
            : null,
        ),
        // 0.4 P0-2：诊断信息预览弹层（只读等宽文本 + 复制 Markdown/JSON）。
        // 只有用户点了「生成并预览」/「打开问题报告页」才会出现；关掉后本次会话不再显示首次说明卡。
        diagOpen && diagData !== null
          ? h(
              'div',
              {
                'data-cr-diagnostics-modal': '1',
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 60,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 24,
                  background: 'rgba(0,0,0,0.36)',
                },
              },
              h(
                'div',
                {
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label': '诊断信息预览（脱敏）',
                  style: {
                    ...panelChrome(theme),
                    display: 'flex',
                    flexDirection: 'column',
                    width: '100%',
                    maxWidth: 760,
                    maxHeight: '80vh',
                    borderRadius: 12,
                    padding: '14px 16px',
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
                  h('div', { style: { fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary, inherit)' } }, '诊断信息预览（脱敏）'),
                  h('button', { type: 'button', style: settingsButtonStyle, onClick: closeDiagnosticsPreview }, '关闭'),
                ),
                diagIntroSeen
                  ? null
                  : h(
                      'div',
                      {
                        style: {
                          marginTop: 10,
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))',
                          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
                        },
                      },
                      h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, '第一次生成：先看三点'),
                      h(
                        'p',
                        { style: settingsHintStyle },
                        '① 只在本机生成，插件不会自己发到任何地方；② 只有数值、枚举与错误码，不含聊天内容与文件路径；③ issue 页是公开的，粘贴前请自己再看一眼。',
                      ),
                    ),
                h(
                  'pre',
                  {
                    'data-cr-diagnostics-preview': '1',
                    'aria-label': '诊断信息 Markdown 预览（只读）',
                    style: {
                      flex: 1,
                      minHeight: 120,
                      overflow: 'auto',
                      margin: '10px 0',
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
                      background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
                      color: 'inherit',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      fontSize: 11,
                      lineHeight: '16px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      userSelect: 'text',
                    },
                  },
                  typeof diagData.markdown === 'string' && diagData.markdown.length > 0 ? diagData.markdown : '（没有内容）',
                ),
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h(
                    'button',
                    { type: 'button', 'data-cr-diagnostics-copy': 'markdown', style: settingsButtonStyle, onClick: () => copyDiagnostics('markdown') },
                    '复制 Markdown',
                  ),
                  h(
                    'button',
                    { type: 'button', 'data-cr-diagnostics-copy': 'json', style: settingsButtonStyle, onClick: () => copyDiagnostics('json') },
                    '复制 JSON',
                  ),
                  h('span', { style: settingsHintStyle }, 'issue 是公开的；粘贴前请自己再看一眼。'),
                  diagStatus === null
                    ? null
                    : h(
                        'span',
                        {
                          'data-cr-diagnostics-copy-status': diagStatus.error ? 'error' : 'ok',
                          style: {
                            fontSize: 11,
                            lineHeight: '16px',
                            color: diagStatus.error
                              ? 'var(--dsw-alias-state-error-primary, #D92D20)'
                              : 'var(--dsw-alias-state-success-primary, #15803D)',
                          },
                        },
                        diagStatus.text,
                      ),
                ),
              ),
            )
          : null,
        // A4：复制/打开结果的短 toast（成功与失败都提示；自动消失，不挡操作）。
        diagStatus === null
          ? null
          : h(
              'div',
              {
                'data-cr-diagnostics-toast': diagStatus.error ? 'error' : 'ok',
                role: 'status',
                style: {
                  ...panelChrome(theme),
                  position: 'fixed',
                  right: 24,
                  bottom: 24,
                  zIndex: 70,
                  maxWidth: 360,
                  padding: '8px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: '17px',
                  color: diagStatus.error ? 'var(--dsw-alias-state-error-primary, #D92D20)' : 'var(--dsw-alias-label-primary, inherit)',
                },
              },
              diagStatus.text,
            ),
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

      // 0.6 收藏星标：挂助手消息底部动作行（宿主只对已定稿助手消息渲染）。
      // 会话 id 必须由 slot 的 session 作用域注入，不能靠 state 接口猜「当前会话」：
      // 多工作区同时活着时宿主会回「最后一个活 agent」的会话（2026-10-29 真机 BUG：点星静默失败）。
      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'compact-relay-favorite',
            inject: (sessionId) => ({
              sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
            }),
          },
          FavoriteStar,
        ),
      );

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

      // 0.5.0 接力条 v1：输入卡上方通栏一行「已接力自 …」+ 向上弹出的下拉菜单。
      // 组件内部再判断 chain：无链/老宿主没有 chain 字段 → 返回 null，不占高度。
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'compact-relay',
            // 宿主 TodoPanel 是 0、queue 是 20；接力条夹在中间（输入卡正上方）。
            order: 10,
            inject: (sessionId) => ({
              sessionId,
              openSession: (targetSessionId) => ctx.uiWorkspace.openSession(targetSessionId),
              // 0.5.0：恢复归档旧会话（与侧栏「取消归档」同一条 Client 接缝）。
              // 老宿主没有这个方法时传 undefined，组件会退回 HTTP recover。
              unarchiveSession:
                typeof ctx.uiWorkspace?.unarchiveSession === 'function'
                  ? (targetSessionId) => ctx.uiWorkspace.unarchiveSession(targetSessionId)
                  : undefined,
            }),
          },
          CompactRelayBar,
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
