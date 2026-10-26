/**
 * 会话创建接缝 —— M3 交接新会话的内核。
 *
 * 照 DSH 0.2 的官方创建路径（@deepseek-ai/dsh-api-session-controller 的
 * composeAgent + createAgent + workspace.attachSession）复刻，只用公共服务：
 *
 *   ctx.agents.create({ sessionId, agentOptions, meta, setup })
 *     → 会话与 agent 一起建（避免客户端打开时撞 resume / live 冲突）
 *   ctx.get('workspaceRegistry').create(cwd) → workspace.attachSession(childId)
 *     → 新会话落进同一工作区，而不是「未分组」直到重启
 *   ctx.sessionTitle.rename(childSession, title)  → 可辨识标题
 *   childAgent.followup(交接单)  → 消息成为新会话第一条消息并启动 turn
 *     （DSH 0.2 里没有 turn/start 的会话在界面上是「空白 Hero」，不会显示
 *       历史；followup 让交接内容真的显示出来。失败则退回纯 append。）
 *   childSession 写 relay 记录  → 子会话自带链号（ordinal/baseTitle/scheme/titleSeq）
 *     （0.5.0 旧会话改名「历史 N」后子会话标题不再带序号，链号不能再靠标题解析）
 *
 * 全部失败点都做「能降级就降级、不能降级就带 childId 报错」，绝不静默。
 */
import { randomUUID } from 'node:crypto';
import { actionError } from '../core/errors.js';
import {
  MAX_TITLE_BYTES,
  historyTitleOf,
  relayTitleOf,
  splitHandoffTitle,
  truncateTitleUtf8,
} from '../core/relay.js';
import { HANDOFF_PREAMBLE } from '../core/prompts.js';
import { localIso } from './diag-counters.js';
import { cacheControls, routeOf } from './route.js';
import { relayRecordOf, writeRelayRecord } from './relay.js';

/** 插件在消息 source 上的标识。 */
export const PLUGIN_NAME = 'compact-relay';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 标题比较用的宿主口径折叠（连续空白 → 单空格 + trim）。 */
function sameNormalizedTitle(left, right) {
  return left.replace(/\s+/gu, ' ').trim() === right.replace(/\s+/gu, ' ').trim();
}

/**
 * 读原会话的 agent preset id（0.2 里优先会话头，其次 projection）。
 * @param {object} ctx
 * @param {object} session
 * @returns {string|undefined}
 */
export function presetIdOf(ctx, session) {
  // 先读 projection：header.agentPreset 是创建时元数据（不可变），
  // 用户中途切换 preset 后只有 projection（agent-preset/selected 事件）是当前值。
  // 2026-10-19 debug：旧顺序会让交接子会话继续挂旧 preset。
  try {
    const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined;
    const value = projections?.stateOf?.(session, 'agentPreset');
    if (typeof value === 'string' && value.length > 0) return value;
  } catch {
    /* projection 拿不到就退回 header */
  }
  const fromHeader = session?.header?.agentPreset;
  return typeof fromHeader === 'string' && fromHeader.length > 0 ? fromHeader : undefined;
}

/**
 * 原会话标题（没有返回 undefined）。
 * @param {object} ctx
 * @param {object} session
 * @returns {string|undefined}
 */
export function sourceTitleOf(ctx, session) {
  try {
    const titles = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined;
    const snapshot = titles?.get?.(session);
    if (typeof snapshot?.title === 'string' && snapshot.title.trim().length > 0) return snapshot.title.trim();
  } catch {
    /* 标题服务不可用就退回默认标题 */
  }
  return undefined;
}

/**
 * 按 scheme 组装标题计划（纯函数，不读 ctx）。
 *
 * - `handoff-n`（旧链）：保持「交接第 N 次：<原名>」原样，旧链一个字符不改；
 * - `history-n`（0.5.0 新链）：新会话继承干净原名，旧会话由调用方改名「历史 N：<原名>」。
 *   两个标题都按 `MAX_TITLE_BYTES` 先缩 base（前缀计入预算），避免宿主截断吃掉前缀。
 * @param {'handoff-n'|'history-n'} scheme
 * @param {number} index
 * @param {string} baseTitle
 * @param {boolean} viaRecord
 * @returns {{index:number, baseTitle:string, title:string, historyTitle:string|null, scheme:'handoff-n'|'history-n', viaRecord:boolean}}
 */
