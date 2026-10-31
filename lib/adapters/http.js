/**
 * HTTP 适配层 —— 输入框指示灯的数据源 + 菜单动作。
 *
 * 只做 JSON 解析/响应；业务全在 actions 层。
 */
import { betterCompact, cancelBetterCompact, previewBetterCompact } from '../actions/better-compact.js';
import { readAttribution } from '../actions/attribution.js';
import { readCompactDiffs } from '../actions/compact-diff.js';
import { readDiagnostics } from '../actions/diagnostics.js';
import { forceArchiveSession } from '../actions/force-archive.js';
import { handoff, previewHandoff } from '../actions/handoff.js';
import { listHandoffDocs, readHandoffDoc } from '../actions/handoff-docs.js';
import { recoverArchivedSession } from '../actions/recover.js';
import { readCompactRelayChain } from '../actions/relay-chain.js';
import { togglePin } from '../actions/pin.js';
import { markFavoriteBySeq, ownerAgentOfMessage, toggleFavorite, trialFavoriteScore } from '../actions/favorite.js';
import { setNativeAutoCompactionEnabled } from '../actions/native-compaction.js';
import { readState, resolveTarget } from '../actions/state.js';
import { errorText } from '../core/errors.js';
import { normalizeTrigger } from '../core/events.js';
import {
  EVENT_FAILURE_ID_FLAG,
  EVENT_FAILURE_ROW_FLAG,
  EVENT_RECORDED_FLAG,
  recordFailureEvent,
} from '../actions/evented.js';

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

/**
 * 统一失败响应（0.5.6 A2）：任何 4xx/5xx 的 body **必带** `code` + `message`；
 * 真写了失败记录时再带 `failureId` + 脱敏后的 `failure` 对象（可直接贴 issue）。
 *
 * @param {object} res
 * @param {number} status
 * @param {unknown} error
 * @param {object} [extra] 覆盖/追加字段（message 覆盖、cancelled、failureId、failure…）
 */
function sendFailure(res, status, error, extra = {}) {
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'internal';
  send(res, status, {
    ok: false,
    code,
    message: errorText(error),
    ...extra,
  });
}

/**
 * 错误 → HTTP 状态码（唯一口径；与 0.5.5 的分支逐条等价，新增 pairing-tail 走 statusCode 分支）。
 * @param {unknown} error
 * @returns {number}
 */
function statusOf(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  // M6：取消不是失败——回 200 让客户端展示中性提示。
  if (code === 'cancelled') return 200;
  // A3：确认期间范围变了 → 409，客户端据此重开预览。
  if (code === 'changed') return 409;
  // A2：超时/超窗是可解释的失败，带上 code。
  if (code === 'timeout' || code === 'budget') return 500;
  // 0.4 P2-1：交接编辑字段非法（改了程序生成段/超长/类型错）→ 400。
  if (code === 'edits') return 400;
  // 忙（正在压缩/交接/正在回复）回 409，属于可重试状态。
  if (code === 'busy') return 409;
  // 0.5.2 L 项：强制归档把具体原因带回界面。
  if (code === 'force-archive') return Number.isInteger(error?.statusCode) ? error.statusCode : 400;
  // 0.5.6 A5：pairing-tail 自带 statusCode:409；动作层显式标注的状态码（404/409/503/500）直接映射。
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400) return error.statusCode;
  if (error?.statusCode === 413) return 413;
  return 500;
}

/**
 * 需要保留的既有文案（统一出口不许顺手改掉）：
 *   - force-archive / 动作层显式 statusCode：用原始 error.message（比 errorText 更具体）；
 *   - 413：固定「请求体太大」。
 * 其余走 errorText（用户可见文案，行为不变）。
 * @returns {string|undefined} undefined = 用 sendFailure 的默认 errorText
 */
function failureMessageOverride(error, status) {
  if (status === 413) return '请求体太大';
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  if (code === 'force-archive') return error instanceof Error ? error.message : String(error);
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function bodyTooLarge() {
  const error = new Error('request body too large');
  error.statusCode = 413;
  return error;
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error === null) resolve(value);
      else reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      // 先按字节判上限，再统一 Buffer.concat 解码：逐 chunk toString 会拆坏跨块的多字节字符。
      size += chunk.length;
      if (size > limit) {
        finish(bodyTooLarge(), null);
        return; // 继续消费剩余数据，让上层能正常回 413
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => finish(error, null));
  });
}

/**
 * 拒绝跨站请求（防 CSRF）：浏览器跨源简单请求会带 sec-fetch-site: cross-site。
 * 同源 / 本机 curl / 测试 mock（无这些头）放行；Origin 只做 http(s) 同主机校验。
 * @param {object} req
 * @returns {boolean}
 */
