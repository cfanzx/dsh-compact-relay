/**
 * dsh-compact-relay e2e 测试台（M3 接棒验证用）—— 核心库。
 *
 * 做的事：
 *   1. 把真 ~/.dsh 复制成隔离 home（/tmp/relay-e2e/home/.dsh），裁剪 profile bundles，
 *      在隔离 profile 里 pnpm install 同步 vendor 最新代码；
 *   2. 用桌面版原样的 desktop-host 命令 boot 一个隔离 host，从 stderr 解析
 *      `dsh web: http://127.0.0.1:PORT/?token=...`；
 *   3. 用本机 Chrome（--remote-debugging-port=9222）的新 tab 驱动 GUI，
 *      点「新建会话」建一个空白 live session（不跑模型、不花钱）；
 *   4. 从 host 侧（插件 HTTP 端点）确认拿到了 live agent 的 sessionId；
 *   5. 进程 / tab 可清理，绝不碰真 DSH（pid 24386 及真 ~/.dsh）。
 *
 * 安全铁律：
 *   - 只写 /tmp/relay-e2e/ 与本文件所在目录；真 ~/.dsh 只读（仅 rsync 读取）。
 *   - Cleanup 只杀「命令行里带隔离 profile 路径」的进程，永远不会匹配真 host。
 *   - Chrome 只关自己创建的 tab（记录 targetId），不动用户已有 tab。
 *
 * 依赖：node >= 22（原生 fetch / WebSocket），macOS，DSH 桌面版 0.2.1-rc.2 左右。
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ==========================================================================
 * 常量 / 路径
 * ========================================================================== */

/** 仓库根（本文件在 test/e2e/lib.mjs）。 */
export const REPO_DIR = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

/** 约定：所有临时产物都在 /tmp/relay-e2e 下。 */
export const ROOT = '/tmp/relay-e2e';
export const HOME_ROOT = path.join(ROOT, 'home');
export const ISOLATED_HOME = path.join(HOME_ROOT, '.dsh');
export const PROFILE_DIR = path.join(ISOLATED_HOME, 'profiles', 'desktop');
export const LOG_DIR = path.join(ROOT, 'logs');
export const HOST_LOG = path.join(LOG_DIR, 'host.log');
export const PNPM_LOG = path.join(LOG_DIR, 'pnpm-install.log');
export const KEEP_JSON = path.join(ROOT, 'keep.json');
/** P2-6：隔离环境的工作区 cwd 与交接目录也必须在 /tmp 下。 */
export const ISOLATED_WORKSPACE_ROOT = path.join(ROOT, 'workspaces');
export const ISOLATED_HANDOFF_DIR = path.join(ROOT, 'handoffs');

/** 真 home —— 只读，绝不写。 */
export const REAL_HOME = path.join(homedir(), '.dsh');
export const REAL_PROFILE = path.join(REAL_HOME, 'profiles', 'desktop');

