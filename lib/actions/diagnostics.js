/**
 * 诊断信息动作（dcr 0.4 P0-2）—— HTTP 适配层与（将来的）命令入口共用的唯一组装实现。
 *
 * 为什么放在 actions 层：仓库 A9 架构红线是「adapters 不能直接 import dsh/」，
 * 而诊断产物的构造（白名单裁剪 + 脱敏 + 尺寸上限）在 dsh/diagnostics.js。
 * 这里只做「取数 + 裁剪」：deps.cfg / settings.view() / readState / deps.diag.snapshot()，
 * 然后把白名单输入交给 dsh 层构造，适配层只负责协议转换。
 *
 * 只读、幂等、无副作用：不写文件、不写日志、不改任何插件状态。
 */
import os from 'node:os';
import { buildDiagnostics, renderIssueUrl } from '../dsh/diagnostics.js';
import { readState } from './state.js';

/** 运行时环境事实（只取进程/系统信息，不读会话、不读路径）。 */
function runtimeOf() {
  let osRelease = null;
  try {
    if (typeof os.release === 'function') osRelease = os.release();
  } catch {
    osRelease = null;
  }
  let locale = null;
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    locale = null;
  }
  return {
    // 现有代码没有稳定的 DSH 版本来源：不猜，保持 null（方案 §4）。
    dshVersion: null,
    node: typeof process.version === 'string' ? process.version : null,
    platform: typeof process.platform === 'string' ? process.platform : null,
    arch: typeof process.arch === 'string' ? process.arch : null,
    osRelease,
    locale,
  };
}

/**
 * 配置白名单：阈值/保留量/超时/颜色 + 两个「是否被用户改过」的布尔。
 * 交接目录与自定义链接**只出改没改，绝不出值**（方案 §2）。
 */
function configOf(deps) {
  const cfg = deps.cfg !== null && typeof deps.cfg === 'object' ? deps.cfg : {};
  let view = null;
  try {
    view = typeof deps.settings?.view === 'function' ? deps.settings.view() : null;
  } catch {
    view = null;
  }
  const current = view !== null && view.config !== null && typeof view.config === 'object' ? view.config : null;
  const defaults = view !== null && view.defaults !== null && typeof view.defaults === 'object' ? view.defaults : null;
  const changed = (read) => (current === null || defaults === null ? false : read(current) !== read(defaults));
  const timeouts = cfg.timeouts !== null && typeof cfg.timeouts === 'object' ? cfg.timeouts : {};
  return {
    version: view !== null && typeof view.version === 'string' ? view.version : null,
    config: {
      thresholds: {
        compactRatio: cfg.thresholds?.compactRatio,
        handoffRatio: cfg.thresholds?.handoffRatio,
        maxSummaries: cfg.thresholds?.maxSummaries,
      },
      retention: { recentTailTokens: cfg.retention?.recentTailTokens },
      // 仓库只有一个模型调用超时（llmMs）；契约的分项字段没有独立来源时复用它。
      timeouts: {
        compactMs: timeouts.compactMs ?? timeouts.llmMs,
        handoffMs: timeouts.handoffMs ?? timeouts.llmMs,
      },
      colors: { mode: cfg.colors?.mode, autoAdapt: cfg.colors?.autoAdapt },
      handoffDirCustomized: changed((value) => value.handoffDir),
      linksCustomized: changed((value) => `${value.links?.tutorial ?? ''}\u0000${value.links?.feedback ?? ''}`),
    },
  };
}

/** 把 readState 快照裁成契约白名单；无活动会话返回 null（契约里 state 整块 null）。 */
function stateOf(state) {
  if (state === null || typeof state !== 'object' || typeof state.sessionId !== 'string') return null;
  const range = state.compactRange !== null && typeof state.compactRange === 'object' ? state.compactRange : null;
  const native = state.native !== null && typeof state.native === 'object' ? state.native : null;
  return {
    window: state.window,
    tokens: state.pressure,
    ratio: state.ratio,
    summaries: state.summaries,
    pins: state.pins !== null && typeof state.pins === 'object' ? state.pins.count : state.pins,
    advice: state.advice,
    compactRange: range === null ? null : { nodes: range.nodes, tokens: range.tokens },
    nativeAuto: native === null ? null : { enabled: native.autoEnabled, lineRatio: native.thresholdRatio },
  };
}

/**
 * 组装一份诊断信息（HTTP 端点 / 未来命令入口共用）。
 *
 * @param {{ctx:object, cfg:object, settings?:object, diag?:object}} deps
 * @param {{sessionId?:string}} [input]
 * @returns {Promise<{schema:string, version:string|null, generatedAt:string, markdown:string, json:object, issueUrl:string}>}
 */
export async function readDiagnostics(deps, { sessionId } = {}) {
  const meta = configOf(deps);
  const runtime = runtimeOf();
  // 无活动会话时 readState 仍返回合法对象（sessionId=null）→ 契约里 state 整块 null。
  let state = null;
  try {
    state = stateOf(await readState(deps, { sessionId }));
  } catch {
    state = null;
  }
  const snapshot = deps.diag?.snapshot?.() ?? {};
  const built = buildDiagnostics({
    version: meta.version,
    runtime,
    config: meta.config,
    state,
    counters: snapshot.counters,
    latency: snapshot.latency,
    errors: snapshot.errors,
  });
  return {
    schema: built.json.schema,
    version: meta.version,
    generatedAt: built.json.generatedAt,
    markdown: built.markdown,
    json: built.json,
    // issue URL 由宿主拼（短字段），客户端只负责 window.open。
    issueUrl: renderIssueUrl({ version: meta.version, runtime }),
  };
}