function sameOrigin(req) {
  const headers = req?.headers ?? {};
  const origin = headers.origin;
  // 浏览器跨源 simple request 必带 sec-fetch-site: cross-site；网页 origin 一定是 http(s)。
  // dsh-app:// 等自定义协议的桌面页可能也被标 cross-site，但它的 origin 不是 http(s)，放行以免误伤。
  if (headers['sec-fetch-site'] === 'cross-site') {
    if (typeof origin !== 'string' || origin.length === 0) return false;
    // 2026-10-20 修复：Origin:null（sandbox iframe / no-cors POST）必须先拒，不能在下面被当「自定义协议」放行。
    if (origin === 'null') return false;
    return !/^https?:\/\//i.test(origin);
  }
  if (typeof origin !== 'string' || origin.length === 0) return true;
  if (origin === 'null') return false;
  if (!/^https?:\/\//i.test(origin)) return true;
  const host = headers.host;
  if (typeof host !== 'string' || host.length === 0) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 宿主鉴权闸门（2026-10-20 安全修复，P0）。
 *
 * 插件用 `kind:'exact'` 注册 /api/compact-relay-*，会抢在宿主 /api prefix handler 前面，
 * 宿主的 Host/Origin fence 与浏览器 token 校验不会执行。这里显式调用宿主同一个
 * `connection.requestRejection(req)`：它做 Host/Origin 校验 + 浏览器 cookie / API 凭据认证。
 *
 * 返回 401/403 表示拒绝；undefined 表示通过。
 * 旧宿主或测试替身拿不到 connection 服务时，退回「仅 loopback + 拒跨站」的最小校验。
 * @param {object} webCtx
 * @param {object} req
 * @returns {number|undefined}
 */
function hostRejection(webCtx, req) {
  try {
    const connection =
      webCtx !== null && typeof webCtx === 'object'
        ? (webCtx.connection ?? (typeof webCtx.get === 'function' ? webCtx.get('connection') : undefined))
        : undefined;
    if (connection !== null && connection !== undefined && typeof connection.requestRejection === 'function') {
      return connection.requestRejection(req);
    }
  } catch {
    /* 拿不到就退回本地最小校验 */
  }
  return fallbackRejection(webCtx, req);
}

/**
 * 没有 connection 服务时的最小校验：Host 必须是 loopback/监听地址，且拒绝跨站。
 * 注意：它不能校验浏览器 token（旧宿主没有那套机制），只作为兼容兜底。
 * @param {object} webCtx
 * @param {object} req
 * @returns {number|undefined}
 */
function fallbackRejection(webCtx, req) {
  const headers = req?.headers ?? {};
  const host = headers.host;
  if (typeof host !== 'string' || host.length === 0) return 403;
  const hostname = host.replace(/:\d+$/u, '').toLowerCase();
  const bindHost = webCtx?.webServer?.host;
  const allowed =
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === 'localhost' ||
    (typeof bindHost === 'string' && bindHost.length > 0 && hostname === bindHost.toLowerCase());
  if (!allowed) return 403;
  if (headers['sec-fetch-site'] === 'cross-site') return 403;
  return undefined;
}

/**
 * 设置端点响应 = 设置视图 + 轻账本累计（0.4 P1-3；客户端「累计」一行数字的数据源）。
 * 读账本失败/没有 ledger 时 `ledger: null`（客户端显示引导文案，不影响设置页）。
 */
export function settingsPayloadOf(deps) {
  const view = deps.settings.view();
  let ledger = null;
  try {
    ledger = typeof deps.ledger?.summary === 'function' ? deps.ledger.summary() : null;
  } catch {
    ledger = null;
  }
  return { ...view, ledger };
}

function denyAuth(res, rejection) {
  const status = rejection === 401 ? 401 : 403;
  return send(res, status, {
    ok: false,
    error: status === 401 ? '未认证：请从 DSH 界面打开（缺少浏览器 cookie）' : '拒绝跨站或非本机请求',
  });
}

/* ------------------------------------------------------------------ *
 * 0.5.7 长动作异步化（job 层）—— 适配层只做「起任务 / 轮询 / 取消」的转接
 *
 * 契约（架构 §2）：
 *   - 三个 <2s 的动作 job-start / job-status / job-cancel；旧同步动作保留，
 *     但 15s（timeouts.jobCompatMs）内没跑完就回 202 ok:false,code:'pending'；
 *   - 新旧路径共用 deps.jobs 一张表（index.js 装配），所以兼容层起的任务也带 jobId；
 *   - job 内失败原样 rethrow → 走既有 catch（sendFailure + 失败留档），不新增错误出口。
 * ------------------------------------------------------------------ */

/** 兼容层默认预算（架构 §2）：给宿主 20s 截断留 5s 余量。 */
const DEFAULT_JOB_COMPAT_MS = 15_000;

/** 取 job 表；手搓 deps 的旧测试/旧装配没有 jobs → 兼容层退化为同步调用（生产恒有）。 */
function jobsTableOf(deps) {
  const table = deps === null || deps === undefined ? undefined : deps.jobs;
  return table !== null && typeof table === 'object' && typeof table.start === 'function' && typeof table.launch === 'function'
    ? table
    : null;
}

function jobCompatMsOf(deps) {
  const value = deps?.cfg?.timeouts?.jobCompatMs;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_JOB_COMPAT_MS;
}

/** 404 口径（架构 §2）：宿主重启会清空内存表，文案要说明可重试。 */
function noJobPayload() {
  return {
    ok: false,
    code: 'nojob',
    message: '任务不存在或已过期（宿主重启会清空任务表），请重试',
  };
}

/** job-status 响应（result 只给 done；error 只给 error/cancelled）。 */
function jobStatusPayload(job) {
  const endedAt = Number.isFinite(job.endedAt) ? job.endedAt : Date.now();
  return {
    ok: true,
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    elapsedMs: Number.isFinite(job.startedAt) ? Math.max(0, endedAt - job.startedAt) : 0,
    ...(job.status === 'done' ? { result: job.result } : {}),
    ...(job.error === null || job.error === undefined ? {} : { error: job.error }),
  };
}

/**
 * job 里跑的动作本体：返回体 = 0.5.6 旧同步动作的**成功响应体**（逐字段不变），
 * 这样兼容层直接 send 同一个 result，新客户端轮询 job-status 拿到的 result 也同一形状。
 */
async function runActionJob(deps, { kind, agent, trigger, parsed, signal, jobId }) {
  if (kind === 'handoff-preview') {
    // A1b：只生成草稿 + 就绪清单，不写盘/不建会话/不改历史。
    return previewHandoff(deps, { agent, trigger, signal, jobId });
  }
  if (kind === 'handoff') {
    const outcome = await handoff(deps, {
      agent,
      edits: parsed.edits,
      archive: parsed.archive,
      confirmUnpin: parsed.confirmUnpin,
      trigger,
      signal,
      jobId,
    });
    return { ok: true, message: outcome.message, childId: outcome.childId, path: outcome.path, archive: outcome.archive };
  }
  if (kind === 'compact') {
    const expected = parsed.expected !== null && typeof parsed.expected === 'object' ? parsed.expected : undefined;
    const outcome = await betterCompact(deps, { agent, expected, trigger, signal, jobId });
    return { ok: true, message: outcome.message };
  }
  throw new Error(`未知任务类型：${String(kind)}`);
}

/** 起一个 job（幂等 key 只取 handoff/compact 的关键参数，见 dsh/jobs.js）。 */
function startActionJob(deps, { kind, sessionId, agent, trigger, parsed, force }) {
  return deps.jobs.start({
    kind,
    action: kind,
    sessionId,
    params: {
      expected: parsed.expected,
      edits: parsed.edits,
      archive: parsed.archive,
      confirmUnpin: parsed.confirmUnpin,
    },
    force: force === true,
    run: ({ signal, jobId }) => runActionJob(deps, { kind, agent, trigger, parsed, signal, jobId }),
  });
}

/**
 * 旧同步动作的兼容层：起 job → 最多等 jobCompatMs → 完成回原响应体 / 超时回 202 pending。
 * **超时不 abort job**（任务继续跑，客户端可拿 202 里的 jobId 轮询）。
 */
async function runCompat(deps, { kind, sessionId, agent, trigger, parsed, res }) {
  if (jobsTableOf(deps) === null) {
    // 兼容旧装配（手搓 deps 无 jobs）：保持 0.5.6 的同步语义，不引入新失败点。
    return send(res, 200, await runActionJob(deps, { kind, agent, trigger, parsed, signal: undefined, jobId: undefined }));
  }
  const started = startActionJob(deps, { kind, sessionId, agent, trigger, parsed });
  if (started.busy === true) {
    return send(res, 409, {
      ok: false,
      code: 'busy',
      message: '上一次同类任务还在跑，请先取消再试（job-cancel）',
      jobId: started.job.id,
    });
  }
  deps.jobs.launch(started.job.id);
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('任务还在跑');
      error.code = 'pending';
      reject(error);
    }, jobCompatMsOf(deps));
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const result = await Promise.race([started.job.promise, timeout]);
    return send(res, 200, result);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'pending') {
      return send(res, 202, {
        // 刻意 ok:false：只判 res.ok/ok:true 的旧脚本不会把 pending 当成功。
        ok: false,
        code: 'pending',
        pending: true,
        jobId: started.job.id,
        kind,
        message: '任务进行中（约十几秒），请稍候…',
      });
    }
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 客户端错误留档（0.5.7，B 级动作）：不走 recordFailureEvent —— 客户端错误没有 error
 * 对象，code/message/status/bodyHead 全部由 HTTP body 直接控（context 值 ≤80 码点）。
 */
