/**
 * 长动作异步化（0.5.7）—— 插件内存 job 表。
 *
 * 目的：所有 >3s 的动作（交接预览 / 交接 / 压缩）不再占用单个 HTTP 请求，
 * HTTP 只负责「起任务 → 拿 jobId」和「轮询/取消」。宿主重启即清空（纯内存，零 IO）。
 *
 * 契约（见 0.5.7 架构 §1）：
 *   - start() 只建记录、返回 jobId，**不执行**；launch() 用 setImmediate 把响应让出去再跑；
 *   - 幂等 key = sessionId + kind + hash(参数子集)，同 key running → 复用（防连点）；
 *     同 session+kind 但 key 不同 + running → busy（不排队、不拿旧草稿糊弄用户）；
 *     `force:true` 跳过复用（客户端「重新生成」；并发仍由动作层 withLock 挡住）；
 *   - TTL：settle 后保留 `ttlMs`（默认 10min = core/events.js 的 STALLED_MS），
 *     running 永不 TTL；单个 setInterval 扫描且 `.unref()`（不阻止进程退出）；
 *   - 上限：超过 `max` 先丢最旧的已结束任务；running 永不淘汰（宁可暂时超限）；
 *   - 取消：只走 job.abort()（job-cancel / close 共用），映射成 status:'cancelled'，
 *     **不是错误**；`close()` 是插件卸载路径（abort 全部 running、清 timer）。
 *
 * 命名：id 前缀 `dcrjob-`，与宿主的 `job/registered`/`job/settled` 会话事件和
 * @deepseek-ai/dsh-jobs 注册表无关（我们不写那些事件、不进那张表）。
 */

import { createHash, randomUUID } from 'node:crypto';

/** settle 后保留时长；= core/events.js:STALLED_MS（语义对齐：10 分钟后孤立 start 行变 stalled）。 */
export const JOB_TTL_MS = 10 * 60_000;
/** 内存上限（先淘汰最旧的已结束任务）。 */
export const JOB_MAX = 50;
/** 允许异步化的动作（与 HTTP body 的 kind 同词）。 */
export const JOB_KINDS = Object.freeze(['handoff-preview', 'handoff', 'compact']);
/** job 状态机。 */
export const JOB_STATUSES = Object.freeze(['running', 'done', 'error', 'cancelled']);
/** id 前缀：只为排障时不与宿主 job 混淆，不代表任何宿主注册。 */
export const JOB_ID_PREFIX = 'dcrjob-';

const DEFAULT_SWEEP_MS = 30_000;
const JOB_ID_MAX_CHARS = 80;
/** 幂等参数子集（架构 §1；其它字段如 trigger 不进 key）。 */
const KEYED_PARAMS = Object.freeze(['expected', 'edits', 'archive', 'confirmUnpin']);

/** 按键排序的稳定 JSON 值（只处理普通对象/数组/标量；undefined 丢弃）。 */
function stableValue(value) {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const child = stableValue(value[key]);
    if (child !== undefined) out[key] = child;
  }
  return out;
}

/**
 * 参数子集 → 稳定摘要（同一份请求必须得到同一个 key，键顺序不影响）。
 * @param {object|undefined} params
 * @returns {string}
 */
export function paramsDigestOf(params) {
  const picked = {};
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    for (const key of KEYED_PARAMS) {
      if (params[key] === undefined) continue;
      const value = stableValue(params[key]);
      if (value !== undefined) picked[key] = value;
    }
  }
  return createHash('sha256').update(JSON.stringify(picked)).digest('hex').slice(0, 16);
}

function keyOf(sessionId, kind, params) {
  return `${String(sessionId)}\u0000${kind}\u0000${paramsDigestOf(params)}`;
}

