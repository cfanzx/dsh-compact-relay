/**
 * 读取 / 修改 DSH 原生自动压缩的配置（0.3.1）。
 *
 * 原生压缩插件 `@deepseek-ai/dsh-compaction-basic` 的默认值：
 *   auto: true（默认自动压缩，会话压力到 80% 自己压）
 *   thresholdRatio: 0.8（80% 触发）
 * 用户可以在 profile 的 `cordis.patch.yml` 里按 `- id: compaction-basic` 覆盖。
 *
 * 0.4 P2-3：解析 `headroomTokens` 与 `modelPolicies`，供「真实触发线」计算
 * （thresholdTokens = floor(min(W × ratio, W − 输出预留 − headroom))，见 core/native-line.js）。
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

import { NATIVE_HEADROOM_DEFAULT } from '../core/native-line.js';

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

/* ------------------------------------------------------------------ *
 * YAML 缩进层级工具（0.3.6 / BUG-012）
 *
 * 为什么不用「正则扫全文件」：cordis.patch.yml 是 YAML，
 * compaction-basic 的配置结构是
 *
 *   - id: compaction-basic
 *     config:
 *       auto: false
 *       thresholdRatio: 0.7
 *       modelPolicies:            ← 嵌套层，不是这个插件的「全局线」
 *         mac-unc:
 *           thresholdRatio: 0.5
 *
 * 旧实现只按「下一个顶层 `-` 条目」截断，会把 modelPolicies 里的 0.5 当成全局
 * thresholdRatio（Windows 真实会话 session-1f90f5ee，2026-10-23：指示灯误报 50%）。
 * 现在统一按**缩进**定位三层：插件条目 → 它的 `config:` 直接子键 → 只认这一层；
 * 更深的嵌套层（modelPolicies[*] 等）一律忽略。parse / apply 共用同一套定位。
 * ------------------------------------------------------------------ */

