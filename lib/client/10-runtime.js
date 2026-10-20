
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
