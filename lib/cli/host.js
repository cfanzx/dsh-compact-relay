/**
 * debug CLI 的本机宿主发现 / 只读 GET（0.5.6 Phase A）。
 *
 * 安全边界（只读、仅本机）：
 *   - 只允许 127.0.0.1 / localhost / ::1（拒绝其它 host，不做内网探测）；
 *   - 只发 GET，**永不 POST**（不提供触发压缩/交接的入口）；
 *   - 超时 5s，失败不重试；
 *   - 不读 ~/.dsh/.credentials.yaml；token 只从 `--url` 的 query 里取；
 *   - 不打印 cookie/token（只打印「auth: cookie ok」）。
 */
import os from 'node:os';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * URL 是否指向本机回环。
 * @param {string} value
 * @returns {boolean}
 */
export function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 补全 `--url`：允许直接给 `http://127.0.0.1:60309` 或带 `?token=…`。
 * @param {string} value
 * @returns {string}
 */
export function normalizeBaseUrl(value) {
  const trimmed = String(value).trim();
  const withScheme = /^https?:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/u, '');
}

/**
 * 读 `--url` 里的 token（只用于换 cookie；不落盘、不打印）。
 * @param {string} url
 * @returns {string|null}
 */
export function tokenOf(url) {
  try {
    return new URL(url).searchParams.get('token');
  } catch {
    return null;
  }
}

/**
 * 用 launch token 换宿主 cookie（`GET /connect?token=…&interactions=none`）。
 * @param {string} baseUrl
 * @param {string} token
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean, status:number|null, cookie:string|null, error?:string}>}
 */
export async function exchangeToken(baseUrl, token, { timeoutMs = 5000 } = {}) {
  try {
    const response = await fetch(`${baseUrl}/connect?token=${encodeURIComponent(token)}&interactions=none`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const cookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter((value) => typeof value === 'string' && value.length > 0);
    if (!response.ok && response.status !== 302 && response.status !== 303) {
      return { ok: false, status: response.status, cookie: null, error: `connect ${response.status}` };
    }
    const cookie = cookies.map((entry) => String(entry).split(';')[0]).join('; ');
    return { ok: cookie.length > 0, status: response.status, cookie: cookie.length > 0 ? cookie : null };
  } catch (error) {
    return { ok: false, status: null, cookie: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 只读 GET JSON（仅回环；401/403 单独标记，便于 CLI 退出码 4）。
 *
 * @param {string} url
 * @param {{cookie?:string, timeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean, status:number|null, body:object|null, error?:string}>}
 */
export async function getJson(url, { cookie, timeoutMs = 5000 } = {}) {
  try {
    const headers = cookie === undefined || cookie === null || cookie.length === 0 ? {} : { cookie };
    const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: null, body: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 已知日志目录（本机只读；不存在就跳过）。 */
export function knownLogDirs() {
  const dirs = [];
  const home = os.homedir();
  const dshHome = process.env.DSH_HOME;
  if (typeof dshHome === 'string' && dshHome.trim().length > 0) dirs.push(`${dshHome.trim()}/logs`);
  else dirs.push(`${home}/.dsh/logs`);
  dirs.push(`${home}/Library/Logs/DeepSeek Harness`);
  return dirs;
}