function newJobId() {
  return `${JOB_ID_PREFIX}${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
}

/** 插件动作层的取消判定（与 actions/evented.isCancelError 同口径）。 */
function isCancelError(error) {
  if (error === null || typeof error !== 'object') return false;
  return error.code === 'cancelled' || error.name === 'AbortError';
}

function errorCodeOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && error.code.length > 0) {
    return error.code;
  }
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return 'internal';
}

function errorMessageOf(error) {
  if (error instanceof Error) return error.message;
  return error === undefined || error === null ? '' : String(error);
}

/** 对外快照：不含 controller / promise / run（HTTP 只回这份）。 */
function viewOf(job) {
  return {
    id: job.id,
    kind: job.kind,
    action: job.action,
    sessionId: job.sessionId,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    result: job.result === undefined ? null : job.result,
    error: job.error === null ? null : { ...job.error },
    ttlAt: job.ttlAt,
  };
}

/**
 * 建一张 job 表（每个插件实例一张；测试可注入 now/ttl/max/sweepMs）。
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs] settle 后保留时长
 * @param {number} [options.max] 内存上限（先淘汰最旧 settled）
 * @param {() => number} [options.now] 时钟（测试用）
 * @param {number} [options.sweepMs] 扫描间隔；0/负数 = 不起 timer（测试手动 sweep）
 * @returns {object} job 表
 */
export function createJobTable({ ttlMs = JOB_TTL_MS, max = JOB_MAX, now = () => Date.now(), sweepMs = DEFAULT_SWEEP_MS } = {}) {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : JOB_TTL_MS;
  const cap = Number.isInteger(max) && max > 0 ? max : JOB_MAX;
  /** @type {Map<string, object>} 插入顺序 = 创建顺序（淘汰时从头找最旧 settled） */
  const jobs = new Map();
  /** @type {Map<string, {resolve:Function, reject:Function}>} start 建的 deferred（compat 层 await） */
  const pending = new Map();
  let timer = null;
  let closed = false;

  function markSettled(job) {
    job.endedAt = now();
    job.ttlAt = job.endedAt + ttl;
  }

  /** 取消原因用真正的 AbortError：动作层（evented/cancelErrorOf）靠 code/name 认取消，字符串会漏成失败。 */
  function cancelReasonOf(reason) {
    const error = new Error(reason === 'unload' ? '插件已卸载，任务已取消' : '任务已取消');
    error.name = 'AbortError';
    error.code = 'cancelled';
    return error;
  }

  /** 唯一的取消入口：job-cancel 与 close() 都走这里，避免两处各自 abort。 */
  function abortJob(job, reason) {
    if (job.status === 'running') {
      job.status = 'cancelled';
      markSettled(job);
      job.error = { code: 'cancelled', message: reason === 'unload' ? '插件已卸载，任务已取消' : '任务已取消' };
    }
    try {
      job.controller.abort(cancelReasonOf(reason));
    } catch {
      /* 极端替身可能不实现 abort：取消本身不能成为失败 */
    }
  }

  function settleOk(job, result) {
    // 取消与「动作其实已完成」竞态：成功优先记 done（不能对已建会话/已归档的交接谎报 cancelled）。
    job.status = 'done';
    job.result = result === undefined ? null : result;
    job.error = null;
    markSettled(job);
    const waiter = pending.get(job.id);
    pending.delete(job.id);
    waiter?.resolve?.(result);
  }

  function settleError(job, error) {
    const cancelled = isCancelError(error) || job.controller.signal.aborted === true;
    job.status = cancelled ? 'cancelled' : 'error';
    job.error = cancelled
      ? { code: 'cancelled', message: errorMessageOf(error) || '任务已取消' }
      : { code: errorCodeOf(error), message: errorMessageOf(error) };
    job.result = null;
    markSettled(job);
    const waiter = pending.get(job.id);
    pending.delete(job.id);
    waiter?.reject?.(error);
  }

  function trim() {
    while (jobs.size > cap) {
      let victim = null;
      for (const job of jobs.values()) {
        if (job.status === 'running') continue;
        victim = job;
        break;
      }
      if (victim === null) return; // 全是 running：宁可暂时超限，也不丢正在跑的任务
      jobs.delete(victim.id);
    }
  }

  /** 清掉已过 TTL 的 settled 任务；running 永不 TTL。返回剩余条数。 */
  function sweep() {
    const at = now();
    for (const [id, job] of jobs) {
      if (job.status === 'running') continue;
      if (typeof job.ttlAt === 'number' && job.ttlAt <= at) jobs.delete(id);
    }
    return jobs.size;
  }

  if (Number.isFinite(sweepMs) && sweepMs > 0) {
    timer = setInterval(sweep, sweepMs);
    // 照 dsh/state-hub.js 的写法：诊断/任务表不能阻止宿主进程退出。
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * 建任务（不执行）。
   *
   * @param {object} input
   * @param {'handoff-preview'|'handoff'|'compact'} input.kind
   * @param {string} input.sessionId
   * @param {string} [input.action] 事件口径（缺省 = kind）
   * @param {object} [input.params] 只取 expected/edits/archive/confirmUnpin 做幂等 key
   * @param {boolean} [input.force] true = 跳过复用（「重新生成」）
   * @param {(input:{signal:AbortSignal, jobId:string}) => Promise<any>} input.run
   * @returns {{job:object, reused:boolean}|{busy:true, job:object}}
   */
  function start({ kind, sessionId, action, params, force, run } = {}) {
    if (closed === true) throw new Error('compact-relay: job 表已关闭，不能再起任务');
    if (!JOB_KINDS.includes(kind)) throw new Error(`compact-relay: 未知 job 类型 ${String(kind)}`);
    if (typeof run !== 'function') throw new Error('compact-relay: job 必须带 run 回调');

    const key = keyOf(sessionId, kind, params);
    let sameKeyRunning = null;
    let otherRunning = null;
    for (const candidate of jobs.values()) {
      if (candidate.status !== 'running') continue;
      if (candidate.sessionId !== sessionId || candidate.kind !== kind) continue;
      if (candidate.key === key) sameKeyRunning = candidate;
      else otherRunning = candidate;
    }
    if (force !== true && sameKeyRunning !== null) return { job: sameKeyRunning, reused: true };
    if (force !== true && otherRunning !== null) return { busy: true, job: otherRunning };

    const job = {
      id: newJobId(),
      key,
      kind,
      action: typeof action === 'string' && action.length > 0 ? action : kind,
      sessionId,
      status: 'running',
      startedAt: now(),
      endedAt: null,
      result: null,
      error: null,
      ttlAt: null,
      controller: new AbortController(),
      promise: null,
      run,
      launched: false,
    };
    let resolveDeferred;
    let rejectDeferred;
    job.promise = new Promise((resolve, reject) => {
      resolveDeferred = resolve;
      rejectDeferred = reject;
    });
    // job-start 路径没人 await job.promise：rejection 必须提前有处理者，否则会 unhandled。
    job.promise.catch(() => {});
    pending.set(job.id, { resolve: resolveDeferred, reject: rejectDeferred });
    jobs.set(job.id, job);
    trim();
    return { job, reused: false };
  }

  /**
   * 响应发出后再执行（setImmediate）。幂等：已 launch / 已结束 / 表已关闭 → false。
   * @param {string} jobId
   * @returns {boolean}
   */
  function launch(jobId) {
    const job = jobs.get(typeof jobId === 'string' ? jobId : '');
    if (job === undefined || job.launched === true || job.status !== 'running' || closed === true) return false;
    job.launched = true;
    setImmediate(() => {
      Promise.resolve()
        .then(() => job.run({ signal: job.controller.signal, jobId: job.id }))
        .then(
          (result) => settleOk(job, result),
          (error) => settleError(job, error),
        );
    });
    return true;
  }

  /**
   * 读任务快照。
   * @param {string} jobId
   * @returns {object|null}
   */
  function get(jobId) {
    if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > JOB_ID_MAX_CHARS) return null;
    const job = jobs.get(jobId);
    return job === undefined ? null : viewOf(job);
  }

  /**
   * 某会话某类任务的最新一条（命令 `/handoff status` 不带 jobId 时用）。
   * @param {string} sessionId
   * @param {string} [kind]
   * @returns {object|null}
   */
  function latest(sessionId, kind) {
    let found = null;
    for (const job of jobs.values()) {
      if (job.sessionId !== sessionId) continue;
      if (kind !== undefined && job.kind !== kind) continue;
      if (found === null || job.startedAt >= found.startedAt) found = job;
    }
    return found === null ? null : viewOf(found);
  }

  /**
   * 取消任务：running → status cancelled + abort；已结束 → 原样返回（cancelled:false）。
   * @param {string} jobId
   * @returns {{job:object, cancelled:boolean}|null} null = 不存在/已过期
   */
  function cancel(jobId) {
    if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > JOB_ID_MAX_CHARS) return null;
    const job = jobs.get(jobId);
    if (job === undefined) return null;
    const cancelled = job.status === 'running';
    if (cancelled) abortJob(job, 'cancelled');
    return { job: viewOf(job), cancelled };
  }

  /** 全部任务快照（最新仍在插入顺序末尾）。 */
  function list() {
    return [...jobs.values()].map((job) => viewOf(job));
  }

  /** 插件卸载：abort 全部 running（置 cancelled，不置 error）+ 清 timer。 */
  function close() {
    closed = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    for (const job of jobs.values()) {
      if (job.status === 'running') abortJob(job, 'unload');
    }
  }

  return { kinds: JOB_KINDS, start, launch, get, latest, cancel, list, sweep, close };
}
