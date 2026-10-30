/**
 * 事件留档胶水（0.5.6 Phase A）—— 动作层唯一入口包装器。
 *
 * 为什么不做成「每个动作自己写埋点」：0.5.5 的教训是「新增动作忘写埋点」，
 * 所以 A 级动作统一走 `withActionEvent`：start 行 + end 行成对，失败也成对，
 * **绝不改变动作结果**（不吞错、不改 code、不换型）。
 *
 * 红线：
 *   - `deps.events` 未装配（老测试/直连）→ 直接跑 job，零副作用；
 *   - 记录失败只降级：store 的 start/end 永不抛（见 dsh/events.js）；
 *   - context 只放 `core/events.EVENT_CONTEXT_KEYS` 白名单里的诊断标量，
 *     绝不放聊天正文 / 摘要正文 / 交接单正文 / 工具参数；
 *   - 写盘档脱敏由 store 统一做（保留路径、删凭据）；对外投影走 `exportRowOf`。
 *
 * context 的扩展方式：job 里给 `event.context` / `event.compactionId` 等赋值，
 * end 行会读这里的值；`spec.resultFields(result)` 可在成功返回前派生字段。
 */
import { actionError } from '../core/errors.js';
import { shouldRecordFailure } from '../core/events.js';
import { errorCodeOf } from '../dsh/diag-counters.js';
import { entryState, surfaceSeqs } from '../dsh/session-view.js';

/** 标记「这个错误已经写过 end 行」，HTTP 出口据此避免重复留档。 */
export const EVENT_RECORDED_FLAG = 'dcrEventRecorded';
/** end 行的 id / 脱敏投影（HTTP 出口随 500 回 failureId + failure）。 */
export const EVENT_FAILURE_ID_FLAG = 'dcrFailureId';
export const EVENT_FAILURE_ROW_FLAG = 'dcrFailureRow';

/** 取消的判定：插件动作层统一用 code='cancelled'；AbortError 也算。 */
export function isCancelError(error) {
  if (error === null || typeof error !== 'object') return false;
  return error.code === 'cancelled' || error.name === 'AbortError';
}

/** 取动作作用的会话 id（agent.session.id 优先）。 */
export function sessionIdOf(agent, fallback) {
  if (agent !== null && typeof agent === 'object') {
    const fromSession = agent.session !== null && typeof agent.session === 'object' ? agent.session.id : undefined;
    if (typeof fromSession === 'string' && fromSession.length > 0) return fromSession;
    if (typeof agent.id === 'string' && agent.id.length > 0) return agent.id;
  }
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : null;
}

/** 末条 surface 事件类型（拿不到 → null）。 */
function lastSurfaceTypeOf(session, lastSeq) {
  if (lastSeq === undefined || session === null || typeof session !== 'object') return null;
  try {
    if (typeof session.eventAt !== 'function') return null;
    const event = session.eventAt(lastSeq);
    return event !== null && typeof event === 'object' && typeof event.type === 'string' ? event.type : null;
  } catch {
    return null;
  }
}

/**
 * 只读上下文快照：任何一步失败都置 null / 省略，绝不抛。
 *
 * @param {{engine?:object}} deps
 * @param {{agent?:object, phase?:string}} [input]
 * @returns {{phase:string, surfaceNodes?:number, lastSurfaceSeq?:number, lastSurfaceType?:string,
 *   openTurn?:boolean, pairingBalanced?:boolean, note?:string}}
 */
export function actionContextOf(deps, { agent, phase = 'unknown' } = {}) {
  const context = { phase: typeof phase === 'string' && phase.length > 0 ? phase : 'unknown' };
  const session = agent !== null && typeof agent === 'object' ? agent.session : undefined;
  if (session === undefined || session === null || typeof session !== 'object') {
    context.note = '没有活动会话';
    return context;
  }

  const seqs = surfaceSeqs(session);
  context.surfaceNodes = seqs.length;
  const lastSeq = seqs.length > 0 ? seqs[seqs.length - 1] : undefined;
  if (lastSeq !== undefined) {
    context.lastSurfaceSeq = lastSeq;
    const lastType = lastSurfaceTypeOf(session, lastSeq);
    if (lastType !== null) context.lastSurfaceType = lastType;
  }

  try {
    const state = entryState(session);
    if (typeof state.openTurn === 'boolean') context.openTurn = state.openTurn;
  } catch {
    /* 拿不到就不写 */
  }

  let balanced = null;
  try {
    if (lastSeq !== undefined && typeof deps?.engine?.toolPairingBalancedAfter === 'function') {
      const value = deps.engine.toolPairingBalancedAfter(session, lastSeq);
      if (typeof value === 'boolean') balanced = value;
    }
  } catch {
    balanced = null; // 判定本身抛错就当作「拿不到」，别让诊断弄坏动作
  }
  if (balanced !== null) context.pairingBalanced = balanced;

  const parts = [];
  if (typeof context.lastSurfaceType === 'string') parts.push(`末条 ${context.lastSurfaceType}`);
  if (balanced !== null) parts.push(`尾部工具调用${balanced ? '已配对' : '未配对'}`);
  if (typeof context.openTurn === 'boolean') parts.push(`turn ${context.openTurn ? '未闭合' : '已结束'}`);
  if (typeof context.surfaceNodes === 'number') parts.push(`surface ${context.surfaceNodes} 条`);
  if (parts.length > 0) context.note = parts.join('；');
  return context;
}