const ENTRY_ID_RE = /^(\s*)-\s+id:\s*['"]?compaction-basic['"]?\s*(?:#.*)?$/;
const CONFIG_RE = /^(\s*)config\s*:\s*(?:#.*)?$/;
const AUTO_RE = /^auto\s*:\s*(true|false)\s*(?:#.*)?$/;
const RATIO_RE = /^thresholdRatio\s*:\s*['"]?([0-9.]+)['"]?\s*(?:#.*)?$/;
const HEADROOM_RE = /^headroomTokens\s*:\s*['"]?(\d+)['"]?\s*(?:#.*)?$/;
/** 0.5.1 批 2：保留近期尾部的两种写法（compaction-basic 的 retainRatio / retainTokens）。 */
const RETAIN_RATIO_RE = /^retainRatio\s*:\s*['"]?([0-9.]+)['"]?\s*(?:#.*)?$/;
const RETAIN_TOKENS_RE = /^retainTokens\s*:\s*['"]?(\d+)['"]?\s*(?:#.*)?$/;
/** modelPolicies 列表项里的键（- provider: x / model: y / thresholdRatio: 0.5 / headroomTokens: 4096）。 */
const POLICY_PROVIDER_RE = /^provider\s*:\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/;
const POLICY_MODEL_RE = /^model\s*:\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/;
const POLICY_ITEM_RE = /^(\s*)-\s+(.*)$/;

/** 按行拆文本，保留原换行风格（CRLF 文件 apply 后仍是 CRLF）。 */
function splitText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(/\r?\n/), eol };
}

function indentOf(line) {
  return /^(\s*)/.exec(line)[1].length;
}

/**
 * 找第一个 compaction-basic 条目，返回 `{start, end, indent}`（end 为开区间）。
 * 条目范围到「同缩进或更浅的下一个 - 列表项」为止；嵌套列表项缩进更深，不算结束。
 */
function locateEntry(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = ENTRY_ID_RE.exec(lines[index]);
    if (match === null) continue;
    const indent = match[1].length;
    let entryEnd = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim().length === 0) continue;
      if (/^\s*-\s/.test(line) && indentOf(line) <= indent) {
        entryEnd = next;
        break;
      }
    }
    return { start: index, end: entryEnd, indent };
  }
  return null;
}

/**
 * 在条目范围内找 `config:`（必须是条目的直接子键），并确定其直接子键缩进。
 * @returns {{configIndex:number, configIndent:number, childIndent:number|null}|null}
 *   null = 条目里没有 config:；childIndent=null = config: 是空的/列表（没有直接子键）。
 */
function locateConfig(lines, entry) {
  for (let index = entry.start + 1; index < entry.end; index += 1) {
    const match = CONFIG_RE.exec(lines[index]);
    if (match === null) continue;
    const configIndent = match[1].length;
    if (configIndent <= entry.indent) continue; // 必须是条目的直接子键，不是更浅层级
    let childIndent = null;
    for (let next = index + 1; next < entry.end; next += 1) {
      const line = lines[next];
      if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
      const indent = indentOf(line);
      if (indent <= configIndent) break; // config 结束（回到同级/更浅）
      if (/^\s*-\s/.test(line)) break; // config 是列表，不是键值映射
      childIndent = indent;
      break;
    }
    return { configIndex: index, configIndent, childIndent };
  }
  return null;
}

/**
 * 在 config 的**直接子键**里找匹配的行号；缩进更深（嵌套层）的行不认。
 * @returns {number} 行号；没有返回 -1
 */
function findDirectChild(lines, entry, config, keyRe) {
  if (config === null || config.childIndent === null) return -1;
  for (let index = config.configIndex + 1; index < entry.end; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);
    if (indent < config.childIndent) break; // 出了 config 块
    if (indent !== config.childIndent) continue; // 更深 = 嵌套层，忽略
    if (/^\s*-\s/.test(line)) continue;
    if (keyRe.test(line.trim())) return index;
  }
  return -1;
}

/**
 * 解析 patch 文本里 compaction-basic 条目的覆盖值。
 *
 * 只读 `config:` 的**直接子键** `auto` / `thresholdRatio`：
 *   - `config.modelPolicies[*]` 或任意更深嵌套层里的同名键不算全局线（BUG-012）；
 *   - 没有 `config:` / config 为空 → `{found:true}`（found 只表示条目存在，读侧回落默认值）；
 *   - 多个 compaction-basic 条目时取第一个。
 *
 * @param {string} text
 * @returns {{found:boolean, autoEnabled?:boolean, thresholdRatio?:number}}
 */
export function parseCompactionOverride(text) {
  if (typeof text !== 'string' || text.length === 0) return { found: false };
  const { lines } = splitText(text);
  const entry = locateEntry(lines);
  if (entry === null) return { found: false };

  const override = { found: true };
  const config = locateConfig(lines, entry);
  if (config === null || config.childIndent === null) return override;

  const autoIndex = findDirectChild(lines, entry, config, AUTO_RE);
  if (autoIndex >= 0) {
    const match = AUTO_RE.exec(lines[autoIndex].trim());
    if (match !== null) override.autoEnabled = match[1] === 'true';
  }
  const ratioIndex = findDirectChild(lines, entry, config, RATIO_RE);
  if (ratioIndex >= 0) {
    const match = RATIO_RE.exec(lines[ratioIndex].trim());
    if (match !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value <= 1) override.thresholdRatio = value;
    }
  }
  // 0.4 P2-3：headroomTokens 也是 config 直属子键（全局余量，默认 65536）。
  const headroomIndex = findDirectChild(lines, entry, config, HEADROOM_RE);
  if (headroomIndex >= 0) {
    const match = HEADROOM_RE.exec(lines[headroomIndex].trim());
    if (match !== null) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value >= 0) override.headroomTokens = value;
    }
  }
  // 0.5.1 批 2：原生压缩保留尾部预算（预判「会覆盖哪些 pin」用；不改原生行为）。
  const retainRatioIndex = findDirectChild(lines, entry, config, RETAIN_RATIO_RE);
  if (retainRatioIndex >= 0) {
    const match = RETAIN_RATIO_RE.exec(lines[retainRatioIndex].trim());
    if (match !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 0 && value < 1) override.retainRatio = value;
    }
  }
  const retainTokensIndex = findDirectChild(lines, entry, config, RETAIN_TOKENS_RE);
  if (retainTokensIndex >= 0) {
    const match = RETAIN_TOKENS_RE.exec(lines[retainTokensIndex].trim());
    if (match !== null) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value >= 0) override.retainTokens = value;
    }
  }
  return override;
}

/**
 * 0.4 P2-3：解析 `config.modelPolicies`（嵌套层，按 provider+model 精确匹配的路由级覆盖）。
 *
 * 支持 DSH Loader 的两种 YAML 写法（Win 真实配置用的是列表写法）：
 *   modelPolicies:
 *     - provider: mac-unc
 *       model: qwen35-unc-64k
 *       headroomTokens: 4096
 *   或映射写法（key 当 model）：
 *   modelPolicies:
 *     mac-unc:
 *       thresholdRatio: 0.5
 *
 * 只收 `thresholdRatio`（0–1）与 `headroomTokens`（≥0）；其它键忽略。
 * @param {string} text
 * @returns {Array<{provider:string|null, model:string|null, thresholdRatio?:number, headroomTokens?:number}>}
 */
