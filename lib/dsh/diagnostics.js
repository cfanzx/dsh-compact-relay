/**
 * 诊断包构造函数（dcr 0.4 P0-2）—— 纯函数、零 IO、零网络。
 *
 * 设计红线（方案 §2）：
 *   1. **allowlist 序列化**：只从已知字段逐项 pick，禁止整对象展开/整对象序列化扩散；
 *   2. 产物只含「数值 / 枚举 / 布尔 / 错误码」：不带消息、摘要、交接单正文、工具参数、
 *      路径、用户名、hostname、cwd、sessionId、密钥、cookie；
 *   3. 本机生成：Markdown/JSON 由宿主进程构造，客户端只展示/复制；
 *   4. 不引入依赖、不发起任何网络请求（本文件内不出现任何网络 API 的名字）。
 *
 * 数据流：buildDiagnostics(input) → allowlist 对象 → JSON 文本清洗 → 截断 →
 * 同源渲染 Markdown → Markdown 文本清洗 → `{json, markdown}`。
 * 三道清洗里只有「正则兜底」会改内容，且只把命中串替换成 `[REDACTED]`、只把数量写进
 * `json.redactions`（可选字段，不保留原文）。
 */
import { clipCodeUnits } from '../core/clip.js';
import { localIso } from './diag-counters.js';

/** 产物 schema 版本（客户端/issue 模板以此识别格式）。 */
export const DIAG_SCHEMA = 'dcr-diagnostics/v1';

/** JSON 产物硬上限（方案 A7：≤ 64KB）。 */
export const JSON_BYTE_LIMIT = 64 * 1024;

/** 错误条目上限与单条长度上限（方案 A7）。 */
const ERROR_ENTRY_LIMIT = 20;
const ERROR_ENTRY_MAX_CHARS = 200;
const ERROR_CODE_MAX_CHARS = 60;
const ERROR_PHASE_MAX_CHARS = 20;

/** GitHub issue 报告页（只预填短字段，绝不把 Markdown 塞进 URL）。 */
const ISSUE_URL_BASE = 'https://github.com/cfanzx/dsh-compact-relay/issues/new';
/** issue URL 长度上限（方案 A3：< 7500）。 */
export const ISSUE_URL_LIMIT = 7500;

const PLUGIN_NAME = 'dsh-compact-relay';

/**
 * 敏感串检测集（方案 §8）。`label` 只用于测试/计数，**不会**把命中的原文带出去。
 * 顺序从具体到宽泛，避免同一条串被多个模式重复计数。
 */