/**
 * A 级动作包装器：start → job → end（成功 ok / 取消 cancelled / 失败 fail）。
 *
 * @template T
 * @param {object} deps
 * @param {object} spec
 * @param {string} spec.action
 * @param {string} [spec.trigger]
 * @param {string} [spec.actor]
 * @param {object} [spec.agent]
 * @param {string} [spec.sessionId]
 * @param {string} [spec.phase] 出错时的阶段标签（llm/guard/idle/commit/unknown…）
 * @param {object} [spec.context] 初始 context（白名单键）
 * @param {(result:T)=>({context?:object, compactionId?:string, planId?:string, childId?:string})} [spec.resultFields]
 * @param {(event:object)=>T|Promise<T>} job
 * @returns {Promise<T>}
 */
export async function withActionEvent(deps, spec, job) {
  const store = deps?.events;
  const agent = spec?.agent;
  const action = typeof spec?.action === 'string' ? spec.action : 'unknown';
  // 即使没有 store 也给 job 一个可写的 event 对象（动作代码不用到处判空）。
  const event = {
    id: null,
    context: { ...(spec?.context !== null && typeof spec?.context === 'object' ? spec.context : {}) },
    compactionId: typeof spec?.compactionId === 'string' ? spec.compactionId : null,
    planId: typeof spec?.planId === 'string' ? spec.planId : null,
    childId: typeof spec?.childId === 'string' ? spec.childId : null,
  };
  if (store === null || store === undefined || typeof store.start !== 'function' || typeof job !== 'function') {
    return job(event);
  }

  const sessionId = sessionIdOf(agent, spec?.sessionId);
  const started = store.start({
    action,
    trigger: spec?.trigger,
    actor: spec?.actor,
    sessionId,
    compactionId: spec?.compactionId,
    planId: spec?.planId,
    childId: spec?.childId,
    context: spec?.context,
  });
  event.id = typeof started?.id === 'string' ? started.id : null;

  try {
    const result = await job(event);
    let derived = null;
    try {
      derived = typeof spec?.resultFields === 'function' ? spec.resultFields(result) : null;
    } catch {
      derived = null;
    }
    if (derived !== null && typeof derived === 'object') {
      if (derived.context !== null && typeof derived.context === 'object') event.context = { ...event.context, ...derived.context };
      if (typeof derived.compactionId === 'string') event.compactionId = derived.compactionId;
      if (typeof derived.planId === 'string') event.planId = derived.planId;
      if (typeof derived.childId === 'string') event.childId = derived.childId;
    }
    store.end({
      id: event.id,
      action,
      outcome: 'ok',
      code: null,
      message: null,
      compactionId: event.compactionId,
      planId: event.planId,
      childId: event.childId,
      context: event.context,
    });
    return result;
  } catch (error) {
    const cancelled = isCancelError(error);
    const failureContext = { ...actionContextOf(deps, { agent, phase: spec?.phase }), ...event.context };
    try {
      const ended = store.end({
        id: event.id,
        action,
        outcome: cancelled ? 'cancelled' : 'fail',
        code: errorCodeOf(error),
        message: error instanceof Error ? error.message : String(error),
        compactionId:
          error !== null && typeof error === 'object' && typeof error.compactionId === 'string'
            ? error.compactionId
            : event.compactionId,
        planId: event.planId,
        childId: event.childId,
        context: failureContext,
      });
      try {
        if (error !== null && typeof error === 'object') {
          error[EVENT_RECORDED_FLAG] = true;
          if (ended?.ok === true && typeof ended.id === 'string') error[EVENT_FAILURE_ID_FLAG] = ended.id;
          if (ended?.row !== null && typeof ended?.row === 'object') error[EVENT_FAILURE_ROW_FLAG] = ended.row;
        }
      } catch {
        /* 冻结对象/原始值：忽略 */
      }
    } catch {
      /* 记录失败绝不影响动作结果 */
    }
    throw error;
  }
}

/**
 * HTTP 出口的失败留档（B 级动作 / 未进 A 级包装器的异常）。
 *
 * @param {object} deps
 * @param {object} input
 * @param {string} input.action
 * @param {string} [input.trigger]
 * @param {unknown} input.error
 * @param {string} [input.sessionId]
 * @param {number} [input.statusCode]
 * @param {number|null} [input.durationMs]
 * @param {boolean} [input.cancelled]
 * @param {object} [input.agent]
 * @param {object} [input.context]
 * @param {string} [input.phase]
 * @returns {{id:string, at:string, row:object}|null} null = 不写（busy/changed/无 store/写失败）
 */
export function recordFailureEvent(deps, input = {}) {
  const store = deps?.events;
  if (store === null || store === undefined || typeof store.record !== 'function') return null;
  try {
    const error = input.error;
    const cancelled = input.cancelled === true || isCancelError(error);
    const code = errorCodeOf(error);
    if (
      shouldRecordFailure({
        statusCode: input.statusCode,
        code: cancelled ? 'cancelled' : code,
        cancelled,
      }) !== true
    ) {
      return null;
    }
    const context = {
      ...actionContextOf(deps, { agent: input.agent, phase: input.phase }),
      ...(input.context !== null && typeof input.context === 'object' ? input.context : {}),
    };
    const result = store.record({
      action: input.action,
      trigger: input.trigger,
      sessionId: sessionIdOf(input.agent, input.sessionId),
      outcome: cancelled ? 'cancelled' : 'fail',
      code,
      message: error instanceof Error ? error.message : String(error),
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      context,
    });
    if (result?.ok !== true || typeof result.id !== 'string') return null;
    return { id: result.id, at: result.at, row: result.row ?? null };
  } catch {
    return null;
  }
}

/** 统一的 actionError 包装（保留给后续 Phase 的 action 级检查使用）。 */
export function eventActionError(code, message, cause, statusCode) {
  return actionError(code, message, cause, statusCode);
}
