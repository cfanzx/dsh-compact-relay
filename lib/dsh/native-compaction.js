/**
 * 读取 / 修改 DSH 原生自动压缩的配置（0.3.1）。
 *
 * 原生压缩插件 `@deepseek-ai/dsh-compaction-basic` 的默认值：
 *   auto: true（默认自动压缩，会话压力到 80% 自己压）
 *   thresholdRatio: 0.8（80% 触发）
 * 用户可以在 profile 的 `cordis.patch.yml` 里按 `- id: compaction-basic` 覆盖。
 *
 * 本模块只做两件事：
 * 1. 读当前��效值（用户覆盖 + 默认值），供指示灯/设置页显示；
 * 2. 写开关（关闭/恢复自动压缩）——追加或修改那一条，**写前备份**、原子替换。
 *
 * 写操作改的是 DSH profile 配置文件，重启 DSH 才生效；调用方（HTTP action）
 * 负责向用户说明这一点。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NATIVE_PLUGIN_ID = 'compaction-basic';
export const NATIVE_PLUGIN_NAME = '@deepseek-ai/dsh-compaction-basic';
/** DSH 默认值（compaction-basic 源码：auto ?? true、thresholdRatio ?? 0.8）。 */
export const NATIVE_DEFAULTS = { autoEnabled: true, thresholdRatio: 0.8 };

const cache = { key: null, value: null };

/** 找 profile 目录：优先 desktop-host 命令行参数里的路径，否则回落 ~/.dsh/profiles/desktop。 */
export function resolveProfileDir() {
  for (const arg of process.argv) {
    if (typeof arg !== 'string' || !arg.startsWith('/')) continue;
    try {
      if (fs.statSync(arg).isDirectory() && fs.existsSync(path.join(arg, 'cordis.patch.yml'))) return arg;
    } catch {
      /* 不是目录或读不到，继续找 */
    }
  }
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
}

export function resolvePatchFile(profileDir = resolveProfileDir()) {
  return path.join(profileDir, 'cordis.patch.yml');
}

/**
 * 解析 patch 文本里 compaction-basic 条目的覆盖值。
 * @param {string} text
 * @returns {{found:boolean, autoEnabled?:boolean, thresholdRatio?:number}}
 */
export function parseCompactionOverride(text) {
  if (typeof text !== 'string' || text.length === 0) return { found: false };
  const lines = text.split('\n');
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*-\s+id:\s*['"]?compaction-basic['"]?\s*$/.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start < 0) return { found: false };
  const override = { found: true };
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^-\s/.test(line)) break; // 下一个顶层条目
    const auto = /^\s*auto:\s*(true|false)\s*(?:#.*)?$/.exec(line);
    if (auto !== null) override.autoEnabled = auto[1] === 'true';
    const ratio = /^\s*thresholdRatio:\s*([0-9.]+)\s*(?:#.*)?$/.exec(line);
    if (ratio !== null) {
      const value = Number(ratio[1]);
      if (Number.isFinite(value) && value > 0 && value <= 1) override.thresholdRatio = value;
    }
  }
  return override;
}

/**
 * 读当前生效的原生压缩配置（用户覆盖 + 默认值）。带 mtime 缓存，避免每帧 stat 读文件。
 * @param {string} [profileDir]
 * @returns {{autoEnabled:boolean, thresholdRatio:number, override:object, file:string}}
 */
export function readNativeCompaction(profileDir = resolveProfileDir()) {
  const file = resolvePatchFile(profileDir);
  let key = `${file}:missing`;
  let text = '';
  try {
    const stat = fs.statSync(file);
    key = `${file}:${stat.mtimeMs}:${stat.size}`;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  if (cache.key === key && cache.value !== null) return cache.value;
  const override = parseCompactionOverride(text);
  const value = {
    autoEnabled: override.autoEnabled ?? NATIVE_DEFAULTS.autoEnabled,
    thresholdRatio: override.thresholdRatio ?? NATIVE_DEFAULTS.thresholdRatio,
    override,
    file,
  };
  cache.key = key;
  cache.value = value;
  return value;
}

/** 把 compaction-basic 条目改成指定 auto 值；返回新文本。纯函数，便于单测。 */
export function applyAutoOverride(text, enabled) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split('\n');
  const flag = enabled ? 'true' : 'false';
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*-\s+id:\s*['"]?compaction-basic['"]?\s*$/.test(lines[index])) {
      start = index;
      break;
    }
  }

  if (start >= 0) {
    // 已有条目：改 auto 行；没有就在 config: 下插入（缩进按 config 行 + 2）。
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^-\s/.test(lines[index])) {
        end = index;
        break;
      }
    }
    const block = lines.slice(start, end);
    let autoIndex = -1;
    let configIndex = -1;
    for (let offset = 0; offset < block.length; offset += 1) {
      if (/^\s*auto:\s*(true|false)\s*(?:#.*)?$/.test(block[offset])) autoIndex = offset;
      if (/^\s*config:\s*$/.test(block[offset])) configIndex = offset;
    }
    if (autoIndex >= 0) {
      const indent = /^(\s*)/.exec(block[autoIndex])[1];
      block[autoIndex] = `${indent}auto: ${flag}`;
    } else if (configIndex >= 0) {
      const indent = `${/^(\s*)/.exec(block[configIndex])[1]}  `;
      block.splice(configIndex + 1, 0, `${indent}auto: ${flag}`);
    } else {
      block.splice(1, 0, '  config:', `    auto: ${flag}`);
    }
    return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
  }

  // 没有条目：追加到末尾（顶层数组项）。
  const base = source.endsWith('\n') || source.length === 0 ? source : `${source}\n`;
  const timestamp = new Date().toISOString().slice(0, 10);
  return (
    `${base}# 由 dsh-compact-relay 追加（${timestamp}）：${enabled ? '恢复' : '关闭'} DSH 原生自动压缩（重启 DSH 生效）\n` +
    `- id: ${NATIVE_PLUGIN_ID}\n` +
    `  name: '${NATIVE_PLUGIN_NAME}'\n` +
    '  config:\n' +
    `    auto: ${flag}\n`
  );
}

/**
 * 写开关：备份原文件 → 原子替换 → 清缓存。
 * @param {boolean} enabled 想设置成的状态（true=恢复原生自动压缩）
 * @param {string} [profileDir]
 * @returns {{ok:boolean, autoEnabled:boolean, thresholdRatio:number, file:string, backup:string|null}}
 */
export function setNativeAutoCompaction(enabled, profileDir = resolveProfileDir()) {
  const file = resolvePatchFile(profileDir);
  let original = '';
  try {
    original = fs.readFileSync(file, 'utf8');
  } catch {
    original = '';
  }
  const next = applyAutoOverride(original, enabled);
  let backup = null;
  if (original.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${file}.bak-dcr-${stamp}`;
    fs.writeFileSync(backup, original, 'utf8');
  }
  const tmp = `${file}.tmp-dcr-${process.pid}`;
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
  cache.key = null;
  cache.value = null;
  const current = readNativeCompaction(profileDir);
  return { ok: true, autoEnabled: current.autoEnabled, thresholdRatio: current.thresholdRatio, file, backup };
}
