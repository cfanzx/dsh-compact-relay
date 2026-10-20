export const DEFAULT_BASE = { idle: '#6F7680', compact: '#C26A00', handoff: '#D92D20', stage: '#2563EB', pin: '#C026D3' };

/** DSH 原生自动压缩线的标记色：刻意不用五级配色里的任何颜色，保证一眼和环上的红/琥珀分开。 */
export const NATIVE_LINE_COLOR = '#7C3AED';
export const SCHEME_BG = { light: '#ffffff', dark: '#1c1c22' };

export function normalizeHex(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
  }
  return fallback;
}

export function hexToHsl(hex) {
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

export function hslToHex(h, s, l) {
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

export function luminance(hex) {
  const n = parseInt(normalizeHex(hex, '#888888').slice(1), 16);
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export function deriveColor(baseHex, scheme) {
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
export function basePalette(colors) {
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
export function paletteForScheme(colors, scheme) {
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
export function effectiveScheme(colors, detectedDark) {
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
export function resolvePalette(colors, detectedDark) {
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
export function paletteForBothSchemes(colors) {
  return { light: paletteForScheme(colors, 'light'), dark: paletteForScheme(colors, 'dark') };
}
