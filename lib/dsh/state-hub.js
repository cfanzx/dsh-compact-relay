/**
 * 状态推送中枢（M5）—— 让指示灯从「5 秒轮询」变成「有变化就推」。
 *
 * 数据源是 host 的 `session/event`（每条提交的会话事件都会触发一次），
 * 收到后对有订阅者的会话做一次去抖刷新（复用 readState），
 * 通过 SSE 推给浏览器半；浏览器断线会自动退回轮询（见 lib/client.js）。
 *
 * 只推「当前有订阅者的会话」，不给所有会话做无谓测量。
 *
 * A9：dsh 层不再反向 import actions/state —— readState 由装配层注入，
 * 这样 state-hub 可以脱离动作层单测，依赖方向回到 dsh → core。
 */

/** 事件去抖：一轮 turn 里事件很密，攒 150ms 只推一次。 */
const PUSH_DEBOUNCE_MS = 150;

/** SSE 心跳：防止中间层把空闲连接掐掉。 */
const HEARTBEAT_MS = 15_000;

const noop = () => {};

function writeFrame(res, text) {
  try {
    // res.write 返回 false 只是背压（状态帧 <1KB，几乎不会），不能当断线；
    // 真断了看 destroyed / writableEnded，或写入抛错。
    if (res.destroyed === true || res.writableEnded === true) return false;
    res.write(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{readState:(sessionId:string)=>Promise<object>}} input
 *   readState 由 index.js 注入（闭包持有 deps）。
 */
export function createStateHub({ readState }) {
  /** @type {Map<string, Set<object>>} sessionId → SSE 响应对象集合 */
  const clients = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} sessionId → 待触发的去抖定时器 */
  const timers = new Map();

  /** @type {Map<string, ReturnType<typeof setTimeout>>} 未就绪时的退避重试 */
  const retryTimers = new Map();

  const cancelRetry = (sessionId) => {
    const timer = retryTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      retryTimers.delete(sessionId);
    }
  };

  /**
   * 推一次状态；返回是否「就绪」（state.sessionId 非空）。
   * @returns {Promise<boolean>}
   */
  const pushNow = async (sessionId) => {
    const listeners = clients.get(sessionId);
    if (listeners === undefined || listeners.size === 0) return true;
    let state;
    try {
      state = await readState(sessionId);
    } catch {
      return false; // 测量失败就先不推，下一次事件/重试再试
    }
    const frame = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of [...listeners]) {
      if (!writeFrame(res, frame)) {
        listeners.delete(res);
      }
    }
    if (listeners.size === 0) clients.delete(sessionId);
    return state !== null && typeof state === 'object' && typeof state.sessionId === 'string';
  };

  /**
   * 会话还没加载/没 agent 时，SSE 首帧会拿到空状态；此后如果没有新的 session/event，
   * 浏览器就会一直停在「上下文未知」。所以这里做退避重试，直到拿到真数据。
   * （2026-10-19 真机踩过：重启后打开会话，只有发一条消息才恢复。）
   */
  const scheduleRetry = (sessionId, attempt = 0) => {
    if (!clients.has(sessionId)) return;
    if (retryTimers.has(sessionId)) return;
    const delay = Math.min(500 * 2 ** attempt, 5000);
    const timer = setTimeout(async () => {
      retryTimers.delete(sessionId);
      if (!clients.has(sessionId)) return;
      const ready = await pushNow(sessionId);
      if (!ready) scheduleRetry(sessionId, attempt + 1);
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    retryTimers.set(sessionId, timer);
  };

  const schedule = (sessionId) => {
    if (timers.has(sessionId)) return;
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      void pushNow(sessionId);
    }, PUSH_DEBOUNCE_MS);
    // 别让推送定时器拖住进程退出
    if (typeof timer.unref === 'function') timer.unref();
    timers.set(sessionId, timer);
  };

  /**
   * SSE 入口。`GET /api/compact-relay-stream?sessionId=...`
   * @param {object} req
   * @param {object} res
   */
  const serve = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const sessionId = url.searchParams.get('sessionId') ?? '';
    if (sessionId.length === 0) {
      try {
        res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, message: '缺少 sessionId' }));
      } catch {
        /* 连接已断 */
      }
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    writeFrame(res, ': connected\n\n');

    const listeners = clients.get(sessionId) ?? new Set();
    listeners.add(res);
    clients.set(sessionId, listeners);

    const heartbeat = setInterval(() => {
      if (!writeFrame(res, ': ping\n\n')) close();
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      listeners.delete(res);
      if (listeners.size === 0 && clients.get(sessionId) === listeners) clients.delete(sessionId);
    }
    req.on('close', close);
    req.on('error', close);
    res.on('close', close);
    res.on('error', close);

    void pushNow(sessionId).then((ready) => {
      // 首帧还没就绪（会话刚打开/还没 agent）→ 退避重试，别让界面一直停在「未知」。
      if (!ready) scheduleRetry(sessionId);
    });
  };

  /**
   * 订阅 host 的 session/event：只对「有人订阅的会话」安排推送。
   * @param {object} session
   * @param {object} _event
   */
  const onSessionEvent = (session, _event) => {
    const sessionId = session !== null && typeof session === 'object' ? session.id : undefined;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (clients.has(sessionId)) {
      cancelRetry(sessionId);
      schedule(sessionId);
    }
  };

  /** 设置保存后立刻让所有订阅者重读一次状态（颜色/阈值马上变）。 */
  const refreshAll = () => {
    for (const sessionId of [...clients.keys()]) {
      cancelRetry(sessionId);
      schedule(sessionId);
    }
  };

  const close = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    for (const listeners of clients.values()) {
      for (const res of listeners) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
    clients.clear();
  };

  return { serve, onSessionEvent, refreshAll, close, noop };
}

export default createStateHub;