function titlePlanOf(scheme, index, baseTitle, viaRecord) {
  if (scheme === 'handoff-n') {
    return {
      index,
      baseTitle,
      title: relayTitleOf(index, baseTitle),
      historyTitle: null,
      scheme,
      viaRecord,
    };
  }
  const base = typeof baseTitle === 'string' && baseTitle.trim().length > 0 ? baseTitle.trim() : '会话';
  const fitted = truncateTitleUtf8(base, MAX_TITLE_BYTES).trimEnd() || '会话';
  return {
    index,
    baseTitle: base,
    // 新会话标题 = 原名（不带序号）；旧会话标题 = 历史 N：原名。
    title: fitted,
    historyTitle: historyTitleOf(index, base, MAX_TITLE_BYTES),
    scheme,
    viaRecord,
  };
}

/**
 * 下一次交接的标题计划：序号 + 原始标题 + 本次链用哪种命名方案。
 *
 * 序号优先读会话自己的 relay 记录（结构化数据，不依赖标题文案；新链子会话标题
 * 继承原名后标题里已没有链号）。没有记录才回退标题解析：
 *   - `历史 N：` → 继续新链（record 丢失时靠标题兜底）；
 *   - `交接第 N 次：` / 旧「交接：」「接棒：」堆叠 → 旧链，保持旧命名（链级 cutover）；
 *   - 干净标题（无前缀）→ 新链，本次为第 1 次；
 *   - 标题读不到 → 保守按旧链处理（不生成可能与旧链混合的新标题）。
 *
 * 记录存在时方案以记录为准（`scheme='history-n'` 才走新链；0.3/0.4 旧记录
 * scheme 为 null → 旧链，不迁移）。
 * @param {object} ctx
 * @param {object} session
 * @returns {{index:number, baseTitle:string, title:string, historyTitle:string|null, scheme:'handoff-n'|'history-n', viaRecord:boolean}}
 */
export function handoffTitlePlanOf(ctx, session) {
  const currentTitle = sourceTitleOf(ctx, session);
  const split = splitHandoffTitle(currentTitle);
  const record = relayRecordOf(session);
  if (record !== null) {
    const baseTitle = typeof record.baseTitle === 'string' && record.baseTitle.length > 0 ? record.baseTitle : split.baseTitle;
    const index = (Number.isInteger(record.ordinal) ? record.ordinal : record.index) + 1;
    const scheme = record.scheme === 'history-n' ? 'history-n' : 'handoff-n';
    return titlePlanOf(scheme, index, baseTitle, true);
  }
  const index = split.handedOff + 1;
  const scheme =
    currentTitle === undefined
      ? 'handoff-n'
      : split.scheme === 'history-n' || (split.scheme === 'legacy' && split.handedOff === 0)
        ? 'history-n'
        : 'handoff-n';
  return titlePlanOf(scheme, index, split.baseTitle, false);
}

/**
 * 给新会话起可辨识的标题。
 * - 旧链：交接第 N 次：<原题>；
 * - 新链（0.5.0 命名反转）：直接继承干净原名。
 * 具体序号/原题由 handoffTitlePlanOf 决定（优先 relay 记录，其次标题解析）。
 * @param {object} ctx
 * @param {object} session
 * @returns {string}
 */
export function childTitleOf(ctx, session) {
  return handoffTitlePlanOf(ctx, session).title;
}