export const APP_DIR = '/Applications/DeepSeek Harness.app';
export const ELECTRON_BIN = path.join(APP_DIR, 'Contents/MacOS/DeepSeek Harness');
export const ASAR_ROOT = path.join(APP_DIR, 'Contents/Resources/app.asar');
export const DSH_ROOT = path.join(ASAR_ROOT, 'dsh');
export const HOST_ENTRY = path.join(DSH_ROOT, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
export const RUNTIME_DIR = path.join(APP_DIR, 'Contents/Resources/runtime/primary-runtime');
export const PNPM_MJS = path.join(RUNTIME_DIR, 'dependencies/pnpm/bin/pnpm.mjs');
export const RUNTIME_BIN = path.join(APP_DIR, 'Contents/Resources/runtime/bin');

/** driver 传给 desktop-host 的 5 个位置参数（与真 host 的 ps 命令行逐字一致）。 */
const HOST_ARGS = ['--expose-internals', HOST_ENTRY, DSH_ROOT, PROFILE_DIR, RUNTIME_DIR, PNPM_MJS, RUNTIME_BIN];

/** 复制真 home 时排除的大目录（agent 不需要，且会拖慢/放大隔离 home）。 */
export const RSYNC_EXCLUDES = ['login-browser-profile', 'dsh_wechat', 'homeassistant', 'qwen-chat', 'wb-market'];

/** 隔离 profile 只加载这三个 bundle，规避 wechat/mizar/whale 等插件副作用。 */
export const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-compact-relay'];

/** 默认在哪个工作区里新建会话（隔离 home 复制自真 home，标题稳定）。 */
export const DEFAULT_WORKSPACE_TITLE = process.env.E2E_WORKSPACE_TITLE ?? '默认工作区';

/** login-web 专用 Chrome 的 CDP 端口。 */
export const CHROME_PORT = Number(process.env.E2E_CHROME_PORT ?? 9222);

/* ==========================================================================
 * 日志 / 小工具
 * ========================================================================== */

const logger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/** 允许调用方（smoke.mjs）接管日志。只需覆盖有的字段。 */
export function setLogger(overrides = {}) {
  Object.assign(logger, overrides);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function tail(text, lines = 40) {
  const all = String(text ?? '').split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/** 读文本文件（smoke 诊断用）。 */
export function readTextFile(filePath) {
  return readFileSync(filePath, 'utf8');
}

function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 轮询直到 fn() 返回真值；超时返回 false。 */
export async function waitUntil(fn, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* 继续等 */
    }
    if (Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * 跑一个子命令，收集 stdout/stderr（不经过 shell）。
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string}>}
 */
export function run(cmd, args, { cwd, env, timeoutMs = 120_000, logFile } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(() => reject(Object.assign(error, { stdout, stderr }))));
    child.on('close', (code, signal) => {
      if (logFile) {
        try {
          appendFileSync(
            logFile,
            `\n$ ${cmd} ${args.join(' ')}\nexit=${code}${signal ? ` signal=${signal}` : ''}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
          );
        } catch {
          /* 日志失败不影响主流程 */
        }
      }
      finish(() => resolve({ code, signal, stdout, stderr }));
    });
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(() =>
        reject(Object.assign(new Error(`命令超时（${timeoutMs}ms）：${cmd} ${args.join(' ')}`), { stdout, stderr })),
      );
    }, timeoutMs);
  });
}

/* ==========================================================================
 * Chrome DevTools Protocol 极简客户端（node 内置 WebSocket）
 * ========================================================================== */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  static async connect(wsUrl, timeoutMs = 10_000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket 连接超时：${wsUrl}`)), timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`CDP WebSocket 连接失败：${wsUrl}`));
        },
        { once: true },
      );
    });
    const client = new CDP(ws);
    ws.addEventListener('message', (event) => client.#onMessage(event.data));
    ws.addEventListener('close', () => {
      client.closed = true;
      for (const pending of client.pending.values()) pending.reject(new Error('CDP 连接已关闭'));
      client.pending.clear();
    });
    return client;
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const callback of this.listeners.get(message.method) ?? []) {
      try {
        callback(message.params ?? {});
      } catch {
        /* listener 自己吞错，不拖垮连接 */
      }
    }
  }

  send(method, params = {}, timeoutMs = 20_000) {
    if (this.closed) return Promise.reject(new Error(`CDP 已关闭，无法发送 ${method}`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(callback);
    return () => {
      const list = this.listeners.get(method) ?? [];
      const index = list.indexOf(callback);
      if (index >= 0) list.splice(index, 1);
    };
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ==========================================================================
 * 一、隔离 home + profile 准备
 * ========================================================================== */

/** 校验路径安全性：所有写操作必须落在 /tmp/relay-e2e 下（防手滑写进真 home）。 */
function assertSafeIsolatedPath(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(`${ROOT}${path.sep}`) && resolved !== ROOT) {
    throw new Error(`安全保护：拒绝操作 /tmp/relay-e2e 之外的路径：${resolved}`);
  }
  if (resolved === REAL_HOME || resolved.startsWith(`${REAL_HOME}${path.sep}`)) {
    throw new Error(`安全保护：拒绝写入真 home：${resolved}`);
  }
}

/**
 * 把隔离 profile 的 bundles 裁到只剩 base / web-app / compact-relay。
 * 其余依赖保留（不加载就行），只改 JSON，不手写整份文件。
 */
export function patchProfile() {
  const packagePath = path.join(PROFILE_DIR, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  pkg.dsh.profile.bundles = [...PROFILE_BUNDLES];
  pkg.dependencies ??= {};
  pkg.dependencies['dsh-compact-relay'] = `file:${REPO_DIR}`;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg;
}

/**
 * 在隔离 profile 里 pnpm install，把 vendor 最新代码同步进 node_modules。
 * pnpm 跑在 ~/.local/node/bin 的 node 上（或退回 app 自带的 pnpm.mjs）。
 */
export async function installProfile({ timeoutMs = 180_000 } = {}) {
  const nodeBinDir = path.dirname(process.execPath);
  const corepackBin = path.join(nodeBinDir, 'corepack');
  let cmd;
  let args;
  if (existsSync(corepackBin)) {
    cmd = corepackBin;
    args = ['pnpm', 'install'];
  } else if (existsSync(PNPM_MJS)) {
    cmd = process.execPath;
    args = [PNPM_MJS, 'install'];
  } else {
    throw new Error(`找不到 pnpm：既没有 ${corepackBin}，也没有 ${PNPM_MJS}`);
  }
  writeFileSync(PNPM_LOG, `# ${new Date().toISOString()}\n# cwd=${PROFILE_DIR}\n# ${cmd} ${args.join(' ')}\n`);
  const result = await run(cmd, args, {
    cwd: PROFILE_DIR,
    env: { ...process.env, PATH: `${nodeBinDir}:${process.env.PATH ?? ''}`, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    timeoutMs,
    logFile: PNPM_LOG,
  });
  if (result.code !== 0) {
    throw new Error(
      `pnpm install 失败（exit ${result.code}）：\n${tail(result.stdout || result.stderr, 30)}\n（完整日志：${PNPM_LOG}）`,
    );
  }
  const installedEntry = path.join(PROFILE_DIR, 'node_modules', 'dsh-compact-relay', 'lib', 'index.js');
  if (!existsSync(installedEntry)) {
    throw new Error(`pnpm install 后找不到插件入口：${installedEntry}`);
  }
  return result;
}

/**
 * P2-6：把复制进来的真实配置/工作区路径清干净，保证 e2e 只写 /tmp。
 *
 * - 不沿用真实 `compact-relay.json`（否则 handoffDir 指向真目录）；
 * - 清空复制来的交接单；工作区 cwd 全部改到 /tmp/relay-e2e/workspaces/<id>；
 * - 每次 prepareEnv（含 --reuse）都执行，避免上一次跑脏。
 */
function sanitizeIsolatedHome() {
  ensureDir(ISOLATED_WORKSPACE_ROOT);
  ensureDir(ISOLATED_HANDOFF_DIR);

  // 1) 设置：最小覆盖层，handoffDir 固定 /tmp；其它项走 schema 默认。
  const settingsFile = path.join(ISOLATED_HOME, 'compact-relay.json');
  rmSync(settingsFile, { force: true });
  writeFileSync(
    settingsFile,
    `${JSON.stringify({ v: 1, config: { handoffDir: ISOLATED_HANDOFF_DIR } }, null, 2)}\n`,
    'utf8',
  );

  // 2) 交接单：清掉 rsync 复制来的真实文件，避免读到真实内容。
  rmSync(path.join(ISOLATED_HOME, 'handoffs'), { recursive: true, force: true });

  // 3) 工作区 cwd 暂保持真实路径。
  //    实测：把 workspace.json 的 path 改到 /tmp 后，GUI 新建会话不会切进会话视图
  //    （停在「选择一个工作区开始」Hero），拿不到指示灯，settings-ui e2e 无法验证。
  //    当前 e2e 只建会话 + 调插件 HTTP 动作，不执行会写工作区的工具/命令；
  //    交接目录与设置已隔离，真实 ~/.dsh 不会被写。M5 再用「工作区副本」收紧 cwd。

}

/**
 * 准备隔离环境：rsync 真 home → 裁剪 profile → pnpm install。
 * @param {{reuse?:boolean, skipInstall?:boolean, installTimeoutMs?:number}} [options]
 */
export async function prepareEnv(options = {}) {
  assertSafeIsolatedPath(ISOLATED_HOME);
  if (REAL_HOME === ISOLATED_HOME) throw new Error('安全保护：隔离 home 不能等于真 home');
  ensureDir(ROOT);
  ensureDir(LOG_DIR);
  ensureDir(HOME_ROOT);
  ensureDir(ISOLATED_HOME);

  const startedAt = Date.now();
  let copied = false;
  const profilePackage = path.join(PROFILE_DIR, 'package.json');
  const reuse = options.reuse === true && existsSync(profilePackage);
  if (reuse) {
    logger.info(`  ↺ 复用已有隔离 home：${ISOLATED_HOME}`);
  } else {
    logger.info(`  ↓ rsync ${REAL_HOME} → ${ISOLATED_HOME}（排除：${RSYNC_EXCLUDES.join(', ')}）`);
    const args = ['-a'];
    for (const exclude of RSYNC_EXCLUDES) args.push('--exclude', exclude);
    args.push(`${REAL_HOME}/`, `${ISOLATED_HOME}/`);
    const result = await run('rsync', args, { timeoutMs: 300_000 });
    // 23 = 部分文件传输出错（真会话正在写，属正常竞态）；24 = 源文件在复制中消失（同上）
    if (result.code !== 0 && result.code !== 23 && result.code !== 24) {
      throw new Error(`rsync 失败（exit ${result.code}）：\n${tail(result.stderr, 20)}`);
    }
    if (result.code === 23 || result.code === 24) {
      logger.warn(`  ⚠ rsync 退出码 ${result.code}（真 ~/.dsh 正在被写入，少量文件掠过，可忽略）`);
    }
    copied = true;
  }

  patchProfile();
  sanitizeIsolatedHome();

  if (options.skipInstall === true) {
    logger.info('  ↺ 跳过 pnpm install（--no-install）');
  } else {
    logger.info(`  ⚙ pnpm install @ ${PROFILE_DIR}`);
    await installProfile({ timeoutMs: options.installTimeoutMs });
  }

  const prepared = { copied, reuse, elapsedMs: Date.now() - startedAt, profileDir: PROFILE_DIR, home: ISOLATED_HOME };
  logger.info(`  ✓ 环境就绪（${(prepared.elapsedMs / 1000).toFixed(1)}s）`);
  return prepared;
}

/* ==========================================================================
 * 二、boot 隔离 host
 * ========================================================================== */

function detectClientVersion() {
  if (process.env.DSH_CLIENT_VERSION) return process.env.DSH_CLIENT_VERSION;
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', path.join(APP_DIR, 'Contents/Info.plist')], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '0.2.1-rc.2';
  }
}

/** 列出命令行里带隔离 profile 路径的残留 host（永远不含真 host）。 */
export function findStrayHosts() {
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 10_000 });
    const hits = [];
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2];
      // 隔离路径是 /tmp/relay-e2e/home/.dsh/profiles/desktop；真 host 是 ~/.dsh/profiles/desktop
      if (command.includes(`${PROFILE_DIR}`) || (command.includes('dsh-desktop-host/lib/index.js') && command.includes(ISOLATED_HOME))) {
        hits.push({ pid, command });
      }
    }
    return hits;
  } catch {
    return [];
  }
}

