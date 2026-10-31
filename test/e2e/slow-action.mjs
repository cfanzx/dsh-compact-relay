#!/usr/bin/env node
/**
 * e2e 慢动作 —— 在隔离 DSH 里证明「长动作不再依赖单个 HTTP 请求」。
 *
 * 做法：
 *   1. 复用 `test/e2e/lib.mjs` 的隔离 home / host / Chrome CDP 驱动；
 *   2. 在脚本内起一个本地 OpenAI 兼容 stub，并把隔离 profile 的 llm-pi-ai
 *      provider 指向它（只写 /tmp/relay-e2e，不碰真实 ~/.dsh）；
 *   3. stub 对「交接草稿」请求延迟 ~25s，普通对话请求 100ms 返回；
 *   4. 在 GUI 里发一条短消息攒出可交接历史，然后调 `job-start`
 *      （kind=handoff-preview），断言：
 *        - job-start <2s 返回 jobId；
 *        - 任务运行期间再发一条 `job-status` 仍 <2s（不被长动作阻塞）；
 *        - 轮询最终 done，且总耗时 ≥ stub 延迟（25s）。
 *
 * 本脚本**不进 `npm test`**，依赖真实宿主与 Chrome（会起隔离 host，约 40–60s）。
 *
 * 用法：
 *   node test/e2e/slow-action.mjs                 # 完整流程 + 清理
 *   node test/e2e/slow-action.mjs --reuse         # 复用隔离 home（更快）
 *   node test/e2e/slow-action.mjs --keep          # 保留现场（host + Chrome）
 *   node test/e2e/slow-action.mjs --delay 8       # 调试用：缩短慢回复
 *
 * 前置：macOS + DSH 桌面版 + node >=22。脚本会优先复用 127.0.0.1:9222 上已开的
 * Chrome（login-web 专用浏览器）；没有时自动起一个临时的 headless Chrome，跑完关掉。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import * as e2e from './lib.mjs';

const { values: cli } = parseArgs({
  allowPositionals: false,
  options: {
    reuse: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    'no-install': { type: 'boolean', default: false },
    delay: { type: 'string', default: '25' },
    timeout: { type: 'string', default: '180' },
    help: { type: 'boolean', default: false },
  },
});

if (cli.help) {
  console.log('node test/e2e/slow-action.mjs [--reuse] [--keep] [--no-install] [--delay 秒] [--timeout 秒]');
  process.exit(0);
}

const DELAY_MS = Math.max(1, Number(cli.delay ?? 25)) * 1000;
const JOB_TIMEOUT_MS = Math.max(30, Number(cli.timeout ?? 180)) * 1000;
const PROVIDER = 'slow-e2e';
const MODEL = 'slow-e2e-model';
const API_KEY_ENV = 'SLOW_E2E_KEY';
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** 交接提示词里的固定句子；命中即视为「草稿生成」请求（见 lib/core/prompts.js HANDOFF_INSTRUCTION）。 */
const HANDOFF_MARK = '下一个会话里的自己';
const PROBE_TEXT = '隔离 e2e：请回复「好」。';

/** 七段都必须写真实内容，且不能是占位符（见 lib/core/validate-handoff.js）。 */
const HANDOFF_DRAFT = [
  '## 总体目标',
  '在隔离环境验证长动作异步化：job-start 与 job-status 不依赖单个长连接，草稿生成约 25 秒。',
  '## 约束',
  '只读隔离 home，不碰真实 ~/.dsh；不执行任何写操作；测试结束清理临时目录。',
  '## 已完成',
  '本地 OpenAI 兼容 stub 注入成功，模型路由指向 slow-e2e-model，会话可正常对话并记录到日志。',
  '## 关键决策',
  '使用 pi-ai 自定义 provider 指向本地 stub，而不是改宿主代码，保证隔离与可重复。',
  '## 已知问题',
  'stub 仅实现 chat/completions 的 SSE 子集，工具调用与图片输入未覆盖，超出本次验证范围。',
  '## 未完成',
  '真机浏览器侧 20 秒截断验证仍需人工点击确认；本轮只覆盖服务端 job 与隔离 GUI。',
  '## 下一步',
  '接手者先跑 npm run test:e2e:slow，再在真机重复同样步骤并核对 client-error 留档。',
].join('\n');