export function parseModelPolicies(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const { lines } = splitText(text);
  const entry = locateEntry(lines);
  if (entry === null) return [];
  const config = locateConfig(lines, entry);
  if (config === null || config.childIndent === null) return [];
  const start = findDirectChild(lines, entry, config, /^modelPolicies\s*:\s*(?:#.*)?$/);
  if (start < 0) return [];
  const blockIndent = indentOf(lines[start]);
  const policies = [];
  let current = null;
  const flush = () => {
    if (current === null) return;
    if (
      current.thresholdRatio !== undefined ||
      current.headroomTokens !== undefined ||
      current.retainRatio !== undefined ||
      current.retainTokens !== undefined
    ) {
      policies.push(current);
    }
    current = null;
  };
  for (let index = start + 1; index < entry.end; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);
    if (indent <= blockIndent) break;
    const item = POLICY_ITEM_RE.exec(line);
    if (item !== null && indent > blockIndent) {
      // 列表项：- provider: x 或 - model: y（同缩进的新项）
      if (item[1].length <= blockIndent + 2) { flush(); current = { provider: null, model: null }; }
      const rest = item[2].trim();
      const pm = POLICY_PROVIDER_RE.exec(rest);
      const mm = POLICY_MODEL_RE.exec(rest);
      if (current === null) current = { provider: null, model: null };
      if (pm !== null) current.provider = pm[1];
      else if (mm !== null) current.model = mm[1];
      continue;
    }
    const trimmed = line.trim();
    const ratioMatch = RATIO_RE.exec(trimmed);
    const headMatch = HEADROOM_RE.exec(trimmed);
    const retainRatioMatch = RETAIN_RATIO_RE.exec(trimmed);
    const retainTokensMatch = RETAIN_TOKENS_RE.exec(trimmed);
    const providerMatch = POLICY_PROVIDER_RE.exec(trimmed);
    const modelMatch = POLICY_MODEL_RE.exec(trimmed);
    if (
      ratioMatch !== null ||
      headMatch !== null ||
      retainRatioMatch !== null ||
      retainTokensMatch !== null ||
      providerMatch !== null ||
      modelMatch !== null
    ) {
      if (current === null) current = { provider: null, model: null };
      if (ratioMatch !== null) {
        const value = Number(ratioMatch[1]);
        if (Number.isFinite(value) && value > 0 && value <= 1) current.thresholdRatio = value;
      } else if (headMatch !== null) {
        const value = Number(headMatch[1]);
        if (Number.isInteger(value) && value >= 0) current.headroomTokens = value;
      } else if (retainRatioMatch !== null) {
        const value = Number(retainRatioMatch[1]);
        if (Number.isFinite(value) && value >= 0 && value < 1) current.retainRatio = value;
      } else if (retainTokensMatch !== null) {
        const value = Number(retainTokensMatch[1]);
        if (Number.isInteger(value) && value >= 0) current.retainTokens = value;
      } else if (providerMatch !== null) current.provider = providerMatch[1];
      else current.model = modelMatch[1];
      continue;
    }
    // 映射写法：更深一层的 key 行当 model，其下缩进再深的键值由后续循环计入（current 不变）。
    const keyMatch = /^([A-Za-z0-9._@/-]+)\s*:\s*(?:#.*)?$/.exec(trimmed);
    if (keyMatch !== null && indent === blockIndent + 2 && current === null) {
      current = { provider: null, model: keyMatch[1] };
    }
  }
  flush();
  return policies;
}

/**
 * 0.4 P2-3：按路由取生效的 compaction-basic 策略（全局值 + 精确 provider/model 覆盖）。
 * @param {{thresholdRatio:number, headroomTokens:number, modelPolicies?:Array}} nativeCfg readNativeCompaction() 结果
 * @param {{provider:string, model:string}|null} route
 * @returns {{thresholdRatio:number, headroomTokens:number, overridden:boolean}}
 */
export function resolveNativePolicy(nativeCfg, route) {
  const globalRatio = Number.isFinite(nativeCfg?.thresholdRatio) ? nativeCfg.thresholdRatio : NATIVE_DEFAULTS.thresholdRatio;
  const globalHeadroom = Number.isFinite(nativeCfg?.headroomTokens) ? nativeCfg.headroomTokens : NATIVE_HEADROOM_DEFAULT;
  // 0.5.1 批 2：保留尾部预算（不配置 = undefined，由 core/native-line 按宿主默认比值算）。
  const globalRetain = {
    ...(Number.isFinite(nativeCfg?.retainRatio) ? { retainRatio: nativeCfg.retainRatio } : {}),
    ...(Number.isInteger(nativeCfg?.retainTokens) ? { retainTokens: nativeCfg.retainTokens } : {}),
  };
  if (route === null || route === undefined || typeof route.provider !== 'string' || typeof route.model !== 'string') {
    return { thresholdRatio: globalRatio, headroomTokens: globalHeadroom, overridden: false, ...globalRetain };
  }
  const list = Array.isArray(nativeCfg?.modelPolicies) ? nativeCfg.modelPolicies : [];
  const hit = list.find(
    (policy) =>
      policy !== null &&
      typeof policy === 'object' &&
      (policy.model === route.model || policy.model === `${route.provider}/${route.model}` || policy.model === null || policy.model === undefined) &&
      (policy.provider === undefined || policy.provider === null || policy.provider === route.provider),
  );
  if (hit === undefined) return { thresholdRatio: globalRatio, headroomTokens: globalHeadroom, overridden: false, ...globalRetain };
  const routeRetain = {
    ...(Number.isFinite(hit.retainRatio) ? { retainRatio: hit.retainRatio } : {}),
    ...(Number.isInteger(hit.retainTokens) ? { retainTokens: hit.retainTokens } : {}),
  };
  return {
    thresholdRatio: Number.isFinite(hit.thresholdRatio) ? hit.thresholdRatio : globalRatio,
    headroomTokens: Number.isFinite(hit.headroomTokens) ? hit.headroomTokens : globalHeadroom,
    overridden: true,
    ...globalRetain,
    ...routeRetain,
  };
}

/**
 * 读当前生效的原生压缩配置（用户覆盖 + 默认值）。带 mtime 缓存，避免每帧 stat 读文件。
 *
 * 0.3.6（BUG-012）：`override` 只包含 config 直属子键（parse 的缩进作用域），
 * 嵌套 modelPolicies 里的 thresholdRatio 不再影响全局线。
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
    // 0.4 P2-3：真实触发线要用的余量与路由级覆盖（additive 字段，老调用方不受影响）。
    headroomTokens: override.headroomTokens ?? NATIVE_HEADROOM_DEFAULT,
    // 0.5.1 批 2：保留尾部预算（未配置时 undefined，由 nativeRetainTokensOf 按宿主默认比值算）。
    ...(override.retainRatio === undefined ? {} : { retainRatio: override.retainRatio }),
    ...(override.retainTokens === undefined ? {} : { retainTokens: override.retainTokens }),
    modelPolicies: parseModelPolicies(text),
    override,
    file,
  };
  cache.key = key;
  cache.value = value;
  return value;
}

/**
 * 把 compaction-basic 条目改成指定 auto 值；返回新文本。纯函数，便于单测。
 *
 * 写入口径与解析一致：只写 `config:` 的**直接子键**（不写进 modelPolicies 等嵌套层）：
 *   - 已有直属 `auto:` → 原地改值（保留缩进；行尾注释与旧实现一样会被丢弃）；
 *   - 没有直属 auto → 插到 config 直接子键区的第一行（缩进取已有子键缩进）；
 *   - 条目没有 config: → 补 `config:` + 直属 auto；
 *   - 没有 compaction-basic 条目 → 追加完整条目（与旧行为一致）。
 * CRLF 输入保持 CRLF。
 */
export function applyAutoOverride(text, enabled) {
  const source = typeof text === 'string' ? text : '';
  const { lines, eol } = splitText(source);
  const flag = enabled ? 'true' : 'false';
  const entry = locateEntry(lines);

  if (entry === null) {
    const base = source.length === 0 || /(?:\r?\n)$/.test(source) ? source : `${source}${eol}`;
    const timestamp = new Date().toISOString().slice(0, 10);
    return (
      `${base}# 由 dsh-compact-relay 追加（${timestamp}）：${enabled ? '恢复' : '关闭'} DSH 原生自动压缩（重启 DSH 生效）${eol}` +
      `- id: ${NATIVE_PLUGIN_ID}${eol}` +
      `  name: '${NATIVE_PLUGIN_NAME}'${eol}` +
      `  config:${eol}` +
      `    auto: ${flag}${eol}`
    );
  }

  const config = locateConfig(lines, entry);
  if (config !== null) {
    const autoIndex = findDirectChild(lines, entry, config, AUTO_RE);
    if (autoIndex >= 0) {
      lines[autoIndex] = `${' '.repeat(config.childIndent)}auto: ${flag}`;
    } else {
      const childIndent = config.childIndent === null ? config.configIndent + 2 : config.childIndent;
      lines.splice(config.configIndex + 1, 0, `${' '.repeat(childIndent)}auto: ${flag}`);
    }
    return lines.join(eol);
  }

  // 条目存在但没有 config:：补一个，auto 写在 config 的直接子键处（与解析口径一致）。
  const configIndent = entry.indent + 2;
  lines.splice(
    entry.start + 1,
    0,
    `${' '.repeat(configIndent)}config:`,
    `${' '.repeat(configIndent + 2)}auto: ${flag}`,
  );
  return lines.join(eol);
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