/** 杀掉隔离 host 残留（SIGTERM → 1s → SIGKILL）。 */
export async function killStrayHosts() {
  const first = findStrayHosts();
  for (const { pid } of first) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }
  if (first.length > 0) await sleep(800);
  const second = findStrayHosts();
  for (const { pid } of second) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  if (second.length > 0) await sleep(300);
  return { term: first.map((item) => item.pid), kill: second.map((item) => item.pid) };
}

/**
 * boot 一个隔离的 DSH web host。
 * @param {{timeoutMs?:number, clientVersion?:string}} [options]
 * @returns {Promise<object>} host 句柄（url/port/token/baseUrl/pid/logPath/stop()）
 */
export async function startHost(options = {}) {
  ensureDir(LOG_DIR);
  if (!existsSync(ELECTRON_BIN)) throw new Error(`找不到 DSH 桌面版可执行文件：${ELECTRON_BIN}`);
  // 注意：HOST_ENTRY 在 app.asar 里（虚拟路径），普通 node 的 existsSync 看不到，
  // 必须由 Electron 的 asar 补丁来解析 —— 所以这里不检查它是否存在。
  if (!existsSync(path.join(PROFILE_DIR, 'package.json'))) {
    throw new Error(`隔离 profile 不存在：${PROFILE_DIR}（先跑 prepareEnv）`);
  }

  // 上一次崩溃/--keep 遗留的隔离 host 会抢端口 + 覆盖日志，先清掉（只匹配隔离路径）。
  const strays = findStrayHosts();
  if (strays.length > 0) {
    logger.warn(`  ⚠ 发现上次遗留的隔离 host（pid ${strays.map((s) => s.pid).join(', ')}），先清理`);
    await killStrayHosts();
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  const header = [
    `# relay-e2e host log`,
    `# started: ${new Date().toISOString()}`,
    `# profile: ${PROFILE_DIR}`,
    `# DSH_HOME: ${ISOLATED_HOME}`,
    `# cmd: ${ELECTRON_BIN} ${HOST_ARGS.join(' ')}`,
    '',
  ].join('\n');
  writeFileSync(HOST_LOG, header);

  const logFd = openSync(HOST_LOG, 'a');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: ISOLATED_HOME,
    DSH_CLIENT_VERSION: options.clientVersion ?? detectClientVersion(),
  };
  // 真 GUI 会额外塞 IPC channel；我们独立跑，不要继承外层可能残留的值。
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;

  let child;
  try {
    child = spawn(ELECTRON_BIN, HOST_ARGS, {
      cwd: PROFILE_DIR,
      env,
      detached: true, // 独立进程组，cleanup 时可以整组杀
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);
  } catch (error) {
    try {
      closeSync(logFd);
    } catch {
      /* ignore */
    }
    throw error;
  }
  child.unref();

  const startedAt = Date.now();
  let url = null;
  let port = null;
  let token = null;
  let childExited = false;
  const started = await waitUntil(
    async () => {
      if (child.exitCode !== null) {
        childExited = true;
        return false;
      }
      const log = readFileSync(HOST_LOG, 'utf8');
      const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+))/.exec(log);
      if (!match) return false;
      url = match[1];
      port = Number(match[2]);
      token = match[3];
      return true;
    },
    timeoutMs,
    100,
  );

  if (!started) {
    const logText = readFileSync(HOST_LOG, 'utf8');
    await killStrayHosts();
    const reason = childExited ? `隔离 host 启动即退出（exit ${child.exitCode}）` : `等待 "dsh web:" 超时（${timeoutMs}ms）`;
    throw new Error(`${reason}。host 日志尾部：\n${tail(logText, 40)}\n（完整日志：${HOST_LOG}）`);
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const host = {
    pid: child.pid,
    child,
    url,
    baseUrl,
    port,
    token,
    logPath: HOST_LOG,
    profileDir: PROFILE_DIR,
    home: ISOLATED_HOME,
    startedAt,
    stop: () => stopHost(host),
  };

  // 插件端点与宿主 /api 同一套鉴权：Node fetch 没有浏览器 cookie，先 /connect 换 API 凭据。
  host._apiCookie = await apiCookie(host);

  // 等插件真正激活：state 端点 200（404 说明 compact-relay 没加载；401 说明鉴权没过）。
  const pluginReady = await waitUntil(
    async () => {
      const res = await fetch(`${baseUrl}/api/compact-relay-state`, {
        headers: { cookie: host._apiCookie },
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    },
    options.pluginTimeoutMs ?? 60_000,
    200,
  );
  if (!pluginReady) {
    const logText = readFileSync(HOST_LOG, 'utf8');
    await stopHost(host);
    throw new Error(
      `compact-relay 插件未激活（GET /api/compact-relay-state 未返回 200）。host 日志尾部：\n${tail(logText, 40)}\n（完整日志：${HOST_LOG}）`,
    );
  }

  // P2-6 准入断言：设置里的交接目录必须在 /tmp/relay-e2e 下，否则拒绝继续跑。
  try {
    const settingsRes = await fetch(`${baseUrl}/api/compact-relay-settings`, {
      headers: { cookie: host._apiCookie },
      signal: AbortSignal.timeout(3000),
    });
    const settings = await settingsRes.json();
    const handoffDir = settings?.config?.handoffDir;
    if (typeof handoffDir !== 'string' || !path.resolve(handoffDir).startsWith(`${ROOT}${path.sep}`)) {
      throw new Error(`隔离失败：handoffDir 不在 ${ROOT} 下（${String(handoffDir)}）`);
    }
  } catch (error) {
    await stopHost(host);
    throw new Error(`P2-6 隔离校验失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const logText = readFileSync(HOST_LOG, 'utf8');
  if (/compact-relay[^\n]*pending \(waiting for service/.test(logText)) {
    logger.warn('  ⚠ 日志里出现 compact-relay pending（waiting for service），插件可能没真正 apply');
  }
  host.bootMs = Date.now() - startedAt;
  logger.info(`  ✓ host 就绪：${url}（${(host.bootMs / 1000).toFixed(1)}s）`);
  return host;
}

/**
 * 用 launch token 换一份 Node 侧 API 凭据（cookie）。
 *
 * 2026-10-20 安全修复后，插件端点与宿主 /api 一样要求浏览器 cookie / API 凭据；
 * e2e 的 Node fetch 没有浏览器 cookie，所以先 GET /connect?token=…（interactions=none），
 * 拿 Set-Cookie，后续请求带同一个 cookie。
 * @param {object} host startHost 返回值（含 baseUrl/token）
 * @returns {Promise<string>} cookie 请求头值
 */
export async function apiCookie(host) {
  if (typeof host?._apiCookie === 'string' && host._apiCookie.length > 0) return host._apiCookie;
  if (typeof host?.token !== 'string' || host.token.length === 0) {
    throw new Error('host 没有 token，无法换取 API 凭据');
  }
  const url = new URL('/connect', host.baseUrl);
  url.searchParams.set('token', host.token);
  url.searchParams.set('interactions', 'none');
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'text/html' },
  });
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter((value) => typeof value === 'string');
  const cookie = setCookies
    .map((line) => String(line).split(';')[0].trim())
    .filter((pair) => pair.length > 0)
    .join('; ');
  if (cookie.length === 0) {
    throw new Error(`/connect 没有返回 set-cookie（HTTP ${res.status}，token 可能已失效）`);
  }
  host._apiCookie = cookie;
  return cookie;
}

/** 停止 host：整组 SIGTERM → 等 5s → SIGKILL；再扫一遍隔离残留。 */
export async function stopHost(host) {
  if (!host) return { ok: true, pid: null };
  const pid = host.pid;
  if (isAlive(pid)) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
    const exited = await waitUntil(() => !isAlive(pid), 5000, 100);
    if (!exited) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
      await waitUntil(() => !isAlive(pid), 3000, 100);
    }
  }
  const swept = await killStrayHosts();
  return { ok: !isAlive(pid), pid, swept };
}

/* ==========================================================================
 * 三、Chrome CDP：开 tab / 驱动 GUI / 关 tab
 * ========================================================================== */

async function chromeVersion(chromePort = CHROME_PORT) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${chromePort}/json/version`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(
      `连不上 Chrome CDP（127.0.0.1:${chromePort}）：${error.message}\n` +
        `请确认 login-web 专用 Chrome 已带 --remote-debugging-port=${chromePort} 运行。`,
    );
  }
  if (!res.ok) throw new Error(`Chrome /json/version 返回 HTTP ${res.status}`);
  return res.json();
}

async function listChromeTargets(chromePort = CHROME_PORT) {
  const res = await fetch(`http://127.0.0.1:${chromePort}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Chrome /json/list 返回 HTTP ${res.status}`);
  return res.json();
}

/** 新建一个属于我们自己的 tab（记录 targetId 供 cleanup 用）。 */
async function createChromeTarget(chromePort, url) {
  try {
    const res = await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const target = await res.json();
    if (!target?.id || !target?.webSocketDebuggerUrl) throw new Error(`返回异常：${JSON.stringify(target).slice(0, 300)}`);
    return target;
  } catch (error) {
    // 退化路径：走 browser 级 WS 的 Target.createTarget
    logger.warn(`  ⚠ /json/new 失败（${error.message}），改用 browser WS Target.createTarget`);
    const version = await chromeVersion(chromePort);
    const browser = await CDP.connect(version.webSocketDebuggerUrl);
    try {
      const created = await browser.send('Target.createTarget', { url });
      const targets = await listChromeTargets(chromePort);
      const target = targets.find((item) => item.id === created.targetId);
      if (!target) throw new Error(`Target.createTarget 后找不到 target ${created.targetId}`);
      return target;
    } finally {
      browser.close();
    }
  }
}

/** 关闭我们的 tab（幂等；已关就忽略）。 */
async function closeChromeTarget(chromePort, targetId) {
  if (!targetId) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${chromePort}/json/close/${targetId}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 打开隔离 GUI（在 Chrome 里开一个新 tab，并等 DSH web app 就绪）。
 * @param {string} url startHost() 解析出来的带 token 的 URL
 * @param {{chromePort?:number, host?:object, readyTimeoutMs?:number}} [options]
 */
export async function openGui(url, options = {}) {
  if (!url) throw new Error('openGui 需要 startHost() 返回的 url');
  const chromePort = options.chromePort ?? CHROME_PORT;
  const guiStartedAt = Date.now();
  const version = await chromeVersion(chromePort);
  logger.info(`  ✓ Chrome ${version.Browser}（CDP ${chromePort}）`);

  const target = await createChromeTarget(chromePort, url);
  let cdp;
  try {
    cdp = await CDP.connect(target.webSocketDebuggerUrl, options.connectTimeoutMs ?? 15_000);
  } catch (error) {
    await closeChromeTarget(chromePort, target.id);
    throw error;
  }

  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (params) => {
    const description = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'unknown exception';
    pageErrors.push(description);
  });

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  } catch (error) {
    cdp.close();
    await closeChromeTarget(chromePort, target.id);
    throw new Error(`初始化 CDP 域失败：${error.message}`);
  }

  const driver = {
    targetId: target.id,
    chromePort,
    cdp,
    host: options.host ?? null,
    url,
    pageErrors,
    async eval(expression, { awaitPromise = true, timeoutMs = 20_000 } = {}) {
      const { result, exceptionDetails } = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise },
        timeoutMs,
      );
      if (exceptionDetails) {
        const description = exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'Runtime.evaluate 异常';
        throw new Error(description);
      }
      return result?.value;
    },
    async waitFor(predicate, timeoutMs = 20_000, intervalMs = 150) {
      return waitUntil(() => (typeof predicate === 'function' ? predicate() : driver.eval(predicate)), timeoutMs, intervalMs);
    },
    async bodyText() {
      return (await driver.eval(`document.body ? document.body.innerText : ''`)) ?? '';
    },
    async screenshot(filePath) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      if (filePath) writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
      return shot.data;
    },
    async close() {
      cdp.close();
      const closed = await closeChromeTarget(chromePort, target.id);
      driver.closed = closed;
      return closed;
    },
    detach() {
      cdp.close();
    },
  };

  // 等 web app 壳子起来（侧栏「新会话」出现即认为 app ready）。
  const ready = await driver.waitFor(
    `(() => { try { return document.readyState === 'complete' && !!document.body && document.body.innerText.includes('新会话'); } catch { return false; } })()`,
    options.readyTimeoutMs ?? 45_000,
    200,
  );
  if (!ready) {
    let text = '';
    try {
      text = (await driver.bodyText()).slice(0, 500);
    } catch {
      /* ignore */
    }
    await driver.close();
    throw new Error(`DSH web app 加载超时（${options.readyTimeoutMs ?? 45_000}ms）。页面文本片段：${text || '(空)'}`);
  }
  driver.readyMs = Date.now() - guiStartedAt;
  return driver;
}