/**
 * 0.5.0 命名反转：把旧会话改名「历史 N：<原名>」。
 *
 * 只在 scheme='history-n' 的**新链**上执行；旧链（handoff-n）原样返回，一个字符不改
 * （链级 cutover）。调用方必须在子会话建好之后调用：改名是可见副作用，任何失败都只
 * warn、不阻断交接（子会话已经可用）。
 *
 * 幂等 guard：当前标题已经是本次目标（或宿主按更小预算截断后的同一前缀）时跳过，
 * 同一链重复执行不会重复 append rename，也不会叠成「历史 2：历史 1：X」。
 *
 * 改名成功后 `await ctx.sessions.flush(session)` 收窄持久化窗口（宿主 rename 是同步写日志，
 * flush 失败也只 warn）。
 *
 * @param {object} ctx
 * @param {object} session 旧会话（rename 要求 live；手动 /handoff 时它正是当前会话）
 * @param {{index:number, baseTitle:string, scheme?:'handoff-n'|'history-n', maxBytes?:number, log?:{warn?:Function}}} input
 * @returns {Promise<{renamed:boolean, title:string|null, titleSeq:number|null, reason:'old-chain'|'unavailable'|'already'|'failed'|null}>}
 */
export async function renameHistoryOf(
  ctx,
  session,
  { index, baseTitle, scheme = 'history-n', maxBytes = MAX_TITLE_BYTES, log } = {},
) {
  const result = { renamed: false, title: null, titleSeq: null, reason: null };
  if (scheme !== 'history-n') {
    result.reason = 'old-chain';
    return result;
  }

  const target = historyTitleOf(index, baseTitle, maxBytes);
  result.title = target;
  const sessionId = session?.id ?? '';

  let titles;
  try {
    titles = ctx?.get?.('sessionTitle');
  } catch {
    titles = undefined;
  }
  if (titles === undefined || titles === null || typeof titles.rename !== 'function') {
    result.reason = 'unavailable';
    log?.warn?.(
      `compact-relay: 旧会话 ${sessionId} 改名「${target}」失败：sessionTitle 服务不可用（交接已完成，标题保持原样）`,
    );
    return result;
  }

  // 幂等 guard：读得到当前标题时，已是本次目标就跳过（含宿主按更小预算截断的前缀）。
  // 按宿主 `session-title` 的口径折叠空白再比：宿主会把连续空白压成一个空格，
  // 不折叠的话同一目标会被误判成「还没改」而重复 append。
  try {
    const current = titles.get?.(session)?.title;
    if (typeof current === 'string' && current.length > 0) {
      const parsed = splitHandoffTitle(current);
      const sameHistory = parsed.scheme === 'history-n' && parsed.handedOff === index;
      if (sameNormalizedTitle(current, target) || (sameHistory && target.startsWith(current))) {
        result.reason = 'already';
        return result;
      }
    }
  } catch {
    /* 读不到当前标题就继续 rename（rename 自己会校验 live/空标题） */
  }

  let renamed;
  try {
    renamed = titles.rename(session, target);
  } catch (error) {
    result.reason = 'failed';
    log?.warn?.(
      `compact-relay: 旧会话 ${sessionId} 改名「${target}」失败：${errorMessage(error)}（交接已完成，标题保持原样）`,
    );
    return result;
  }

  // 与子会话 rename 一样：快照里的 eventSeq 是链记录要的序号，取不到就留 null（不猜）。
  if (Number.isInteger(renamed?.eventSeq) && renamed.eventSeq > 0) result.titleSeq = renamed.eventSeq;
  result.renamed = true;

  try {
    await ctx?.sessions?.flush?.(session);
  } catch (error) {
    log?.warn?.(`compact-relay: 旧会话 ${sessionId} 改名后落盘失败：${errorMessage(error)}`);
  }
  return result;
}

/**
 * 解析子会话要挂的 agent preset，并装配 setup（系统提示/工具/技能组成）。
 * 与官方 composeAgent 同构；preset 解析失败时退回默认 preset。
 * @param {object} ctx
 * @param {string|undefined} presetId
 * @returns {Promise<{agentPreset?: string, setup?: Function}>}
 */
async function composeForPreset(ctx, presetId) {
  const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined;
  if (presets === undefined) return {};
  let resolvedId;
  try {
    resolvedId = (await presets.resolve(presetId)).id;
  } catch (error) {
    if (presetId === undefined) throw error;
    // 原会话记录的 preset 可能已被删掉：退回默认 preset，不因它断了交接。
    resolvedId = (await presets.resolve(undefined)).id;
  }
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, resolvedId);
    },
  };
}