function recordClientError(deps, parsed, trigger) {
  const store = deps === null || deps === undefined ? undefined : deps.events;
  if (store === null || store === undefined || typeof store.record !== 'function') return;
  const kind =
    typeof parsed.kind === 'string' && parsed.kind.trim().length > 0 ? parsed.kind.trim().slice(0, 80) : 'unknown';
  const status = Number.isInteger(parsed.status) ? parsed.status : undefined;
  // 不在这里按码元切：contextOf 会按码点 clip 到 80（避免切坏 emoji）。
  const bodyHead = typeof parsed.bodyHead === 'string' ? parsed.bodyHead : undefined;
  try {
    store.record({
      action: 'client-error',
      trigger,
      outcome: 'fail',
      sessionId:
        typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0 ? parsed.sessionId : undefined,
      code: typeof parsed.code === 'string' && parsed.code.length > 0 ? parsed.code.slice(0, 60) : 'client',
      message:
        typeof parsed.message === 'string' && parsed.message.length > 0
          ? parsed.message
          : `客户端上报错误（${kind}）`,
      statusCode: status,
      context: { status, bodyHead, kind },
    });
  } catch {
    /* 留档失败不影响回包（store 本身永不抛，这里再兜一层） */
  }
}

/**
 * @param {object} webCtx 带 webServer 的上下文
 * @param {{ctx:object, cfg:object, lock:object, engine:object}} deps
 */