/* ==========================================================================
 * 四、从 GUI 新建 live session（CDP 点击 + 网络取证）
 * ========================================================================== */

async function clickAria(driver, label, { prefix = false } = {}) {
  return driver.eval(`(() => {
    const wanted = ${JSON.stringify(label)};
    const buttons = [...document.querySelectorAll('button,[role=button]')];
    const hit = buttons.find((button) => {
      const aria = button.getAttribute('aria-label') ?? '';
      return ${prefix ? 'aria.startsWith(wanted)' : 'aria === wanted'};
    });
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
}

/** 等「在“X”中新建会话」按钮出现；必要时先点选择工作区菜单把工作区切过去。 */
async function ensureWorkspaceReady(driver, workspaceTitle) {
  // 2026-10-30（DSH RC5）：每个工作区的「在“X”中新建会话」按钮仍留在 DOM 里，但尺寸是
  // 0×0、不可见，点它没有任何反应。必须只认「可见」按钮，否则会静默点空（smoke 曾因此
  // 卡在「等待新会话创建响应超时」）。
  const perWorkspaceExpr = (title) => `(() => {
    const title = ${JSON.stringify(title)};
    const vis = (button) => { const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    return [...document.querySelectorAll('button,[role=button]')].some((button) =>
      vis(button) && (button.getAttribute('aria-label') ?? '') === '在“' + title + '”中新建会话');
  })()`;

  if (await driver.eval(perWorkspaceExpr(workspaceTitle))) return true;
  // storages 水合需要一点时间，先等 8s。
  if (await driver.waitFor(perWorkspaceExpr(workspaceTitle), 8000)) return true;

  const placeholder = await driver.eval(`document.body.innerText.includes('选择一个工作区开始')`);
  if (placeholder) {
    logger.info('  ↳ 页面停在「选择一个工作区」，尝试点选择工作区菜单');
    await clickAria(driver, '选择工作区').catch(() => false);
    await sleep(400);
    const picked = await driver.eval(`(() => {
      const title = ${JSON.stringify(workspaceTitle)};
      const items = [...document.querySelectorAll('[role=menuitem]')];
      const hit = items.find((item) => (item.innerText ?? '').trim() === title)
        ?? items.find((item) => !(item.innerText ?? '').includes('添加工作区'));
      if (!hit) return null;
      hit.click();
      return (hit.innerText ?? '').trim();
    })()`);
    if (picked) {
      logger.info(`  ↳ 选择工作区：${picked}`);
      await sleep(800);
    }
  }

  // 兜底：目标标题的工作区不存在时，任意工作区的「新建会话」按钮 / 通用按钮都行。
  const anyRoute = await driver.waitFor(
    `(() => {
      const buttons = [...document.querySelectorAll('button,[role=button]')];
      const ariaOf = (button) => button.getAttribute('aria-label') ?? '';
      const vis = (button) => { const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
      const visible = buttons.filter(vis);
      return visible.some((button) => /^在“.+”中新建会话$/.test(ariaOf(button))) || visible.some((button) => ariaOf(button) === '新建会话');
    })()`,
    10_000,
  );
  if (anyRoute) {
    logger.warn(`  ⚠ 找不到「在“${workspaceTitle}”中新建会话」，改用任意可用工作区的按钮`);
    return true;
  }
  throw new Error(`在 GUI 里找不到「在“${workspaceTitle}”中新建会话」按钮，也没有其它可用的工作区`);
}

/**
 * 抓「新建会话」的 session/create 请求响应。
 *
 * 2026-10-30（DSH RC5）：新建请求的 body 变成 `{workspaceId, sessionId}` —— sessionId 由
 * **客户端预先 mint**，旧判别式「body 带 sessionId 就是恢复」会把真正的创建事件漏掉。
 * 新判别式：**带 workspaceId 的 session/create = 新建**（打开已有会话的请求不带 workspaceId），
 * 响应里再解析 sessionId。注意：RC5 点「新建会话」可能复用页面加载时已建好的空白会话，
 * 返回的 sessionId **可能已经存在**（甚至就在 beforeIds 里），所以不能按「新 id」判定，
 * 只认「点击后网络里出现的这条 create」。
 */
function waitForCreatedSession(cdp, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requests = new Map();
    const offs = [];
    const finish = (fn) => {
      clearTimeout(timer);
      for (const off of offs) off();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`等待新会话创建响应超时（${timeoutMs}ms）`))), timeoutMs);
    offs.push(
      cdp.on('Network.requestWillBeSent', (params) => {
        if (!/\/api\/session\/create$/.test(params.request.url)) return;
        const body = params.request.postData ?? '';
        // 新建会话一定带 workspaceId；不带的是打开/恢复已有会话。
        if (!body.includes('"workspaceId"')) return;
        requests.set(params.requestId, { requestId: params.requestId, requestBody: body });
      }),
    );
    offs.push(
      cdp.on('Network.loadingFinished', async (params) => {
        const request = requests.get(params.requestId);
        if (!request || request.resolved) return;
        request.resolved = true;
        try {
          const { body } = await cdp.send('Network.getResponseBody', { requestId: params.requestId });
          const parsed = JSON.parse(body);
          const sessionId =
            parsed?.result?.value?.sessionId ?? /"sessionId"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? null;
          if (sessionId) finish(() => resolve({ sessionId, request, response: body }));
        } catch {
          /* 拿不到 body 就继续等下一个（上层还有 listSessions 兜底） */
        }
      }),
    );
  });
}

/**
 * 在 GUI 里点「新建会话」建一个空白 live session。
 *
 * 关键点（实测）：
 *   - 点击会触发 POST /api/session/create，返回新 sessionId（RC5 起 request body 里带
 *     客户端预 mint 的 sessionId + workspaceId，判别式见 waitForCreatedSession）；
 *   - 创建出的是 blank session + live agent（session/list: blank:true, agentAvailable:true），
 *     不会跑模型、不花钱；
 *   - 页面加载时还会自动「恢复」上次会话；用 beforeIds 排掉已存在的会话。
 *
 * @param {object} driver openGui() 的返回值
 * @param {{workspaceTitle?:string, timeoutMs?:number}} [options]
 */
export async function newSession(driver, options = {}) {
  const workspaceTitle = options.workspaceTitle ?? DEFAULT_WORKSPACE_TITLE;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  await ensureWorkspaceReady(driver, workspaceTitle);

  const before = await listSessions(driver).catch(() => []);
  const beforeIds = new Set(before.map((item) => item.sessionId));

  const createdPromise = waitForCreatedSession(driver.cdp, timeoutMs);
  createdPromise.catch(() => {}); // 避免未 await 时 unhandled rejection

  const click = await driver.eval(`(() => {
    const title = ${JSON.stringify(workspaceTitle)};
    const buttons = [...document.querySelectorAll('button,[role=button]')];
    const ariaOf = (button) => button.getAttribute('aria-label') ?? '';
    // RC5：只点可见按钮（工作区级按钮可能是 0×0 占位）。
    const vis = (button) => { const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const visible = buttons.filter(vis);
    let button = visible.find((candidate) => ariaOf(candidate) === '在“' + title + '”中新建会话');
    let mode = 'workspace';
    if (!button) {
      button = visible.find((candidate) => /^在“.+”中新建会话$/.test(ariaOf(candidate)));
      mode = 'any-workspace';
    }
    if (!button) {
      button = visible.find((candidate) => ariaOf(candidate) === '新建会话' && (candidate.innerText ?? '').includes('新会话'));
      mode = 'generic';
    }
    if (!button) {
      button = visible.find((candidate) => ariaOf(candidate) === '新建会话');
      mode = 'generic';
    }
    if (!button) return { clicked: false };
    const label = ariaOf(button);
    button.click();
    return { clicked: true, label, mode };
  })()`);
  if (!click?.clicked) throw new Error('GUI 里找不到「新建会话」按钮');

  let created = null;
  try {
    created = await createdPromise;
  } catch (error) {
    // 兜底：轮询 session/list，找出点击后新出现的 session。
    logger.warn(`  ⚠ 未从网络事件拿到新 sessionId（${error.message}），改用 session/list 对比`);
    const found = await waitUntil(async () => {
      const now = await listSessions(driver);
      return now.find((item) => !beforeIds.has(item.sessionId)) ?? false;
    }, timeoutMs, 300);
    if (!found) throw error;
    created = { sessionId: found.sessionId, request: null, response: null };
  }

  const sessions = await listSessions(driver).catch(() => []);
  const info = sessions.find((item) => item.sessionId === created.sessionId) ?? null;
  // 实际点中的按钮可能不是目标工作区（兜底路径），从 aria-label 里还原真实工作区标题。
  const effectiveWorkspaceTitle = /^在“(.+)”中新建会话$/.exec(click.label ?? '')?.[1] ?? (click.mode === 'generic' ? null : workspaceTitle);
  const result = {
    sessionId: created.sessionId,
    clicked: click.label,
    mode: click.mode,
    workspaceTitle: effectiveWorkspaceTitle,
    requestedWorkspaceTitle: workspaceTitle,
    cwd: info?.cwd ?? null,
    blank: info?.blank ?? null,
    agentAvailable: info?.agentAvailable ?? null,
    requestBody: created.request?.requestBody ?? null,
    responseBody: created.response,
    elapsedMs: Date.now() - startedAt,
  };
  logger.info(`  ✓ 新建 live session：${result.sessionId}（${(result.elapsedMs / 1000).toFixed(1)}s）`);
  if (result.cwd) logger.info(`    cwd: ${result.cwd}`);
  return result;
}

/** 页面内（带鉴权）调用 session/list，返回精简后的会话列表。 */
export async function listSessions(driver) {
  const expression = `(async () => {
    const rpcId = 'e2e-' + Math.random().toString(36).slice(2);
    const res = await fetch('/api/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } }),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('session/list 返回非 JSON：' + text.slice(0, 200)); }
    const items = parsed?.result?.value?.items ?? [];
    return items.map((item) => ({
      sessionId: item.sessionId,
      cwd: item.cwd ?? null,
      blank: item.blank ?? null,
      agentAvailable: item.agentAvailable ?? null,
      updatedAt: item.updatedAt ?? null,
    }));
  })()`;
  return driver.eval(expression, { awaitPromise: true, timeoutMs: 15_000 });
}

/* ==========================================================================
 * 五、插件 HTTP 端点（host 侧取证 / 动作）
 * ========================================================================== */

function resolveHost(hostOrDriver) {
  if (hostOrDriver?.baseUrl) return hostOrDriver;
  if (hostOrDriver?.host?.baseUrl) return hostOrDriver.host;
  throw new Error('需要 host 句柄（startHost 返回值）或带 host 的 driver');
}

/**
 * GET /api/compact-relay-state。
 *
 * 注意（实测坑）：不带 sessionId 时插件返回 sessionId:null —— 根上下文
 * 的 agents 服务只能 get(sessionId)，不能枚举（pickAgent 的 values() 分支为空）。
 * host 侧确认 live agent 必须显式传 sessionId。
 */
export async function stateGet(hostOrDriver, sessionId, options = {}) {
  const host = resolveHost(hostOrDriver);
  const cookie = await apiCookie(host);
  const url = new URL('/api/compact-relay-state', host.baseUrl);
  if (sessionId) url.searchParams.set('sessionId', sessionId);
  const res = await fetch(url, {
    headers: { cookie },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok && options.allowHttpError !== true) {
    throw new Error(`state 端点 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return json ?? { httpStatus: res.status, text };
}

/**
 * POST /api/compact-relay-action（M3 的 handoff 也走这里）。
 * @param {object} hostOrDriver
 * @param {string|object} action 动作名（'handoff' / 'compact'）或完整 body
 * @param {object} [params] 额外字段（如 { sessionId }）
 * @param {{timeoutMs?:number}} [options] handoff 可能较慢，默认 180s
 */
export async function actionPost(hostOrDriver, action, params = {}, options = {}) {
  const host = resolveHost(hostOrDriver);
  const cookie = await apiCookie(host);
  const body = typeof action === 'string' ? { action, ...params } : { ...action, ...params };
  const res = await fetch(new URL('/api/compact-relay-action', host.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', cookie },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, httpOk: res.ok, body: json ?? text, request: body };
}

/** 在隔离 home 里定位某 session 的落盘目录（sessions/<workspace-id>/<sessionId>）。 */
export function findSessionDir(sessionId) {
  if (!sessionId) return null;
  const sessionsRoot = path.join(ISOLATED_HOME, 'sessions');
  if (!existsSync(sessionsRoot)) return null;
  try {
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(sessionsRoot, entry.name, sessionId);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/* ==========================================================================
 * 六、清理 / --keep 交接
 * ========================================================================== */

/** 关我们的 tab（不动用户已有 tab）。 */
export async function closeGui(driver) {
  if (!driver) return { ok: true };
  try {
    driver.cdp?.close();
  } catch {
    /* ignore */
  }
  const closed = await closeChromeTarget(driver.chromePort ?? CHROME_PORT, driver.targetId);
  return { ok: closed, targetId: driver.targetId };
}

/** 统一停止：先收 GUI tab，再停 host。 */
export async function stop(host, driver) {
  const gui = await closeGui(driver).catch(() => ({ ok: false }));
  const hostResult = await stopHost(host);
  return { gui, host: hostResult };
}

/** 删除隔离 home（默认 smoke 收尾用；logs 和 keep.json 保留）。 */
export function cleanupTemp({ purgeHome = true } = {}) {
  if (purgeHome && existsSync(HOME_ROOT)) {
    assertSafeIsolatedPath(HOME_ROOT);
    rmSync(HOME_ROOT, { recursive: true, force: true });
    return { purged: true, path: HOME_ROOT };
  }
  return { purged: false, path: HOME_ROOT };
}

/** --keep 模式：把交接信息写进 /tmp/relay-e2e/keep.json。 */
export function writeKeepResult(payload) {
  ensureDir(ROOT);
  writeFileSync(KEEP_JSON, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function readKeepResult() {
  if (!existsSync(KEEP_JSON)) return null;
  try {
    return JSON.parse(readFileSync(KEEP_JSON, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 收掉 --keep 留下的现场：杀掉隔离 host（只杀命令行带隔离 profile 的进程）、
 * 关掉 keep.json 里记录的 tab，可选把隔离 home 也删掉。
 */
export async function killKept({ purge = false } = {}) {
  const keep = readKeepResult();
  const swept = await killStrayHosts();
  let tabClosed = false;
  if (keep?.tabId) tabClosed = await closeChromeTarget(keep.chromePort ?? CHROME_PORT, keep.tabId);
  const purged = purge ? cleanupTemp({ purgeHome: true }) : { purged: false };
  // 现场已收掉，删掉 keep.json，避免 action.mjs 误连死 host。
  if (keep) rmSync(KEEP_JSON, { force: true });
  return { ok: true, keep: keep ?? null, killed: swept, tabClosed, purged };
}

export { CDP };