/**
 * 新会话的模型路由：优先原会话真实路由（接着用同一个模型），
 * 其次 host 默认模型。取不到就抛错，不建一个跑不了的会话。
 * @param {object} ctx
 * @param {object} session
 * @param {object} [agent]
 * @returns {{provider: string, model: string, reasoningEffort?: string}}
 */
export function childAgentOptionsOf(ctx, session, agent) {
  const route = routeOf(ctx, session, agent);
  if (route !== null) {
    const controls = cacheControls(session, route);
    return {
      ...route,
      ...(typeof controls.reasoningEffort === 'string' && controls.reasoningEffort.length > 0
        ? { reasoningEffort: controls.reasoningEffort }
        : {}),
    };
  }
  try {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
    if (
      selection !== null &&
      typeof selection === 'object' &&
      typeof selection.provider === 'string' &&
      selection.provider.length > 0 &&
      typeof selection.model === 'string' &&
      selection.model.length > 0
    ) {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
      };
    }
  } catch {
    /* fallthrough：给一个可读错误 */
  }
  throw actionError('handoff', '没有可用的 provider/model，无法建新会话（先在本会话里发一条消息，或检查 host 默认模型）');
}

/**
 * 创建交接子会话：同工作区 + 同 preset + 同模型，注入交接单并启动第一轮。
 * @param {object} input
 * @param {object} input.ctx 根上下文
 * @param {object} input.engine DSH 能力接缝
 * @param {object} input.session 原 Session
 * @param {object} [input.agent] 原 Agent
 * @param {string} input.doc 交接单正文（已含元信息头）
 * @param {string} input.title 新会话标题
 * @param {object} [input.plan] handoffTitlePlanOf 的结果（不传则现场计算；串起文档/双写记录用同一份）
 * @param {{warn?: Function}} [input.log]
 * @returns {Promise<{childId: string, title: string, workspaceAttached: boolean, started: boolean, docSeq?: number}>}
 */