export function registerHttp(webCtx, deps) {
  const stateStop = webCtx.webServer.register({
    kind: 'exact',
    path: '/api/compact-relay-state',
    handler: (req, res) => {
      void (async () => {
        try {
          const rejection = hostRejection(webCtx, req);
          if (rejection !== undefined) return denyAuth(res, rejection);
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '只支持 GET' });
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const sessionId = url.searchParams.get('sessionId') ?? undefined;
          send(res, 200, await readState(deps, { sessionId }));
        } catch (error) {
          try {
            sendFailure(res, 500, error);
          } catch {
            /* 连接可能已断 */
          }
        }
      })();
    },
  });
  webCtx.effect(() => stateStop, 'compact-relay: state endpoint');

  // 0.5.1 DCR-05：完整交接链（一次读完，最多 8 层）。
  //
  // 旧客户端逐级 GET `/api/compact-relay-state?sessionId=父id`，宿主对未加载的祖先返回
  // `sessionId:null` → 整条链只剩 1 层。这里改为服务端只读持久化日志（不加载会话），
  // 把整条链一次返回；旧宿主没有 sessionPersistence 时返回 `ok:false`，客户端回落逐级读。
  const chainStop = webCtx.webServer.register({
    kind: 'exact',
    path: '/api/compact-relay-chain',
    handler: (req, res) => {
      void (async () => {
        try {
          const rejection = hostRejection(webCtx, req);
          if (rejection !== undefined) return denyAuth(res, rejection);
          if (req.method !== 'GET') return send(res, 405, { ok: false, message: '只支持 GET' });
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const sessionId = url.searchParams.get('sessionId') ?? '';
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            return send(res, 400, { ok: false, message: '缺少 sessionId' });
          }
          send(res, 200, await readCompactRelayChain(deps, { sessionId }));
        } catch (error) {
          try {
            sendFailure(res, 500, error);
          } catch {
            /* 连接可能已断 */
          }
        }
      })();
    },
  });
  webCtx.effect(() => chainStop, 'compact-relay: relay chain endpoint');

  const streamStop = webCtx.webServer.register({
    kind: 'exact',
    path: '/api/compact-relay-stream',
    handler: (req, res) => {
      try {
        const rejection = hostRejection(webCtx, req);
        if (rejection !== undefined) return denyAuth(res, rejection);
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: '只支持 GET' });
        deps.hub.serve(req, res);
      } catch (error) {
        try {
          sendFailure(res, 500, error);
        } catch {
          /* 连接可能已断 */
        }
      }
    },
  });
  webCtx.effect(() => streamStop, 'compact-relay: state stream');

  // M6：交接单列表 / 单篇查看（只读，给指示灯菜单的「查看交接单」用）。
  const docsStop = webCtx.webServer.register({
    kind: 'exact',
    path: '/api/compact-relay-handoffs',
    handler: (req, res) => {
      void (async () => {
        try {
          const rejection = hostRejection(webCtx, req);
          if (rejection !== undefined) return denyAuth(res, rejection);
          if (req.method !== 'GET') return send(res, 405, { ok: false, message: '只支持 GET' });
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const file = url.searchParams.get('file');
          if (file !== null) {
            const doc = readHandoffDoc(deps, { file });
            if (doc === null) return send(res, 404, { ok: false, message: '找不到这份交接单（或文件名不合法）' });
            return send(res, 200, { ok: true, ...doc });
          }
          const limit = Number(url.searchParams.get('limit') ?? 20);
          const listed = listHandoffDocs(deps, { limit });
          // 0.3.4（BUG-006）：带 total（全量份数），客户端据此显示「共 N 份」/加载更多。
          return send(res, 200, { ok: true, dir: listed.dir, items: listed.items, total: listed.total });
        } catch (error) {
          try {
            sendFailure(res, 500, error);
          } catch {
            /* 连接可能已断 */
          }
        }
      })();
    },
  });
  webCtx.effect(() => docsStop, 'compact-relay: handoff docs endpoint');

  // A6：压缩历史（只读）—— 最近 N 次压缩的范围、摘要预览、容量与提交状态。
  const diffStop = webCtx.webServer.register({
    kind: 'exact',
    path: '/api/compact-relay-diff',
    handler: (req, res) => {
      void (async () => {
        try {
          const rejection = hostRejection(webCtx, req);
          if (rejection !== undefined) return denyAuth(res, rejection);
          if (req.method !== 'GET') return send(res, 405, { ok: false, message: '只支持 GET' });
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const sessionId = url.searchParams.get('sessionId') ?? undefined;
          const rawLimit = Number(url.searchParams.get('limit') ?? 10);
          const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 10;
          return send(res, 200, readCompactDiffs(deps, { sessionId, limit }));
        } catch (error) {
          const code = error !== null && typeof error === 'object' ? error.code : undefined;
          if (code === 'nosession') return send(res, 409, { ok: false, message: errorText(error) });
          try {
            sendFailure(res, 500, error);
          } catch {
            /* 连接可能已断 */
          }
        }
      })();
    },
  });
  webCtx.effect(() => diffStop, 'compact-relay: compact diff endpoint');

  // 设置栏：读取/保存插件设置（颜色、阈值、保留量、交接单目录）。
  // 存自己的 JSON 文件并热应用，不走官方 settings wire（第三方命名空间拿不到）。
  const settingsStop = webCtx.webServer.register({
    kind: 'exact',
    path: '/api/compact-relay-settings',
    handler: (req, res) => {
      void (async () => {
        try {
          const rejection = hostRejection(webCtx, req);
          if (rejection !== undefined) return denyAuth(res, rejection);
          if (req.method === 'GET') {
            return send(res, 200, { ok: true, ...settingsPayloadOf(deps) });
          }
          if (req.method !== 'POST') return send(res, 405, { ok: false, message: '只支持 GET/POST' });
          if (!sameOrigin(req)) return send(res, 403, { ok: false, message: '拒绝跨站请求' });
          const body = await readBody(req, 16384);
          let parsed;
          try {
            parsed = JSON.parse(body === '' ? '{}' : body);
          } catch {
            return send(res, 400, { ok: false, message: '请求不是合法 JSON' });
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return send(res, 400, { ok: false, message: '请求体必须是 JSON 对象' });
          }
          if (parsed.reset === true) {
            deps.settings.reset();
            deps.hub?.refreshAll?.();
            return send(res, 200, { ok: true, ...settingsPayloadOf(deps) });
          }
          // 0.4.2：客户端可选带 nativeRatio（当前模型实际触发线），服务端按实际线 −5pp
          // 校验交接线（与 UI 同口径）；不带则退回配置阈值防呆（兼容 0.4.1 客户端）。
          deps.settings.save(parsed, { nativeRatio: parsed.nativeRatio });
          deps.hub?.refreshAll?.();
          return send(res, 200, { ok: true, ...settingsPayloadOf(deps) });
        } catch (error) {
          try {
            const status = error?.statusCode === 413 ? 413 : 400;
            const payload = {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            };
            // A4：字段级校验错误带 field，设置页可定位到具体设置项。
            if (error !== null && typeof error === 'object' && typeof error.field === 'string') {
              payload.field = error.field;
            }
            send(res, status, payload);
          } catch {
            /* 连接可能已断 */
          }
        }
      })();
    },
  });
  webCtx.effect(() => settingsStop, 'compact-relay: settings endpoint');

  // 0.4 P0-2：诊断信息（只读、幂等、无副作用）——本机生成、白名单、已脱敏。
  // 只提供 GET；没有 POST/上传通道（方案 §5.4、§10）。
  const diagnosticsStop = webCtx.webServer.register({
    kind: 'exact',
    path: '/api/compact-relay-diagnostics',
    handler: (req, res) => {
      void (async () => {
        try {
          const rejection = hostRejection(webCtx, req);
          if (rejection !== undefined) return denyAuth(res, rejection);
          if (req.method !== 'GET') return send(res, 405, { ok: false, message: '只支持 GET' });
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const sessionId = url.searchParams.get('sessionId') ?? undefined;
          // 组装在 actions 层（adapters 不直接碰 dsh/，见 A9 架构守卫）。
          const payload = await readDiagnostics(deps, { sessionId });
          return send(res, 200, { ok: true, ...payload });
        } catch (error) {
          // 只回短文案，不把内部正文/堆栈回给浏览器（方案 §5.4）。
          const code = error !== null && typeof error === 'object' ? error.code : undefined;
          try {
            deps.log?.warn?.(`compact-relay: 生成诊断信息失败${typeof code === 'string' ? `（${code}）` : ''}`);
          } catch {
            /* 日志失败不影响响应 */
          }
          try {
            send(res, 500, {
              ok: false,
              // 0.5.6 A2：诊断端点也恒带 code（文案保持 0.5.5 原样）。
              code: code === 'toolarge' ? 'toolarge' : 'internal',
              message:
                code === 'toolarge'
                  ? '诊断信息超过 64KB 上限，请先减少错误记录后再试'
                  : '生成诊断信息失败（详情见插件日志）',
            });
          } catch {
            /* 连接可能已断 */
          }
        }
      })();
    },
  });
  webCtx.effect(() => diagnosticsStop, 'compact-relay: diagnostics endpoint');

  // 0.5.6 D1：压缩归属（只读本机事件流；不要求活会话，重启后也能查）。
  // GET /api/compact-relay-attribution?limit=20&sessionId=...
  // 返回 {ok:true, attribution:[...], total}；attribution 最新在前。
  const attributionStop = webCtx.webServer.register({
    kind: 'exact',
    path: '/api/compact-relay-attribution',
    handler: (req, res) => {
      void (async () => {
        try {
          const rejection = hostRejection(webCtx, req);
          if (rejection !== undefined) return denyAuth(res, rejection);
          if (req.method !== 'GET') return send(res, 405, { ok: false, message: '只支持 GET' });
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const sessionId = url.searchParams.get('sessionId') ?? undefined;
          const limit = Number(url.searchParams.get('limit'));
          // 组装在 actions 层（adapters 不直接碰 dsh/，见 A9 架构守卫）。
          const payload = readAttribution(deps, {
            sessionId,
            ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          });
          return send(res, 200, payload);
        } catch (error) {
          try {
            sendFailure(res, 500, error);
          } catch {
            /* 连接可能已断 */
          }
        }
      })();
    },
  });
  webCtx.effect(() => attributionStop, 'compact-relay: attribution endpoint');

  const actionStop = webCtx.webServer.register({
    kind: 'exact',
    path: '/api/compact-relay-action',
    handler: (req, res) => {
      void (async () => {
        // 0.5.6 A2：parse 结果与 trigger 提到 try 外 —— catch 里要用它们留档/回包。
        let parsed = null;
        let trigger = 'unknown';
        try {
          const rejection = hostRejection(webCtx, req);
          if (rejection !== undefined) return denyAuth(res, rejection);
          if (req.method !== 'POST') return send(res, 405, { ok: false, message: '只支持 POST' });
          if (!sameOrigin(req)) return send(res, 403, { ok: false, message: '拒绝跨站请求' });
          // 0.4 P2-1：handoff 可以带「约束/下一步」两段编辑（各 ≤4000 字符），body 上限放宽到 48KB。
          const body = await readBody(req, 48 * 1024);
          try {
            parsed = JSON.parse(body === '' ? '{}' : body);
          } catch {
            return send(res, 400, { ok: false, message: '请求不是合法 JSON' });
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return send(res, 400, { ok: false, message: '请求体必须是 JSON 对象' });
          }
          // 0.5.6 A：trigger 归属口径（缺失/非法 → unknown，不猜）。
          trigger = normalizeTrigger(parsed.trigger);
          // 0.5.1 批 2：交接的归档开关 / 置顶确认只接受布尔值；类型错在动历史前就拒绝。
          if (parsed.archive !== undefined && typeof parsed.archive !== 'boolean') {
            return send(res, 400, { ok: false, message: 'archive 必须是 true/false（false = 只交接、不归档旧会话）' });
          }
          if (parsed.confirmUnpin !== undefined && typeof parsed.confirmUnpin !== 'boolean') {
            return send(res, 400, { ok: false, message: 'confirmUnpin 必须是 true/false（true = 确认归档并取消旧会话置顶）' });
          }
          // 0.5.2 L 项：强制归档的破坏性动作只有用户点过二次确认才允许执行
          // （confirmStop:true = 会停止旧会话上正在跑的 turn/subagent/job/schedule）。
          if (parsed.confirmStop !== undefined && typeof parsed.confirmStop !== 'boolean') {
            return send(res, 400, {
              ok: false,
              message: 'confirmStop 必须是 true/false（true = 确认停止旧会话上的任务后归档）',
            });
          }
          // 多数动作作用在具体会话上：缺 sessionId 或类型错时绝不能退化成「最后一个 agent」
          // （2026-10-19 debug：旧实现会压错会话）。
          // 例外：
          //   - native-auto 改的是 DSH profile 配置（全局开关），不属于任何会话——
          //     UI-003（2026-10-20）：以前这里对所有 action 都先要 sessionId，设置页没带 →
          //     恒 400「缺少 sessionId」，于是「关闭自动压缩」永远写不进去、也看不到反馈。
          //   - recover 作用在**已归档**的旧会话上，它通常没有活 agent；不能走 resolveTarget
          //     （否则恒 409「没有活动会话」）。sessionId 由 recover 分支自己校验。
          //   - force-archive 同样作用在**旧会话**（交接前的那个）上，通常没有活 agent 可解；
          //     它自己的动作层会校验 sessionId 与 confirmStop，不走 resolveTarget。
          let agent = null;
          // favorite-toggle 例外：messageId 是宿主 UUID，客户端没带对 sessionId 也能由
          // ownerAgentOfMessage 反查所属会话（2026-10-29 真机 BUG：多会话时点星静默失败）。
          const sessionOptionalAction =
            parsed.action === 'native-auto' ||
            parsed.action === 'recover' ||
            parsed.action === 'force-archive' ||
            parsed.action === 'favorite-toggle' ||
            parsed.action === 'favorite-mark' ||
            // 0.5.7：job-status/job-cancel 只带 jobId；client-error 可能没有 sessionId
            // （客户端在会话上下文丢失时也要能上报）。job-start **不走**这个例外。
            parsed.action === 'job-status' ||
            parsed.action === 'job-cancel' ||
            parsed.action === 'client-error';
          if (!sessionOptionalAction) {
            if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) {
              return send(res, 400, { ok: false, message: '缺少 sessionId' });
            }
            agent = resolveTarget(deps, { sessionId: parsed.sessionId });
            if (agent === null) return send(res, 409, { ok: false, message: '没有活动会话' });
          } else if (
            parsed.action === 'favorite-toggle' &&
            typeof parsed.sessionId === 'string' &&
            parsed.sessionId.length > 0
          ) {
            // 带了 sessionId 就按它取 agent；取不到（会话已关）也继续，后面按 messageId 反查。
            agent = resolveTarget(deps, { sessionId: parsed.sessionId });
          }

          if (parsed.action === 'recover') {
            // 0.5.0：恢复被自动归档的旧会话（接力条恢复入口的 HTTP 兜底）。
            if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) {
              return send(res, 400, { ok: false, message: '缺少要恢复的会话 sessionId' });
            }
            const outcome = await recoverArchivedSession(deps, { sessionId: parsed.sessionId, trigger });
            return send(res, 200, outcome);
          }

          if (parsed.action === 'force-archive') {
            // 0.5.2 L 项：用户确认「会停止旧会话上正在跑的任务」后强制归档（唯一 stopActivity 调用点）。
            // 0.5.3 P2-1：这里不再提前 400 —— 已归档 + 没带确认应回 already（动作层先判幂等），
            // 只有「真要归档」的路径才要求 confirmStop:true（动作层给 statusCode 400）。
            if (parsed.confirmStop !== undefined && typeof parsed.confirmStop !== 'boolean') {
              return send(res, 400, { ok: false, message: 'confirmStop 必须是 true/false（true = 确认停止旧会话上的任务后归档）' });
            }
            const outcome = await forceArchiveSession(deps, {
              sessionId: parsed.sessionId,
              confirmStop: parsed.confirmStop,
              confirmUnpin: parsed.confirmUnpin,
              trigger,
            });
            return send(res, 200, outcome);
          }

          if (parsed.action === 'preview') {
            // M6：只算不写——先告诉用户「要压哪段、多少 token」，再让他确认。
            // A3：返回 planId，confirm 会带着它回来校验「同一段范围」。
            const outcome = await previewBetterCompact(deps, { agent, trigger });
            return send(res, 200, {
              ok: true,
              message: outcome.message,
              planId: outcome.planId ?? null,
              preview: outcome.preview ?? null,
              compacted: outcome.compacted === true,
            });
          }
          if (parsed.action === 'cancel') {
            // M6：取消正在跑的压缩/交接（abort 信号；压缩历史不变，已完成的压缩不会回滚）。
            const outcome = cancelBetterCompact(deps, { agent, trigger });
            return send(res, 200, {
              ok: outcome.ok,
              cancelled: outcome.cancelled,
              kind: outcome.kind ?? null,
              message: outcome.message,
            });
          }
          if (parsed.action === 'compact') {
            // A3：客户端应带 preview 返回的 expected（planId + 范围）；老调用方不带也兼容。
            // 0.5.7：走兼容层（同一张 job 表）—— 15s 内完成回原响应体，否则 202 pending + jobId。
            return await runCompat(deps, {
              kind: 'compact',
              sessionId: parsed.sessionId,
              agent,
              trigger,
              parsed,
              res,
            });
          }
          if (parsed.action === 'favorite-score-trial') {
            // 0.5.3 P1-7：设置页「试算」——对一段文本按当前（可覆盖）配置跑一次打分+判定。
            // 只读：不写收藏、不影响任何状态；没有活会话拿不到模型路由时明确 409。
            if (agent === null) return send(res, 409, { ok: false, message: '没有活动会话，无法试算（先发一条消息唤醒 agent）' });
            const text = typeof parsed.text === 'string' ? parsed.text : '';
            if ([...text.trim()].length === 0) return send(res, 400, { ok: false, message: '缺少要试算的文本' });
            const outcome = await trialFavoriteScore(deps, {
              agent,
              text,
              level: parsed.level,
              mustWords: parsed.mustWords,
              muteWords: parsed.muteWords,
            });
            return send(res, 200, { ok: true, ...outcome });
          }
          if (parsed.action === 'favorite-mark') {
            // 0.5.3：标记层解耦——按 sessionId+seq 收藏，**不需要活会话**（归档/关闭的会话也能标）。
            // 只写一行 JSONL；原文等压缩时落档，不读会话日志、不碰压缩。
            if (parsed.active !== undefined && typeof parsed.active !== 'boolean') {
              return send(res, 400, { ok: false, message: 'active 必须是 true/false（省略=切换）' });
            }
            try {
              const outcome = await markFavoriteBySeq(deps, {
                sessionId: parsed.sessionId,
                seq: Number(parsed.seq),
                active: parsed.active,
              });
              return send(res, 200, { ok: true, ...outcome });
            } catch (error) {
              const code = error !== null && typeof error === 'object' ? error.code : undefined;
              const status = code === 'favorite' ? 400 : 500;
              // B 级动作只在失败时记一行（避免收藏点击把 800 行配额几天转完）。
              recordFailureEvent(deps, {
                action: 'favorite-mark',
                trigger,
                error,
                sessionId: parsed.sessionId,
                statusCode: status,
                phase: 'http',
              });
              return send(res, status, {
                ok: false,
                ...(code === undefined ? {} : { code }),
                message: errorText(error),
              });
            }
          }
          if (parsed.action === 'favorite-toggle') {
            // 0.6：助手消息底部星标——按宿主 messageId 收藏/取消。
            // 客户端 sessionId 可能缺失或过期：messageId 唯一，按它反查所属活会话。
            const messageId =
              typeof parsed.messageId === 'string' && parsed.messageId.length > 0 ? parsed.messageId : null;
            if (messageId === null) return send(res, 400, { ok: false, message: '缺少 messageId' });
            try {
              const actor = agent ?? ownerAgentOfMessage(deps, messageId);
              const outcome = toggleFavorite(deps, { agent: actor, messageId });
              return send(res, 200, { ok: true, ...outcome });
            } catch (error) {
              const code = error !== null && typeof error === 'object' ? error.code : undefined;
              const status = code === 'favorite' ? 400 : 500;
              recordFailureEvent(deps, {
                action: 'favorite-toggle',
                trigger,
                error,
                sessionId: parsed.sessionId,
                statusCode: status,
                phase: 'http',
              });
              return send(res, status, {
                ok: false,
                ...(code === undefined ? {} : { code }),
                message: errorText(error),
              });
            }
          }
          if (parsed.action === 'pin-toggle') {
            // M6：菜单「锁定重要消息 / 解锁消息」——有锁定就清空，没有就锁最近一轮。
            const outcome = togglePin(deps, { agent });
            return send(res, 200, {
              ok: true,
              pinned: outcome.pinned,
              message: outcome.message,
            });
          }
          if (parsed.action === 'native-auto') {
            // 0.3.1：关闭/恢复 DSH 原生自动压缩（写 profile 的 cordis.patch.yml，备份后可回滚，重启生效）。
            if (typeof parsed.enabled !== 'boolean') {
              return send(res, 400, { ok: false, message: '缺少 enabled（true=恢复原生自动压缩，false=关闭）' });
            }
            const outcome = setNativeAutoCompactionEnabled({ enabled: parsed.enabled });
            return send(res, 200, { ok: true, ...outcome });
          }
          // ------------------------------------------------------------------
          // 0.5.7 长动作异步化：新客户端三个短动作（都不超过 2s）
          //   插入位置：agent 解析之后、未知动作之前；紧随其后的 handoff-preview/handoff/compact
          //   旧同步动作改走兼容层（同一张 job 表）。
          // ------------------------------------------------------------------
          if (parsed.action === 'job-start') {
            const table = jobsTableOf(deps);
            if (table === null) {
              return send(res, 500, { ok: false, code: 'jobs', message: '任务表不可用（插件装配缺少 jobs）' });
            }
            if (!table.kinds.includes(parsed.kind)) {
              return send(res, 400, { ok: false, code: 'kind', message: '缺少或未知的任务类型（kind）' });
            }
            const started = startActionJob(deps, {
              kind: parsed.kind,
              sessionId: parsed.sessionId,
              agent,
              trigger,
              parsed,
              force: parsed.force,
            });
            if (started.busy === true) {
              return send(res, 409, {
                ok: false,
                code: 'busy',
                message: '上一次同类任务还在跑，请先取消再试（job-cancel）',
                jobId: started.job.id,
              });
            }
            // 响应发出后再跑（setImmediate），保证 job-start 不被动作同步吃住。
            table.launch(started.job.id);
            return send(res, 200, {
              ok: true,
              jobId: started.job.id,
              kind: started.job.kind,
              status: 'running',
              reused: started.reused === true,
              startedAt: started.job.startedAt,
            });
          }

          if (parsed.action === 'job-status' || parsed.action === 'job-cancel') {
            // sessionOptionalAction 例外：这两个动作没有 sessionId，靠 jobId 定位。
            const jobId = parsed.jobId;
            if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 80) {
              return send(res, 400, { ok: false, code: 'jobid', message: '缺少或非法的 jobId' });
            }
            const table = jobsTableOf(deps);
            if (table === null) return send(res, 404, noJobPayload());
            if (parsed.action === 'job-cancel') {
              const outcome = table.cancel(jobId);
              if (outcome === null) return send(res, 404, noJobPayload());
              return send(res, 200, {
                ok: true,
                cancelled: outcome.cancelled,
                jobId: outcome.job.id,
                status: outcome.job.status,
              });
            }
            const job = table.get(jobId);
            if (job === null) return send(res, 404, noJobPayload());
            return send(res, 200, jobStatusPayload(job));
          }

          if (parsed.action === 'client-error') {
            // 0.5.7：客户端传输/渲染侧失败留档（只校验 kind 短串，其它字段按契约裁剪）。
            recordClientError(deps, parsed, trigger);
            return send(res, 200, { ok: true });
          }

          if (parsed.action === 'handoff-preview') {
            // A1b：只生成草稿 + 就绪清单，不写盘/不建会话/不改历史。
            // 0.5.7：走兼容层；超时回 202 pending（带 jobId，客户端可接着轮询）。
            return await runCompat(deps, {
              kind: 'handoff-preview',
              sessionId: parsed.sessionId,
              agent,
              trigger,
              parsed,
              res,
            });
          }
          if (parsed.action === 'handoff') {
            // 0.4 P2-1：`edits` 只允许「约束」「下一步」两段（多余的段/非法类型由 actions 拒绝）。
            // 0.5.1 批 2：archive 缺省 true（0.5.0 行为）；confirmUnpin 只有用户确认「归档会取消置顶」时才传。
            // 0.5.7：走兼容层（edits/archive/confirmUnpin 原样进 job 参数）。
            return await runCompat(deps, {
              kind: 'handoff',
              sessionId: parsed.sessionId,
              agent,
              trigger,
              parsed,
              res,
            });
          }
          return send(res, 400, { ok: false, message: `未知动作：${String(parsed.action)}` });
        } catch (error) {
          try {
            const cancelled = error !== null && typeof error === 'object' && error.code === 'cancelled';
            const status = statusOf(error);
            // 0.5.6 A2：先留档再回包（回包可能因连接已断而抛，记录必须已经写下去）。
            // A 级动作已在 withActionEvent 里写过 end 行（带 EVENT_RECORDED_FLAG）→ 不重复写。
            let record = null;
            if (error !== null && typeof error === 'object' && error[EVENT_RECORDED_FLAG] === true) {
              // A 级动作已在 withActionEvent 里写过 end 行：沿用它的 id / 脱敏投影，不重复写。
              const recordedId = error[EVENT_FAILURE_ID_FLAG];
              const recordedRow = error[EVENT_FAILURE_ROW_FLAG];
              if (typeof recordedId === 'string' && recordedRow !== null && typeof recordedRow === 'object') {
                record = { id: recordedId, at: recordedRow.at ?? null, row: recordedRow };
              }
            } else {
              record = recordFailureEvent(deps, {
                action: parsed === null ? 'unknown' : parsed.action,
                trigger,
                error,
                sessionId: parsed === null ? undefined : parsed.sessionId,
                statusCode: status,
                cancelled,
                phase: 'http',
              });
            }
            const messageOverride = failureMessageOverride(error, status);
            sendFailure(res, status, error, {
              ...(record === null ? {} : { failureId: record.id, failure: record.row }),
              ...(cancelled ? { cancelled: true } : {}),
              ...(messageOverride === undefined ? {} : { message: messageOverride }),
            });
          } catch {
            /* 连接可能已断 */
          }
        }
      })();
    },
  });
  webCtx.effect(() => actionStop, 'compact-relay: action endpoint');
}
