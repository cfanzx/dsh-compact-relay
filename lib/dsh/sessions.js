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
 *
 * 全部失败点都做「能降级就降级、不能降级就带 childId 报错」，绝不静默。
 */
import { randomUUID } from 'node:crypto';
import { actionError } from '../core/errors.js';
import { relayTitleOf, splitHandoffTitle } from '../core/relay.js';
import { HANDOFF_PREAMBLE } from '../core/prompts.js';
import { cacheControls, routeOf } from './route.js';
import { relayRecordOf } from './relay.js';

/** 插件在消息 source 上的标识。 */
export const PLUGIN_NAME = 'compact-relay';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
 * 下一次交接的标题计划：序号 + 原始标题。
 *
 * A5：优先读父会话里的 relay 记录（结构化数据，不依赖标题文案）；
 * 没有记录（旧会话/首次交接）才回退到标题解析（兼容「交接第 N 次：」与历史堆叠前缀）。
 * @param {object} ctx
 * @param {object} session
 * @returns {{index:number, baseTitle:string, title:string, viaRecord:boolean}}
 */
export function handoffTitlePlanOf(ctx, session) {
  const record = relayRecordOf(session);
  if (record !== null) {
    const fallback = splitHandoffTitle(sourceTitleOf(ctx, session));
    const baseTitle = typeof record.baseTitle === 'string' && record.baseTitle.length > 0 ? record.baseTitle : fallback.baseTitle;
    const index = (Number.isInteger(record.ordinal) ? record.ordinal : record.index) + 1;
    return { index, baseTitle, title: relayTitleOf(index, baseTitle), viaRecord: true };
  }
  const split = splitHandoffTitle(sourceTitleOf(ctx, session));
  const index = split.handedOff + 1;
  return { index, baseTitle: split.baseTitle, title: relayTitleOf(index, split.baseTitle), viaRecord: false };
}

/**
 * 给新会话起个可辨识的标题：交接第 N 次：<原题>。
 * 具体序号/原题由 handoffTitlePlanOf 决定（优先 relay 记录，其次标题解析）。
 * @param {object} ctx
 * @param {object} session
 * @returns {string}
 */
export function childTitleOf(ctx, session) {
  return handoffTitlePlanOf(ctx, session).title;
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
 * @param {{warn?: Function}} [input.log]
 * @returns {Promise<{childId: string, title: string, workspaceAttached: boolean, started: boolean, docSeq?: number}>}
 */
export async function createHandoffSession({ ctx, engine, session, agent, doc, title, log }) {
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
  try {
    const titles = ctx.get?.('sessionTitle');
    if (titles !== undefined && titles !== null && typeof titles.rename === 'function') {
      titles.rename(childSession, title);
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

  // 4) 尽力落盘：新会话的事件尽快持久化，重启后不丢。
  try {
    await ctx.sessions?.flush?.(childSession);
  } catch (error) {
    log?.warn?.(`compact-relay: 新会话 ${childId} 落盘失败：${errorMessage(error)}`);
  }

  return { childId, title, workspaceAttached, started, ...(docSeq === undefined ? {} : { docSeq }) };
}