export async function createHandoffSession({ ctx, engine, session, agent, doc, title, plan, log }) {
  if (session === undefined) throw actionError('handoff', '没有可交接的会话');

  const childId = `session-${randomUUID()}`;
  const cwd = session?.header?.cwd;
  const hasCwd = typeof cwd === 'string' && cwd.length > 0;

  const composition = await composeForPreset(ctx, presetIdOf(ctx, session));
  const agentOptions = childAgentOptionsOf(ctx, session, agent);
  const meta = {
    ...(hasCwd ? { cwd } : {}),
    parentSession: session.id,
    ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
  };

  let handle;
  try {
    handle = await ctx.agents.create({
      sessionId: childId,
      agentOptions,
      meta,
      ...(composition.setup === undefined ? {} : { setup: composition.setup }),
    });
  } catch (error) {
    throw actionError('handoff', `建新会话失败：${errorMessage(error)}`, error);
  }

  const childAgent = handle?.agent;
  const childSession = childAgent?.session ?? handle?.session;
  if (childSession === undefined || childSession === null) {
    throw actionError('handoff', `新会话 ${childId} 没有返回 Session 句柄，无法注入交接单内容`);
  }

  // 1) 挂到同一工作区（失败只降级：会话仍可用，重启前显示为未分组）。
  let workspaceAttached = false;
  if (hasCwd) {
    try {
      const registry = ctx.get?.('workspaceRegistry');
      if (registry !== undefined && registry !== null) {
        const workspace = await registry.create(cwd);
        await workspace.attachSession(childId);
        workspaceAttached = true;
      }
    } catch (error) {
      log?.warn?.(`compact-relay: 新会话 ${childId} 挂工作区失败（重启前会显示未分组）：${errorMessage(error)}`);
    }
  }

  // 2) 可辨识标题（sessionTitle 服务可选）。
  //    0.4.4 F3：rename 返回的是折叠后的标题快照（DSH 0.2 形如
  //    { title, messageSeqs, source, eventSeq, updatedAt }），不是日志事件。
  //    记下快照里的 eventSeq 供子会话 relay 记录使用；旧宿主/替身没有 eventSeq
  //    就留 null（不猜）。eventSeq=0 也不收：relay 白名单只认正整数序号。
  let titleSeq = null;
  try {
    const titles = ctx.get?.('sessionTitle');
    if (titles !== undefined && titles !== null && typeof titles.rename === 'function') {
      const renamed = titles.rename(childSession, title);
      if (Number.isInteger(renamed?.eventSeq) && renamed.eventSeq > 0) titleSeq = renamed.eventSeq;
    }
  } catch (error) {
    log?.warn?.(`compact-relay: 新会话 ${childId} 改标题失败：${errorMessage(error)}`);
  }

  // 3) 交接单注入：优先 followup（消息落盘 + 启动第一轮，界面能直接看到），
  //    失败退回纯 append（消息仍在历史里，但会话会停在空白 Hero）。
  const text = `${HANDOFF_PREAMBLE}\n\n${doc}`;
  // v4 会话格式只认「producer-owned source kind」：kind=plugin 会被拒
  // （错误原文：format v4 message requires a producer-owned source kind）。
  // 插件来源的正确写法是 `plugin:<插件名>`。
  const message = engine.createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: `plugin:${PLUGIN_NAME}`, form: 'handoff', summary: 'handoff' },
  });

  let started = false;
  let docSeq;
  try {
    if (childAgent !== undefined && childAgent !== null && typeof childAgent.followup === 'function') {
      childAgent.followup(message);
      started = true;
    } else {
      throw new Error('当前 DSH 版本不支持自动起轮');
    }
  } catch (error) {
    log?.warn?.(`compact-relay: 新会话 ${childId} 自动起轮失败，退回纯注入：${errorMessage(error)}`);
    try {
      const event = childSession.append('user/message', message, { surfaceOp: 'append' });
      docSeq = event?.seq;
    } catch (appendError) {
      throw actionError(
        'handoff',
        `新会话 ${childId} 已创建，但交接单注入失败：${errorMessage(appendError)}（可从侧栏手动打开该会话）`,
        appendError,
      );
    }
  }

  // 4) 子会话自己带一条接力链记录（自带链号，不再靠标题解析）。
  //    0.5.0 会把旧会话改名「历史 N：<原名>」、新会话继承原名；那时子会话标题里
  //    没有「交接第 N 次」，splitHandoffTitle 会算出 handedOff=0，第 2 次交接序号
  //    就会重复。所以 ordinal/baseTitle/scheme/titleSeq 必须落在子会话自己的日志里。
  //    写点：followup 之后（新会话首条可见消息仍是交接单）、flush 之前（重启不丢）；
  //    走 plugin record 通道：ignorable，不进模型上下文、不算 token。
  //    scheme 与父记录同源（本次链是 handoff-n 还是 history-n），titleSeq 是**子会话**
  //    rename 返回的 eventSeq；父记录由 lib/actions/handoff.js 另外写，这里只写子会话。
  const titlePlan = plan ?? handoffTitlePlanOf(ctx, session);
  const relayAt = Date.now();
  const relayWrote = writeRelayRecord(engine, childSession, {
    parentId: session.id,
    childId,
    ordinal: titlePlan.index,
    baseTitle: titlePlan.baseTitle,
    title,
    scheme: titlePlan.scheme,
    titleSeq,
    at: relayAt,
    atIso: localIso(new Date(relayAt)),
  });
  if (!relayWrote) {
    log?.warn?.(`compact-relay: 新会话 ${childId} 接力链记录写入失败（下次从该会话交接将回退到标题解析）`);
  }

  // 5) 尽力落盘：新会话的事件尽快持久化，重启后不丢（含上面那条接力链记录）。
  try {
    await ctx.sessions?.flush?.(childSession);
  } catch (error) {
    log?.warn?.(`compact-relay: 新会话 ${childId} 落盘失败：${errorMessage(error)}`);
  }

  return { childId, title, workspaceAttached, started, ...(docSeq === undefined ? {} : { docSeq }) };
}
