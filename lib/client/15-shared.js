
    /**
     * 跨片段共享的浮层 / 指示灯环小部件（30-indicator 与 50-settings 共用）。
     *
     * 为什么单独一个片段：这些几何/材质在「指示灯」和「设置页教学卡片」里各画过一遍，
     * 以前是两份点坐标/弧线 path/原生线刻度/闪烁 keyframes。放在 15 号片段（按文件名
     * 排序在 10-runtime 之后、20-format/30-indicator/50-settings 之前），函数声明会
     * 提升，后面的片段可直接调用；常量在使用点（组件渲染时）早已初始化。
     */

    /**
     * 复制文本到剪贴板（0.5.6 A）——形态照抄 30-indicator 的「复制路径」与
     * 50-settings 的 copyDiagnostics：navigator.clipboard?.writeText + Promise 兜底。
     * @param {string} text
     * @returns {Promise<void>}
     */
    function copyTextToClipboard(text) {
      try {
        const written = navigator.clipboard?.writeText(String(text));
        return written !== undefined && typeof written.then === 'function' ? written : Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }

    /**
     * 失败响应的「复制诊断」文本（0.5.6 A3）——服务端已经脱敏（failure = exportRowOf），
     * 客户端只拼装，不额外读任何本机数据。
     * @param {object} data POST /api/compact-relay-action 的响应 body
     * @returns {string}
     */
    function failureClipboardTextOf(data) {
      const failure =
        data !== null && typeof data === 'object' && data.failure !== null && typeof data.failure === 'object'
          ? data.failure
          : null;
      const code = failure !== null && typeof failure.code === 'string' ? failure.code : data?.code ?? 'internal';
      const message =
        failure !== null && typeof failure.message === 'string'
          ? failure.message
          : data !== null && typeof data === 'object' && typeof data.message === 'string'
            ? data.message
            : '（服务端未给出）';
      const action = failure !== null && typeof failure.action === 'string' ? failure.action : '未知动作';
      const lines = [`[dcr] ${action} 失败`, `code: ${code}`, `message: ${message}`];
      if (failure !== null) {
        const id = typeof failure.id === 'string' ? failure.id : typeof data?.failureId === 'string' ? data.failureId : '?';
        if (typeof failure.at === 'string') lines.push(`at: ${failure.at}  id: ${id}`);
        if (typeof failure.trigger === 'string') lines.push(`trigger: ${failure.trigger}`);
        if (typeof failure.sessionId === 'string' && failure.sessionId.length > 0) lines.push(`session: ${failure.sessionId}`);
        if (failure.context !== null && typeof failure.context === 'object' && typeof failure.context.note === 'string') {
          lines.push(`context: ${failure.context.note}`);
        }
        if (typeof failure.durationMs === 'number' && Number.isFinite(failure.durationMs)) {
          lines.push(`duration: ${failure.durationMs}ms  outcome: ${failure.outcome ?? 'fail'}`);
        }
      }
      lines.push('记录文件：$DSH_HOME/compact-relay-events.jsonl');
      return lines.join('\n');
    }

    /**
     * 失败 toast 的入参：响应里带 failureId/failure 时升级成「带复制按钮」的对象形态，
     * 否则保持纯字符串（与旧行为逐字一致）。
     * @param {string} text
     * @param {object} data
     * @returns {string|{text:string, copy:string}}
     */
    function withFailureCopy(text, data) {
      const hasFailure =
        data !== null &&
        typeof data === 'object' &&
        (typeof data.failureId === 'string' || (data.failure !== null && typeof data.failure === 'object'));
      return hasFailure ? { text, copy: failureClipboardTextOf(data) } : text;
    }

    /* ------------------------------------------------------------------ *
     * 0.5.7 长动作异步化（架构 §6）：job 轮询 + 客户端错误留档
     *
     * 服务端把 >3s 的动作拆成三个短动作（job-start / job-status / job-cancel）；
     * 兼容层 15s 没跑完会回 202 ok:false,code:'pending',pending:true,jobId。
     * 客户端从不把 pending 当成功：拿到 jobId 后一律轮询到 done/error/cancelled。
     * ------------------------------------------------------------------ */

    /** 轮询间隔（架构 §6）：0ms 首轮 + 500ms，总时长上限 5min。 */
    const JOB_POLL_INTERVAL_MS = 500;
    const JOB_POLL_MAX_MS = 5 * 60_000;
    /** client-error 的 bodyHead 上限 = 事件 context 值上限（80 码点）。 */
    const CLIENT_ERROR_BODY_HEAD_MAX_CHARS = 80;

    /** 按码点截断（不切坏 emoji）；上限非法时回落到 bodyHead 的 80。 */
    function clipCodePoints(text, max) {
      const value = typeof text === 'string' ? text : '';
      const limit = Number.isInteger(max) && max > 0 ? max : CLIENT_ERROR_BODY_HEAD_MAX_CHARS;
      // 快速路径：码元数 ≤ 上限时码点数必然也 ≤ 上限。
      if (value.length <= limit) return value;
      return Array.from(value).slice(0, limit).join('');
    }

    /** 动作/轮询失败：带 code/status 的 Error（run() 的 catch 按 code 分流）。 */
    function jobFailure(code, message, status) {
      const error = new Error(typeof message === 'string' && message.length > 0 ? message : '任务失败');
      error.code = typeof code === 'string' && code.length > 0 ? code : 'job';
      if (Number.isInteger(status)) error.status = status;
      return error;
    }

    /** 本地取消：抛 name='AbortError'（沿用 0.5.6 的取消判定，不新增错误出口）。 */
    function jobAbortError() {
      const error = new Error('已取消');
      error.name = 'AbortError';
      return error;
    }

    function jobSignalAborted(signal) {
      return signal !== null && typeof signal === 'object' && signal.aborted === true;
    }

    /** 可被 abort 打断的等待（不残留 timer；signal 在测试替身里可能不存在）。 */
    function waitForJobPoll(ms, signal) {
      return new Promise((resolve, reject) => {
        let timer = null;
        const onAbort = () => {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          reject(jobAbortError());
        };
        if (signal !== null && typeof signal === 'object' && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true });
        }
        timer = setTimeout(() => {
          if (signal !== null && typeof signal === 'object' && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        }, ms);
      });
    }

    /**
     * 读 action 响应：优先取原文（client-error 的 bodyHead 用前 80 码点），
     * 测试替身只有 json() 时回退；两者都失败 → {data:null, bodyHead:''}。
     * @param {object} res fetch 的 Response（或测试替身）
     * @returns {Promise<{data:any, bodyHead:string}>}
     */
    async function readActionBody(res) {
      if (res !== null && res !== undefined && typeof res === 'object' && typeof res.text === 'function') {
        let text = '';
        try {
          text = await res.text();
        } catch {
          text = '';
        }
        if (typeof text === 'string' && text.length > 0) {
          try {
            return { data: JSON.parse(text), bodyHead: text };
          } catch {
            return { data: null, bodyHead: text };
          }
        }
        return { data: null, bodyHead: '' };
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      let bodyHead = '';
      if (data !== null && typeof data === 'object') {
        try {
          bodyHead = JSON.stringify(data);
        } catch {
          bodyHead = '';
        }
      }
      return { data, bodyHead };
    }

    /**
     * 轮询一个 job 到终态（架构 §6：0ms 首轮 + 500ms + 5min 上限）。
     *
     *   - done                → 返回 job 的 result（旧同步动作的成功响应体，逐字段不变）
     *   - error / cancelled   → 抛 {code:'cancelled'|…, message, status}
     *   - 404 nojob           → 抛 code:'nojob'（宿主重启会清空内存任务表，调用方提示重试）
     *   - 5min 未结束         → 抛 code:'timeout'
     *
     * 0ms 首轮是刻意的：刚起/已结束的任务（以及测试 mock 的首轮 done）立即命中，
     * 调用方不用先等一个 500ms。onTick 每轮带 elapsedMs 回调，进度 toast 只显示「已 Ns」。
     *
     * @param {string} jobId
     * @param {{signal?:object, onTick?:(tick:{elapsedMs:number,status:string})=>void}} [options]
     * @returns {Promise<any>}
     */
    async function pollJob(jobId, options = {}) {
      const signal = options.signal;
      const onTick = typeof options.onTick === 'function' ? options.onTick : null;
      const startedAt = Date.now();
      let wait = 0;
      for (;;) {
        if (jobSignalAborted(signal)) throw jobAbortError();
        if (Date.now() - startedAt > JOB_POLL_MAX_MS) {
          throw jobFailure('timeout', '任务超过 5 分钟仍未结束（可稍后在事件记录里查看结果）', 0);
        }
        if (wait > 0) await waitForJobPoll(wait, signal);
        if (jobSignalAborted(signal)) throw jobAbortError();
        let res = null;
        try {
          res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'job-status', jobId }),
            ...(signal === undefined || signal === null ? {} : { signal }),
          });
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.name === 'AbortError') throw error;
          throw jobFailure('network', '读取任务状态失败：' + (error && error.message ? String(error.message) : '未知错误'), 0);
        }
        const { data, bodyHead } = await readActionBody(res);
        if (res.status === 404 && data !== null && typeof data === 'object' && data.code === 'nojob') {
          const nojob = jobFailure('nojob', data.message ? String(data.message) : '任务不存在或已过期，请重试', 404);
          nojob.bodyHead = bodyHead;
          throw nojob;
        }
        if (!res.ok) {
          const failure = jobFailure(
            data !== null && typeof data === 'object' && typeof data.code === 'string' ? data.code : 'http',
            data !== null && typeof data === 'object' && typeof data.message === 'string'
              ? data.message
              : `读取任务状态失败（HTTP ${res.status}）`,
            res.status,
          );
          failure.bodyHead = bodyHead;
          throw failure;
        }
        if (data === null || typeof data !== 'object') {
          const empty = jobFailure('empty', '任务状态响应为空', res.status);
          empty.bodyHead = bodyHead;
          throw empty;
        }
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        if (onTick !== null) onTick({ elapsedMs, status: typeof data.status === 'string' ? data.status : 'running' });
        if (data.status === 'done') return data.result;
        if (data.status === 'cancelled') {
          const cancelled = jobFailure(
            'cancelled',
            data.error !== null && typeof data.error === 'object' && typeof data.error.message === 'string'
              ? data.error.message
              : '任务已取消',
            res.status,
          );
          throw cancelled;
        }
        if (data.status === 'error') {
          const failure = jobFailure(
            data.error !== null && typeof data.error === 'object' && typeof data.error.code === 'string'
              ? data.error.code
              : 'job',
            data.error !== null && typeof data.error === 'object' && typeof data.error.message === 'string'
              ? data.error.message
              : '任务失败',
            res.status,
          );
          throw failure;
        }
        // running（或未知状态）：继续轮询，间隔 500ms。
        wait = JOB_POLL_INTERVAL_MS;
      }
    }

    /** 同一次失败只 report 一次：调用方每次操作给一个 token（对象身份）。 */
    const reportedClientErrors = typeof WeakSet === 'function' ? new WeakSet() : null;

    /**
     * 客户端错误留档（0.5.7，B 级动作 client-error）。
     * 只上报传输/渲染侧失败（fetch 抛错 / 非 2xx / 空 body / 404 nojob / 超时），
     * bodyHead 先按码点 clip 到 80（服务端 context 上限），同一次失败只报一次。
     * 永不 reject——上报失败不影响主流程。
     *
     * @param {{kind?:string,status?:number,bodyHead?:string,code?:string,message?:string,sessionId?:string,token?:object}} [details]
     * @returns {Promise<boolean>} 是否真的发出并拿到 2xx
     */
    function reportClientError(details = {}) {
      const source = details !== null && typeof details === 'object' ? details : {};
      const token = source.token;
      if (token !== null && typeof token === 'object' && reportedClientErrors !== null) {
        if (reportedClientErrors.has(token)) return Promise.resolve(false);
        reportedClientErrors.add(token);
      }
      const body = {
        action: 'client-error',
        kind: typeof source.kind === 'string' && source.kind.trim().length > 0 ? clipCodePoints(source.kind.trim(), 40) : 'unknown',
      };
      if (Number.isInteger(source.status) && source.status >= 0) body.status = source.status;
      if (typeof source.bodyHead === 'string' && source.bodyHead.length > 0) {
        body.bodyHead = clipCodePoints(source.bodyHead, CLIENT_ERROR_BODY_HEAD_MAX_CHARS);
      }
      if (typeof source.code === 'string' && source.code.length > 0) body.code = clipCodePoints(source.code, 60);
      if (typeof source.message === 'string' && source.message.length > 0) body.message = source.message.slice(0, 500);
      if (typeof source.sessionId === 'string' && source.sessionId.length > 0) body.sessionId = source.sessionId;
      try {
        return fetch('/api/compact-relay-action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(
          (res) => res !== null && typeof res === 'object' && res.ok === true,
          () => false,
        );
      } catch {
        return Promise.resolve(false);
      }
    }

    /**
     * 环上比例 → SVG 坐标（viewBox 0 0 20 20，圆心 10,10，半径用 10-runtime 的 RADIUS）。
     * @param {number} value 0–1 的比例
     * @returns {[number, number]}
     */
    function ringPoint(value) {
      const angle = value * Math.PI * 2 - Math.PI / 2;
      return [10 + RADIUS * Math.cos(angle), 10 + RADIUS * Math.sin(angle)];
    }

    /**
     * 环上两比例之间的弧线 path（0.5 以上用大弧标志）。
     * @param {number} from
     * @param {number} to
     * @returns {string}
     */
    function ringArcPath(from, to) {
      const [x1, y1] = ringPoint(from);
      const [x2, y2] = ringPoint(to);
      const large = to - from > 0.5 ? 1 : 0;
      return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
    }

    /**
     * DSH 原生自动压缩线的「径向刻度」：穿过环带的一条短线（内 5.6 → 外 9.6）。
     * 指示灯与设置页教学图用同一套几何，只是描边/属性不同。
     * @param {number} value 合法的原生阈值比例（0.02–1 之间，调用方先校验）
     * @returns {{x1:number, y1:number, x2:number, y2:number}}
     */
    function nativeTickAt(value) {
      const angle = value * Math.PI * 2 - Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return { x1: 10 + 5.6 * cos, y1: 10 + 5.6 * sin, x2: 10 + 9.6 * cos, y2: 10 + 9.6 * sin };
    }

    /** 越过原生自动压缩线后「整环红色闪烁」的 keyframes（指示灯/教学图共用一份）。 */
    const NATIVE_ALERT_CSS = '@keyframes cr-native-alert { 0%,100% { opacity: 1 } 50% { opacity: 0.15 } } @media (prefers-reduced-motion: reduce) { [data-cr-native-alert] { animation: none !important; opacity: 0.85 !important; } }';

    /**
     * 浮层外观（菜单 / 悬停卡 / 确认卡 / 交接单面板 / 历史面板 / toast 共用）。
     * 主题色由 10-runtime 的 detectTheme() 给出（BUG-001：优先 DSH 主题 token）。
     * @param {object} theme detectTheme() 的返回值
     * @returns {{background:string, backdropFilter:string, WebkitBackdropFilter:string, border:string, boxShadow:string}}
     */
    function panelChrome(theme) {
      return {
        background: theme.panelBg,
        backdropFilter: theme.panelBackdrop,
        WebkitBackdropFilter: theme.panelBackdrop,
        border: `1px solid ${theme.panelBorder}`,
        boxShadow: theme.panelShadow,
      };
    }