const LEAK_PATTERNS = Object.freeze([
  Object.freeze({ label: 'github-pat', pattern: /github_pat_[A-Za-z0-9_]{10,}/gu }),
  Object.freeze({ label: 'github-token', pattern: /ghp_[A-Za-z0-9]{10,}/gu }),
  Object.freeze({ label: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{10,}/gu }),
  Object.freeze({ label: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/gu }),
  Object.freeze({ label: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{20,}/gu }),
  Object.freeze({ label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/gu }),
  Object.freeze({ label: 'authorization-header', pattern: /\bauthorization\s*:\s*[^\r\n]{4,}/giu }),
  Object.freeze({ label: 'bearer-token', pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/giu }),
  Object.freeze({ label: 'cookie', pattern: /\bcookie\s*[:=]\s*[^\s;,]{3,}/giu }),
  Object.freeze({ label: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu }),
  Object.freeze({ label: 'unix-abs-path', pattern: /(?<![\w.-])\/(?:Users|home|root|private|var|opt|etc|tmp)\/[^\s"'`]+/gu }),
  Object.freeze({ label: 'windows-abs-path', pattern: /\b[A-Za-z]:\\[^\s"'`<>|]*/gu }),
  Object.freeze({
    label: 'private-ip',
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/gu,
  }),
  Object.freeze({ label: 'session-id', pattern: /\bsession-[0-9a-z]{8,}\b/gu }),
]);

/** `[REDACTED]` 占位符（测试断言用同一份常量，避免手写两处不一致）。 */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** 单行化 + 截断；非字符串 / 空串 → null（`undefined` 一律归一为 null）。 */
function pickText(value, maxChars) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/gu, ' ').trim();
  if (trimmed.length === 0) return null;
  // 0.5.1 D03：截断收口到 core/clip（码元口径，行为不变）。
  return clipCodeUnits(trimmed, maxChars);
}

function pickInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function pickMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function pickRatio(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 1000) / 1000;
}

function pickBool(value) {
  return typeof value === 'boolean' ? value : null;
}

/* ------------------------------------------------------------------ *
 * 各数据块：逐字段 allowlist（未知字段一律不读、不透传）
 * ------------------------------------------------------------------ */

function pickRuntime(runtime) {
  const source = isObject(runtime) ? runtime : {};
  return {
    dshVersion: pickText(source.dshVersion, 80),
    node: pickText(source.node, 40),
    platform: pickText(source.platform, 40),
    arch: pickText(source.arch, 40),
    osRelease: pickText(source.osRelease, 80),
    locale: pickText(source.locale, 40),
  };
}

function pickConfig(config) {
  const source = isObject(config) ? config : {};
  const thresholds = isObject(source.thresholds) ? source.thresholds : {};
  const retention = isObject(source.retention) ? source.retention : {};
  const timeouts = isObject(source.timeouts) ? source.timeouts : {};
  const colors = isObject(source.colors) ? source.colors : {};
  return {
    thresholds: {
      compactRatio: pickRatio(thresholds.compactRatio),
      handoffRatio: pickRatio(thresholds.handoffRatio),
      maxSummaries: pickInt(thresholds.maxSummaries),
    },
    retention: { recentTailTokens: pickInt(retention.recentTailTokens) },
    timeouts: {
      compactMs: pickMs(timeouts.compactMs),
      handoffMs: pickMs(timeouts.handoffMs),
    },
    colors: { mode: pickText(colors.mode, 20), autoAdapt: pickBool(colors.autoAdapt) },
    handoffDirCustomized: pickBool(source.handoffDirCustomized),
    linksCustomized: pickBool(source.linksCustomized),
  };
}

function pickState(state) {
  if (!isObject(state)) return null;
  const range = isObject(state.compactRange) ? state.compactRange : null;
  const nativeAuto = isObject(state.nativeAuto) ? state.nativeAuto : null;
  return {
    window: pickInt(state.window),
    tokens: pickInt(state.tokens),
    ratio: pickRatio(state.ratio),
    summaries: pickInt(state.summaries),
    pins: pickInt(state.pins),
    advice: pickText(state.advice, 20),
    compactRange:
      range === null ? null : { nodes: pickInt(range.nodes), tokens: pickInt(range.tokens) },
    nativeAuto:
      nativeAuto === null ? null : { enabled: pickBool(nativeAuto.enabled), lineRatio: pickRatio(nativeAuto.lineRatio) },
  };
}

function pickCounters(counters) {
  const source = isObject(counters) ? counters : {};
  return {
    compactOk: pickInt(source.compactOk) ?? 0,
    compactFail: pickInt(source.compactFail) ?? 0,
    handoffOk: pickInt(source.handoffOk) ?? 0,
    handoffFail: pickInt(source.handoffFail) ?? 0,
    pins: pickInt(source.pins) ?? 0,
    // 0.4 P0-1：判断机制计量（cue 注入 / mark 调用 / 接受 / 拒绝）。
    cueInjected: pickInt(source.cueInjected) ?? 0,
    markCalls: pickInt(source.markCalls) ?? 0,
    markAccepted: pickInt(source.markAccepted) ?? 0,
    markRejected: pickInt(source.markRejected) ?? 0,
  };
}

function emptyLatency() {
  return { n: 0, p50: null, p95: null };
}

function pickLatencyEntry(entry) {
  const source = isObject(entry) ? entry : {};
  const n = pickInt(source.n) ?? 0;
  if (n === 0) return emptyLatency();
  return { n, p50: pickMs(source.p50), p95: pickMs(source.p95) };
}

function pickLatency(latency) {
  const source = isObject(latency) ? latency : {};
  return { compact: pickLatencyEntry(source.compact), handoff: pickLatencyEntry(source.handoff) };
}

/** 单条错误码 entry 的序列化长度压到 ≤ 200 字符（方案 A7）。 */
function fitErrorEntry(entry) {
  let picked = entry;
  while (JSON.stringify(picked).length > ERROR_ENTRY_MAX_CHARS && picked.code.length > 0) {
    picked = { ...picked, code: picked.code.slice(0, Math.max(0, picked.code.length - 10)) };
  }
  return picked;
}

function pickErrors(errors) {
  if (!Array.isArray(errors)) return [];
  const out = [];
  for (const entry of errors) {
    if (out.length >= ERROR_ENTRY_LIMIT) break;
    if (!isObject(entry)) continue;
    out.push(
      fitErrorEntry({
        code: pickText(entry.code, ERROR_CODE_MAX_CHARS) ?? 'error',
        phase: pickText(entry.phase, ERROR_PHASE_MAX_CHARS) ?? 'unknown',
        at: pickText(entry.at, 40),
        count: pickInt(entry.count) ?? 1,
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 清洗：检测 / 替换（只出数量，不出原文）
 * ------------------------------------------------------------------ */

/**
 * 扫描文本里的疑似敏感串。
 * @param {string} text
 * @returns {string[]} 命中的模式 label（去重；**不返回命中的原文**）
 */
function scanLeakLabels(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  for (const { label, pattern } of LEAK_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text) && !hits.includes(label)) hits.push(label);
  }
  return hits;
}

/**
 * 把文本里命中的疑似敏感串替换成 `[REDACTED]`。
 * @param {string} text
 * @returns {{text:string, count:number}}
 */
function redactText(text) {
  let out = text;
  let count = 0;
  for (const { pattern } of LEAK_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => {
      count += 1;
      return REDACTION_PLACEHOLDER;
    });
  }
  return { text: out, count };
}

/**
 * 对 allowlist 对象里的每个字符串值做清洗（JSON 结构安全）。
 *
 * 为什么不直接在 `JSON.stringify` 之后替换：有些检测模式会跨 JSON 语法（例如
 * `authorization: <直到行尾>`），文本级替换可能破坏 JSON、甚至把后续字段整段吞掉。
 * 逐字段清洗后重新序列化，既保证产物不含命中串，也不会产生解析失败。
 * @returns {{value:*, count:number}}
 */
function redactDeep(value) {
  if (typeof value === 'string') {
    const cleaned = redactText(value);
    return { value: cleaned.text, count: cleaned.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = [];

    for (const item of value) {
      const cleaned = redactDeep(item);
      count += cleaned.count;
      out.push(cleaned.value);
    }
    return { value: out, count };
  }
  if (isObject(value)) {
    let count = 0;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const cleaned = redactDeep(item);
      count += cleaned.count;
      out[key] = cleaned.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

/**
 * 单测用：断言一段文本里没有敏感串（生产路径不抛，只清洗 + 计数）。
 * @param {string} text
 * @param {string[]} [extraDeny] 额外禁止出现的字面串（例如测试里的「聊天原文」fixture）
 * @returns {{ok:boolean, hits:string[]}}
 */
export function assertNoLeak(text, extraDeny = []) {
  const hits = scanLeakLabels(typeof text === 'string' ? text : '');
  if (Array.isArray(extraDeny)) {
    extraDeny.forEach((item, index) => {
      if (typeof item === 'string' && item.length > 0 && typeof text === 'string' && text.includes(item)) {
        hits.push(`custom#${index}`);
      }
    });
  }
  return { ok: hits.length === 0, hits };
}

/* ------------------------------------------------------------------ *
 * 尺寸保护
 * ------------------------------------------------------------------ */

function byteLengthOfJson(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function diagnosticsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * JSON ≤ 64KB 的硬截断：先砍半错误码，再清空错误码 + 耗时归零，仍超则报错（由 HTTP 层回短文案）。
 * 正常产物 ~2KB，这两刀只是「手滑/异常输入」的兜底，属不可达分支的可测保护。
 */
function capToJsonLimit(json) {
  let candidate = json;
  if (byteLengthOfJson(candidate) <= JSON_BYTE_LIMIT) return candidate;
  candidate = { ...candidate, errors: candidate.errors.slice(0, Math.floor(candidate.errors.length / 2)) };
  if (byteLengthOfJson(candidate) <= JSON_BYTE_LIMIT) return candidate;
  candidate = { ...candidate, errors: [], latency: { compact: emptyLatency(), handoff: emptyLatency() } };
  if (byteLengthOfJson(candidate) <= JSON_BYTE_LIMIT) return candidate;
  throw diagnosticsError('toolarge', '诊断信息超过 64KB 上限，无法生成');
}

/* ------------------------------------------------------------------ *
 * Markdown 渲染（与 JSON 同源，人读版 2–4KB）
 * ------------------------------------------------------------------ */

const DASH = '—';

function groupDigits(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

function intText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? groupDigits(Math.round(value)) : DASH;
}

function percentText(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return DASH;
  return `${(ratio * 100).toFixed(1).replace(/\.0$/u, '')}%`;
}

function boolText(value, trueText, falseText) {
  if (value === true) return trueText;
  if (value === false) return falseText;
  return DASH;
}

function osLabel(runtime) {
  const platform = runtime.platform;
  const name =
    platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform ?? '未知系统';
  return runtime.osRelease === null ? `${name} ${DASH}` : `${name} ${runtime.osRelease}`;
}

function generatedAtText(generatedAt) {
  if (typeof generatedAt !== 'string' || generatedAt.length < 19) return DASH;
  return generatedAt.slice(0, 19).replace('T', ' ');
}

function nativeAutoText(state) {
  if (state === null || state.nativeAuto === null) return `原生自动压缩：${DASH}（无活动会话）`;
  const enabled = state.nativeAuto.enabled === true ? '开' : state.nativeAuto.enabled === false ? '关' : DASH;
  return `原生自动压缩：${enabled}（线 ${percentText(state.nativeAuto.lineRatio)}）`;
}

/** 渲染人读 Markdown；输入是已清洗的 json 对象（同源，不二次取数）。 */
function renderMarkdown(json) {
  const { plugin, runtime, config, state, counters, latency, errors } = json;
  const lines = [];
  lines.push(`### ${PLUGIN_NAME} 诊断信息（${json.schema}）`);
  lines.push(`生成时间：${generatedAtText(json.generatedAt)}`);
  lines.push('');
  lines.push(`**版本**：${PLUGIN_NAME} ${plugin.version ?? DASH} · DSH ${runtime.dshVersion ?? DASH} ·`);
  lines.push(
    `**环境**：${runtime.platform ?? DASH} ${runtime.arch ?? DASH} · ${osLabel(runtime)} · Node ${runtime.node ?? DASH} · locale ${runtime.locale ?? DASH}`,
  );
  lines.push('');
  lines.push('**配置**');
  lines.push(
    `- 压缩线 ${percentText(config.thresholds.compactRatio)} / 交接线 ${percentText(config.thresholds.handoffRatio)} / 最多摘要 ${intText(config.thresholds.maxSummaries)}`,
  );
  lines.push(
    `- 保留尾巴 ${intText(config.retention.recentTailTokens)} tokens · 颜色模式 ${config.colors.mode ?? DASH}（自适应${boolText(config.colors.autoAdapt, '开', '关')}）`,
  );
  lines.push(
    `- ${nativeAutoText(state)} · 交接目录${boolText(config.handoffDirCustomized, '已自定义', '默认')} · 自定义链接${boolText(config.linksCustomized, '已改', '未改')}`,
  );
  if (typeof json.redactions === 'number' && json.redactions > 0) {
    lines.push(`- 脱敏：已替换 ${intText(json.redactions)} 处疑似敏感串（不保留原文）`);
  }
  lines.push('');
  if (state === null) {
    lines.push('**当前状态**（无活动会话）');
  } else {
    lines.push('**当前状态**');
    lines.push(
      `- 窗口 ${intText(state.window)} · 已用 ${intText(state.tokens)}（${percentText(state.ratio)}）· 摘要 ${intText(state.summaries)} · 锁定 ${intText(state.pins)}`,
    );
    const rangeText =
      state.compactRange === null
        ? '暂无可压范围'
        : `可压范围 ${intText(state.compactRange.nodes)} 条 / ${intText(state.compactRange.tokens)} tokens`;
    lines.push(`- 建议 ${state.advice ?? DASH} · ${rangeText}`);
  }
  lines.push('');
  lines.push('**计数（本次加载后累计）**');
  lines.push(
    `- 压缩 ${intText(counters.compactOk)} 成功 / ${intText(counters.compactFail)} 失败 · 交接 ${intText(counters.handoffOk)} 成功 / ${intText(counters.handoffFail)} 失败 · 锁定 ${intText(counters.pins)}`,
  );
  lines.push(
    `- cue 注入 ${intText(counters.cueInjected)} · mark 调用 ${intText(counters.markCalls)}（接受 ${intText(counters.markAccepted)} / 拒绝 ${intText(counters.markRejected)}）`,
  );
  const latencyText = (label, entry) =>
    entry.n === 0
      ? `${label} n=0`
      : `${label} n=${intText(entry.n)}（p50 ${intText(entry.p50)}ms / p95 ${intText(entry.p95)}ms）`;
  lines.push(`- 耗时：${latencyText('压缩', latency.compact)} · ${latencyText('交接', latency.handoff)}`);
  lines.push('');
  lines.push(`**错误码**（最多 ${ERROR_ENTRY_LIMIT} 条）`);
  if (errors.length === 0) {
    lines.push('- （无）');
  } else {
    for (const entry of errors) {
      const line = `- ${entry.code} · ${entry.phase} · ${entry.at ?? DASH} ×${intText(entry.count)}`;
      lines.push(line.length > ERROR_ENTRY_MAX_CHARS ? `${line.slice(0, ERROR_ENTRY_MAX_CHARS - 1)}…` : line);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 公开 API
 * ------------------------------------------------------------------ */

/**
 * 构造诊断包。
 *
 * @param {object} [input]
 * @param {string} [input.version] 插件版本（settings.view().version）
 * @param {object} [input.runtime] {dshVersion,node,platform,arch,osRelease,locale}
 * @param {object} [input.config] {thresholds,retention,timeouts,colors,handoffDirCustomized,linksCustomized}
 * @param {object|null} [input.state] 无活动会话传 null
 * @param {object} [input.counters] diag-counters.snapshot().counters
 * @param {object} [input.latency] diag-counters.snapshot().latency
 * @param {Array} [input.errors] diag-counters.snapshot().errors（≤20 条）
 * @param {Date|number|string} [input.now] 仅测试注入固定时间；运行时省略
 * @returns {{json:object, markdown:string}}
 */
export function buildDiagnostics(input = {}) {
  const source = isObject(input) ? input : {};
  const raw = {
    schema: DIAG_SCHEMA,
    generatedAt: localIso(toDate(source.now)),
    plugin: {
      name: PLUGIN_NAME,
      version: pickText(source.version, 40),
    },
    runtime: pickRuntime(source.runtime),
    config: pickConfig(source.config),
    state: pickState(source.state),
    counters: pickCounters(source.counters),
    latency: pickLatency(source.latency),
    errors: pickErrors(source.errors),
  };

  // 第二道防线：allowlist 之后仍对产物里的字符串值逐字段清洗（防后续手滑加字段），
  // 并把命中数量写进 `json.redactions`（只出数量、不出原文）。
  const jsonRedaction = redactDeep(raw);
  let json = capToJsonLimit(jsonRedaction.value);

  // Markdown 与 JSON 同源；再对 Markdown 文本跑一遍检测（理论上 0，防御渲染拼接）。
  let markdown = renderMarkdown(json);
  const markdownRedaction = redactText(markdown);
  markdown = markdownRedaction.text;
  const redactions = jsonRedaction.count + markdownRedaction.count;
  if (redactions > 0) {
    json = capToJsonLimit({ ...json, redactions });
    markdown = renderMarkdown(json);
  }

  return { json, markdown };
}

/**
 * 生成 GitHub issue 预填 URL —— 只带短字段（版本 / 平台 / DSH 版本），绝不带 Markdown。
 *
 * 参数只允许 `version` 与 `runtime.platform/osRelease/dshVersion`；传进来的其它东西一律无视。
 * @param {{version?:string, runtime?:object}} [input]
 * @returns {string} 长度 < ISSUE_URL_LIMIT（7500）
 */
export function renderIssueUrl({ version, runtime } = {}) {
  const pluginVersion = pickText(version, 40) ?? 'unknown';
  const source = isObject(runtime) ? runtime : {};
  const dshVersion = pickText(source.dshVersion, 80);
  const platform = pickText(source.platform, 40);
  const osRelease = pickText(source.osRelease, 80);
  const platformText = [dshVersion === null ? 'DSH 版本未知' : `DSH ${dshVersion}`, [platform, osRelease].filter((part) => part !== null).join(' ')]
    .filter((part) => part.length > 0)
    .join(' / ');
  const params = new URLSearchParams({
    template: 'bug_report.yml',
    title: `[bug] ${PLUGIN_NAME} ${pluginVersion} 诊断`,
    'dcr-version': pluginVersion,
    'dsh-version': platformText,
  });
  const url = `${ISSUE_URL_BASE}?${params.toString()}`;
  return url.length < ISSUE_URL_LIMIT ? url : url.slice(0, ISSUE_URL_LIMIT - 1);
}