const run = { host: null, driver: null, stub: null, chrome: null, keep: cli.keep === true };
const startedAt = Date.now();
const findings = [];

function log(...args) {
  console.log(...args);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function expect(condition, label, detail = '') {
  if (condition) {
    log(`  ✓ ${label}${detail === '' ? '' : `（${detail}）`}`);
    return true;
  }
  log(`  ✗ ${label}${detail === '' ? '' : `（${detail}）`}`);
  findings.push(label);
  return false;
}

/* ==========================================================================
 * 一、本地 OpenAI 兼容 stub（慢草稿 / 快对话）
 * ========================================================================== */

function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function startStub() {
  const records = [];
  const server = http.createServer((req, res) => {
    const requestStartedAt = Date.now();
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const isSlow = raw.includes(HANDOFF_MARK);
      const record = {
        url: req.url,
        method: req.method,
        start: requestStartedAt,
        bytes: raw.length,
        isSlow,
        mentionsProbe: raw.includes(PROBE_TEXT),
        responded: false,
      };
      records.push(record);

      if (req.url === '/v1/models') {
        record.responded = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: PROVIDER }] }));
        return;
      }
      if (!req.url.endsWith('/chat/completions')) {
        record.responded = true;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* stub 只做最小解析 */
      }
      const text = isSlow ? HANDOFF_DRAFT : '好';
      const timer = setTimeout(() => {
        if (res.writableEnded) return;
        record.responded = true;
        record.respondedAt = Date.now();
        if (body.stream === true) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const base = {
            id: 'chatcmpl-slow-e2e',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? MODEL,
          };
          res.write(sseData({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
          res.write(sseData({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
          res.write(
            sseData({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
            }),
          );
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-slow-e2e',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: body.model ?? MODEL,
              choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
            }),
          );
        }
      }, isSlow ? DELAY_MS : 100);
      res.on('close', () => clearTimeout(timer));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        records,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/* ==========================================================================
 * 二、隔离 profile 配置 / 代码同步 / Chrome
 * ========================================================================== */

/**
 * 把仓库 HEAD 的插件代码同步进隔离 profile 的 node_modules。
 *
 * 为什么需要：隔离 profile 是从真实 home rsync 来的，它的 pnpm-lock.yaml 仍把
 * `dsh-compact-relay` 锁在 `~/.dsh/vendor`（0.5.6）。`pnpm install` 不会因为
 * profile package.json 改成 `file:<repo>` 就重解析已有 lockfile，于是宿主加载的
 * 可能仍是旧代码（job-start 直接 400「未知动作」）。e2e 只应验证仓库当前代码，
 * 所以这里显式覆盖安装目录；不改 lib.mjs 的公共行为。
 */
function syncPluginCode() {
  const source = e2e.REPO_DIR;
  const target = path.join(e2e.PROFILE_DIR, 'node_modules', 'dsh-compact-relay');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(source, 'lib'), path.join(target, 'lib'), { recursive: true });
  for (const file of ['package.json', 'cordis.patch.yml']) {
    fs.cpSync(path.join(source, file), path.join(target, file));
  }
  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  const hasJobs = fs.existsSync(path.join(target, 'lib', 'dsh', 'jobs.js'));
  log(`  · 插件代码已同步到隔离 profile（version ${version}，jobs.js=${hasJobs}）`);
  if (!hasJobs) throw new Error('同步后的插件缺少 lib/dsh/jobs.js，无法验证 job-start');
}

/** 用 YAML 文本块替换/追加 llm-pi-ai 路由，并改写 agent-default-model 指向它。 */
function writeProfileConfig(baseUrl) {
  const file = path.join(e2e.PROFILE_DIR, 'cordis.patch.yml');
  let text = fs.readFileSync(file, 'utf8');
  const providerBlock = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${PROVIDER}:`,
    '        displayName: Slow E2E Stub',
    '        api: openai-completions',
    `        baseURL: ${baseUrl}/v1`,
    `        apiKeyEnv: ${API_KEY_ENV}`,
    '        models:',
    `          - id: ${MODEL}`,
    '            name: Slow E2E Model',
    '            contextWindow: 200000',
    '            maxTokens: 8192',
    '',
  ].join('\n');

  // 1) 去掉上一次运行留下的 llm-pi-ai 块（stub 端口每次不同），再追加新块。
  const lines = text.split('\n');
  const stubStart = lines.findIndex((line) => /^-\s+id:\s*llm-pi-ai\s*$/.test(line));
  if (stubStart >= 0) {
    let stubEnd = lines.length;
    for (let index = stubStart + 1; index < lines.length; index += 1) {
      if (/^-\s+/.test(lines[index])) {
        stubEnd = index;
        break;
      }
    }
    lines.splice(stubStart, stubEnd - stubStart);
  }
  text = `${lines.join('\n').replace(/\s*$/, '')}\n${providerBlock}`;

  // 2) 原地改写 agent-default-model：provider/model 指向 stub。
  //    注意不要写 reasoningEffort：模型未声明 reasoningEfforts 时宿主会拒绝 "off"。
  const block = text.split('\n');
  const start = block.findIndex((line) => /^-\s+id:\s*agent-default-model\s*$/.test(line));
  if (start < 0) {
    block.push('- id: agent-default-model', '  config:', `    provider: ${PROVIDER}`, `    model: ${MODEL}`, '');
  } else {
    let end = block.length;
    for (let index = start + 1; index < block.length; index += 1) {
      if (/^-\s+/.test(block[index])) {
        end = index;
        break;
      }
    }
    const section = block.slice(start, end);
    const setKey = (key, value) => {
      const index = section.findIndex((line) => new RegExp(`^\\s+${key}:`).test(line));
      if (index >= 0) {
        section[index] = `${/^(\s+)/.exec(section[index])[1]}${key}: ${value}`;
      } else {
        const config = section.findIndex((line) => /^\s+config:\s*$/.test(line));
        section.splice(config + 1, 0, `    ${key}: ${value}`);
      }
    };
    setKey('provider', PROVIDER);
    setKey('model', MODEL);
    const reasoning = section.findIndex((line) => /^\s+reasoningEffort:/.test(line));
    if (reasoning >= 0) section.splice(reasoning, 1);
    block.splice(start, end - start, ...section);
  }
  fs.writeFileSync(file, `${block.join('\n').replace(/\s*$/, '')}\n`);
  log(`  · 隔离 profile 已指向本地 stub：${baseUrl}/v1（model ${MODEL}）`);
}

/** 有现成 CDP 就用；没有就起一个临时 headless Chrome（跑完关掉）。 */
async function ensureChrome() {
  const port = e2e.CHROME_PORT;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const version = await res.json();
      log(`  ✓ 复用已运行的 Chrome（CDP ${port}，${version.Browser}）`);
      return { started: false, port };
    }
  } catch {
    /* 没有 CDP，继续起临时 Chrome */
  }
  if (!fs.existsSync(CHROME_BIN)) {
    throw new Error(
      `连不上 Chrome CDP（127.0.0.1:${port}），也找不到 ${CHROME_BIN}。\n` +
        '请先启动 login-web 专用 Chrome（--remote-debugging-port=9222）后重试。',
    );
  }
  const profileDir = fs.mkdtempSync(path.join(e2e.ROOT, 'chrome-slow-'));
  log(`  · 起临时 headless Chrome（CDP ${port}，profile ${profileDir}）`);
  const child = spawn(
    CHROME_BIN,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  const ready = await e2e.waitUntil(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  }, 20_000, 200);
  if (!ready) {
    await stopChrome({ started: true, child, profileDir });
    throw new Error(`临时 Chrome 未在 20s 内暴露 CDP ${port}`);
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  log(`  ✓ 临时 Chrome 就绪（${version.Browser}）`);
  return { started: true, child, profileDir, port };
}

async function stopChrome(chrome) {
  if (!chrome?.started) return;
  const pid = chrome.child.pid;
  const signal = (name) => {
    try {
      process.kill(-pid, name);
    } catch {
      try {
        chrome.child.kill(name);
      } catch {
        /* 已退出 */
      }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (chrome.child.exitCode !== null) break;
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await sleep(100);
  }
  signal('SIGKILL');
  // Chrome 退出时会继续写 profile（SingletonLock 等），rm 偶发 ENOTEMPTY；多等一会再删，
  // 清理失败只告警，不能把已经 PASS 的 e2e 判成失败。
  await sleep(300);
  if (chrome.profileDir) {
    try {
      fs.rmSync(chrome.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      log(`  ⚠ 临时 Chrome profile 未删干净（可手工删）：${chrome.profileDir}（${error.message}）`);
    }
  }
}

/* ==========================================================================
 * 三、GUI：发一条消息，等历史落进 session
 * ========================================================================== */

async function sendMessage(driver, text) {
  const focused = await driver.eval(`(() => {
    const el = document.querySelector('[role="textbox"][contenteditable]');
    if (!el) return false;
    el.focus();
    return true;
  })()`);
  if (!focused) throw new Error('GUI 里找不到输入框（[role=textbox][contenteditable]）');
  await driver.cdp.send('Input.insertText', { text });
  const typed = await driver.waitFor(
    `(() => {
      const el = document.querySelector('[role="textbox"]');
      return !!el && ((el.innerText || el.textContent || '').includes(${JSON.stringify(text.slice(0, 8))}));
    })()`,
    8000,
  );
  if (!typed) throw new Error(`输入框没收到文本：${JSON.stringify(text.slice(0, 20))}`);
  for (const type of ['keyDown', 'keyUp']) {
    await driver.cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }
  const sent = await driver.waitFor(
    `(() => {
      const el = document.querySelector('[role="textbox"]');
      return !!el && !(el.innerText || '').trim();
    })()`,
    10_000,
  );
  if (!sent) throw new Error('按了 Enter 但输入框没清空，消息可能没发出去');
}

/** 等到 stub 收到本轮对话请求且 session 已回到 idle（runIdle 才允许起交接 job）。 */
async function waitReplyDone(host, sessionId, stub) {
  const deadline = Date.now() + 30_000;
  let stableIdle = 0;
  let last = null;
  while (Date.now() < deadline) {
    const state = await e2e.stateGet(host, sessionId, { timeoutMs: 5000 }).catch(() => null);
    last = state;
    const replySeen = stub.records.some((record) => record.mentionsProbe && record.responded);
    if (replySeen && state?.busy === false && (state?.pressure ?? 0) > 0) stableIdle += 1;
    else stableIdle = 0;
    if (stableIdle >= 2) return state;
    await sleep(500);
  }
  throw new Error(
    `等模型回复结束超时。最后 state：${JSON.stringify(last).slice(0, 300)}；stub 请求：${JSON.stringify(
      stub.records.map((record) => ({ url: record.url, mentionsProbe: record.mentionsProbe, responded: record.responded })),
    )}`,
  );
}

/* ==========================================================================
 * 四、主流程
 * ========================================================================== */

async function settleJob(host, jobId) {
  const polls = [];
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let terminal = null;
  while (Date.now() < deadline) {
    const started = Date.now();
    const res = await e2e.actionPost(host, { action: 'job-status', jobId }, {}, { timeoutMs: 5000 });
    const ms = Date.now() - started;
    polls.push({ status: res.status, jobStatus: res.body?.status ?? null, ms });
    if (res.status !== 200 || res.body?.ok !== true) {
      throw new Error(`job-status HTTP ${res.status}：${JSON.stringify(res.body).slice(0, 300)}`);
    }
    if (res.body.status !== 'running') {
      terminal = res.body;
      break;
    }
    await sleep(500);
  }
  return { terminal, polls };
}

async function main() {
  await e2e.prepareEnv({
    reuse: cli.reuse === true,
    skipInstall: cli['no-install'] === true,
    installTimeoutMs: 240_000,
  });
  syncPluginCode();

  run.stub = await startStub();
  log(`  · 本地 OpenAI stub：${run.stub.url}（草稿延迟 ${DELAY_MS / 1000}s，普通回复 0.1s）`);
  writeProfileConfig(run.stub.url);
  process.env[API_KEY_ENV] = 'slow-e2e-key';

  run.chrome = await ensureChrome();
  run.host = await e2e.startHost({ timeoutMs: 120_000 });
  run.driver = await e2e.openGui(run.host.url, { host: run.host });
  const session = await e2e.newSession(run.driver, {});
  log(`  · 隔离 session：${session.sessionId}`);

  await sendMessage(run.driver, PROBE_TEXT);
  const ready = await waitReplyDone(run.host, session.sessionId, run.stub);
  log(`  · 历史就绪：pressure=${ready.pressure}，busy=${ready.busy}`);

  // ---- 核心断言：job-start 必须立刻返回 ----
  const jobStartAt = Date.now();
  const started = await e2e.actionPost(
    run.host,
    { action: 'job-start', kind: 'handoff-preview', sessionId: session.sessionId, trigger: 'ui-menu' },
    {},
    { timeoutMs: 2000 },
  );
  const jobStartMs = Date.now() - jobStartAt;
  const jobId = started.body?.jobId;
  expect(started.status === 200 && typeof jobId === 'string', 'job-start <2s 返回 jobId', `${jobStartMs}ms，HTTP ${started.status}，jobId=${jobId ?? '(无)'}`);
  expect(jobStartMs < 2000, 'job-start 耗时 <2000ms', `${jobStartMs}ms`);
  if (typeof jobId !== 'string') throw new Error(`job-start 没有返回 jobId：${JSON.stringify(started.body).slice(0, 300)}`);
  expect(started.body?.status === 'running', 'job 初始状态 running', String(started.body?.status));
  expect(jobId.startsWith('dcrjob-'), 'jobId 带 dcrjob- 前缀', jobId);
  expect(started.body?.kind === 'handoff-preview', 'kind=handoff-preview', String(started.body?.kind));

  // ---- 长动作运行期间，另一条 job-status 必须仍然短 ----
  await sleep(400);
  const concurrentAt = Date.now();
  const concurrent = await e2e.actionPost(run.host, { action: 'job-status', jobId }, {}, { timeoutMs: 2000 });
  const concurrentMs = Date.now() - concurrentAt;
  expect(concurrent.status === 200 && concurrent.body?.status === 'running', '长动作期间 job-status 仍返回 running', `HTTP ${concurrent.status}，${concurrentMs}ms`);
  expect(concurrentMs < 2000, '并发 job-status <2000ms', `${concurrentMs}ms`);

  // ---- 轮询到终态 ----
  const { terminal, polls } = await settleJob(run.host, jobId);
  const totalMs = Date.now() - jobStartAt;
  const maxPollMs = Math.max(...polls.map((item) => item.ms));
  expect(terminal !== null, '轮询在超时前拿到终态', `${polls.length} 次轮询`);
  expect(terminal?.status === 'done', 'job 最终状态 done', String(terminal?.status ?? 'timeout'));
  expect(totalMs >= DELAY_MS, `job 总耗时 ≥ ${DELAY_MS / 1000}s（不再依赖单请求）`, `${(totalMs / 1000).toFixed(1)}s`);
  expect(maxPollMs < 2000, '所有 job-status 轮询均 <2000ms', `最大 ${maxPollMs}ms`);
  const draft = typeof terminal?.result?.draft === 'string' ? terminal.result.draft : '';
  expect(draft.includes('## 总体目标') && draft.length > 200, 'job-status 带回完整草稿', `${draft.length} 字`);
  expect(terminal?.result?.ok === true, 'result.ok=true', String(terminal?.result?.ok));

  const slowRecords = run.stub.records.filter((record) => record.isSlow && record.respondedAt);
  const slowDurations = slowRecords.map((record) => record.respondedAt - record.start);
  const slowMs = Math.max(0, ...slowDurations);
  expect(slowRecords.length >= 1, 'stub 确实收到了草稿请求', `${slowRecords.length} 次`);
  expect(slowMs >= DELAY_MS, `草稿请求实际耗时 ≥ ${DELAY_MS / 1000}s`, `${(slowMs / 1000).toFixed(1)}s`);

  return {
    ok: findings.length === 0,
    sessionId: session.sessionId,
    jobId,
    jobStartMs,
    concurrentMs,
    maxPollMs,
    polls: polls.length,
    totalMs,
    delayMs: DELAY_MS,
    slowMs,
    slowCalls: slowRecords.length,
    draftLength: draft.length,
    host: run.host.baseUrl,
  };
}

let failure = null;
let result = null;
try {
  result = await main();
} catch (error) {
  failure = error;
  console.error(`\nFAIL ${error?.message ?? error}`);
  if (error?.stack) console.error(error.stack.split('\n').slice(1, 5).join('\n'));
}

if (result !== null && findings.length === 0) {
  console.log('\nPASS  e2e 慢动作异步化：job-start/job-status 短请求 + 后台 job 跑完');
  console.log(`  job-start          : ${result.jobStartMs}ms（阈值 <2000ms）`);
  console.log(`  运行中 job-status  : ${result.concurrentMs}ms（阈值 <2000ms）`);
  console.log(`  轮询最大耗时       : ${result.maxPollMs}ms（${result.polls} 次）`);
  console.log(`  job 总耗时         : ${(result.totalMs / 1000).toFixed(1)}s（草稿延迟 ${(result.delayMs / 1000).toFixed(1)}s，stub 实测 ${(result.slowMs / 1000).toFixed(1)}s）`);
  console.log(`  jobId / 草稿       : ${result.jobId} / ${result.draftLength} 字`);
} else if (findings.length > 0) {
  console.error(`\nFAIL 断言未通过 ${findings.length} 项：${findings.join('；')}`);
}

const summary = { ...(result ?? {}), ok: failure === null && findings.length === 0, findings, elapsedMs: Date.now() - startedAt, hostLog: e2e.HOST_LOG };
console.log(`\nE2E_SLOW_RESULT ${JSON.stringify(summary)}`);

if (run.keep) {
  e2e.writeKeepResult({
    host: run.host?.baseUrl ?? null,
    hostPid: run.host?.pid ?? null,
    tabId: run.driver?.targetId ?? null,
    chromePort: run.driver?.chromePort ?? e2e.CHROME_PORT,
    chromeStartedByScript: run.chrome?.started === true,
    chromePid: run.chrome?.child?.pid ?? null,
    sessionId: result?.sessionId ?? null,
    jobId: result?.jobId ?? null,
  });
  log(`\n--keep：现场保留（host/tab${run.chrome?.started ? '/临时 Chrome' : ''} 不关）。收掉：node test/e2e/smoke.mjs --kill --purge`);
} else {
  await e2e.stop(run.host, run.driver).catch(() => {});
  await run.stub?.close().catch(() => {});
  await stopChrome(run.chrome);
  e2e.cleanupTemp({ purgeHome: true });
  log(`\n清理完成（日志保留：${e2e.LOG_DIR}）`);
}

process.exit(failure === null && findings.length === 0 ? 0 : 1);
