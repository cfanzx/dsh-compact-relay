/**
 * 统一 fake host / ctx 工厂 —— 三套 node 测试共用（A7）。
 *
 * 两个层次：
 *   1. `createFakeHost()`：cordis 插件上下文替身（effect / commands / tools / on / inject /
 *      logger / connection / webServer），供 `apply()` 装配测试用；命令/路由/工具/事件
 *      的注册结果都收在返回的 host 对象上，配套 `callRoute` / `callSSE` 等请求替身。
 *   2. `createHandoffHost()`：交接/压缩流程用的业务 ctx（tokenMeter / llm / agents / sessions /
 *      get(service)），把旧 handoff.mjs 手搓的 makeCtx 收成一份；record 里的观测字段与旧夹具同名。
 *
 * 另外提供 `createFakeEngine()`：与 `lib/dsh/engine.js` 同符号的 DSH 能力接缝替身。
 * 真实 engine 的符号清单由 `test/contract.mjs` 冻结（ENGINE_SYMBOLS）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearPreviewPlans } from '../../lib/actions/better-compact.js';
import { createLock } from '../../lib/actions/lock.js';
import { resolveConfig } from '../../lib/config.js';
import { clearModelInfoCache } from '../../lib/dsh/llm-call.js';
import {
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '../stubs/compaction.mjs';
import { BlockAssembler, createUserMessage, errorChain } from '../stubs/llm.mjs';
import { appendPluginRecord } from '../stubs/session.mjs';
import { defineTool } from '../stubs/tools.mjs';
import { MockSession } from './session.mjs';

/* ------------------------------------------------------------------ *
 * DSH 能力接缝
 * ------------------------------------------------------------------ */

/**
 * 真实 `lib/dsh/engine.js` 必须提供的符号清单（冻结）：
 * 插件其它模块只通过这些符号消费 DSH，改这里等于改插件与 DSH 的契约。
 */
export const ENGINE_SYMBOLS = Object.freeze([
  'compactCheckpointSource',
  'isCompactCheckpointSource',
  'toolPairingBalancedBefore',
  'toolPairingBalancedAfter',
  'BlockAssembler',
  'createUserMessage',
  'errorChain',
  'appendPluginRecord',
  'defineTool',
]);

/** 与真实 engine 同符号、同实现（都来自 test/stubs）的接缝替身；冻结，避免测试互相污染。 */
export function createFakeEngine(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!ENGINE_SYMBOLS.includes(key)) {
      throw new Error(`createFakeEngine: 未知 engine 符号「${key}」，请先更新 ENGINE_SYMBOLS 与 contract`);
    }
  }
  return Object.freeze({
    // 与真实 engine 一样，直接取 test/stubs 里的同名实现：契约测试可以逐符号做恒等断言。
    compactCheckpointSource,
    isCompactCheckpointSource,
    toolPairingBalancedBefore,
    toolPairingBalancedAfter,
    BlockAssembler,
    createUserMessage,
    errorChain,
    appendPluginRecord,
    defineTool,
    ...overrides,
  });
}

/* ------------------------------------------------------------------ *
 * cordis 插件上下文（apply 装配测试）
 * ------------------------------------------------------------------ */

function defaultEffect(handler) {
  const result = handler();
  if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
    // 兼容 ctx.effect(generator)：把同步初始化跑到第一个 yield 之后（当前插件不用，留兜底）。
    let step = result.next();
    while (step.done !== true) step = result.next();
    return () => {};
  }
  return typeof result === 'function' ? result : () => {};
}

/**
 * 默认提供空的 `agents` / `sessions` 服务（够 apply() 装配与无会话路径用）；
 * tokenMeter / llm 等按插件 inject 需要由 `services` 传入。
 *
 * @param {object} [options]
 * @param {object} [options.services] 合进 ctx 的服务（agents/sessions/tokenMeter/llm…，覆盖默认值）
 * @param {boolean} [options.webServer] 根 ctx 是否直接带 webServer（默认 false，走 inject 子 ctx）
 * @param {object} [options.logger]
 * @param {number|undefined} [options.connectionRejection] 初始鉴权拒绝码（undefined=放行）
 * @returns {{ctx:object, commands:object[], routes:object[], tools:object[], eventHandlers:object[], promptContexts:object[], makeContext:Function, setConnectionRejection:Function}}
 */
export function createFakeHost(options = {}) {
  const registrations = { commands: [], routes: [], tools: [], eventHandlers: [], promptContexts: [] };
  const auth = { rejection: options.connectionRejection };
  const services = options.services ?? {};
  const logger = options.logger ?? { info() {}, warn() {} };

  function makeContext(withWebServer) {
    const ctx = {
      effect(handler) {
        return defaultEffect(handler);
      },
      commands: {
        register(definition) {
          registrations.commands.push(definition);
          return () => {};
        },
      },
      tools: {
        register(definition) {
          registrations.tools.push(definition);
          return () => {};
        },
      },
      on(name, listener) {
        registrations.eventHandlers.push({ name, listener });
        return () => {};
      },
      // 0.3.4：systemPrompt 服务替身（动态「可压缩区间」提示）。只记录 context 注册，
      // text 由用例显式调用；真实宿主行为见 @deepseek-ai/dsh-system-prompt。
      systemPrompt: {
        context(definition) {
          registrations.promptContexts.push(definition);
          return () => {};
        },
      },
      inject(_names, callback) {
        callback(makeContext(true));
      },
      logger,
      // 宿主鉴权服务替身：默认放行；用例里 setConnectionRejection(401/403) 验证闸门。
      connection: { requestRejection: () => auth.rejection },
      // 最小服务默认值（无活动会话路径用）；具体用例可用 services 覆盖。
      agents: { get: () => undefined, list: () => [] },
      sessions: { get: () => undefined, flush() {} },
      ...services,
    };
    if (withWebServer) {
      ctx.webServer = {
        register(route) {
          registrations.routes.push(route);
          return () => {};
        },
      };
    }
    return ctx;
  }

  const ctx = makeContext(options.webServer === true);
  return {
    ctx,
    commands: registrations.commands,
    routes: registrations.routes,
    tools: registrations.tools,
    eventHandlers: registrations.eventHandlers,
    promptContexts: registrations.promptContexts,
    makeContext,
    setConnectionRejection(value) {
      auth.rejection = value;
    },
  };
}

/** 按 path 找注册路由；找不到直接抛（等价旧测试的 assert.notEqual(route, undefined)）。 */
export function requireRoute(host, pathname) {
  const route = host.routes.find((candidate) => candidate.path === pathname);
  if (route === undefined) throw new Error(`路由不存在：${pathname}`);
  return route;
}

function routePathOf(pathOrUrl) {
  return new URL(pathOrUrl, 'http://127.0.0.1').pathname;
}

/** HTTP 响应替身；sse:true 时带 write()（EventSource 流）。 */
export function createResponse({ sse = false } = {}) {
  const response = {
    status: undefined,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers ?? {});
    },
    end(body) {
      this.body = body ?? '';
    },
    on() {},
  };
  if (sse) {
    response.write = function write(text) {
      this.body += text;
      return true;
    };
  }
  return response;
}

/** 发一个（非 SSE）路由请求并返回响应替身；异步 handler 用 callRouteAsync 等结果。 */
export function callRoute(host, pathOrUrl, { method = 'GET', url, body = '', headers = {} } = {}) {
  const target = url ?? pathOrUrl;
  const route = requireRoute(host, routePathOf(target));
  const res = createResponse();
  const req = {
    method,
    url: target,
    headers,
    on(event, handler) {
      if (event === 'data' && body !== '') handler(Buffer.from(body));
      if (event === 'end') handler();
    },
    destroy() {},
  };
  route.handler(req, res);
  return res;
}

/** 发一个 GET 请求并等异步 handler 写完 body（最多 timeoutMs）。 */
export async function callRouteAsync(host, pathOrUrl, { timeoutMs = 500, pollMs = 5 } = {}) {
  const res = callRoute(host, pathOrUrl);
  const deadline = Date.now() + timeoutMs;
  while (res.body === '' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return {
    status: res.status,
    headers: res.headers,
    body: res.body === '' ? null : JSON.parse(res.body),
  };
}

/** 开一个 SSE 流（GET）并返回响应替身；断言首帧前自行等一会儿。 */
export function openSse(host, pathOrUrl, { headers = {} } = {}) {
  const route = requireRoute(host, routePathOf(pathOrUrl));
  const res = createResponse({ sse: true });
  route.handler({ method: 'GET', url: pathOrUrl, headers, on() {} }, res);
  return res;
}

/* ------------------------------------------------------------------ *
 * 业务 ctx（handoff / compact 流程测试）
 * ------------------------------------------------------------------ */

/** 一次性临时目录（避免碰真实 ~/.dsh/handoffs）。 */
export function createTmpDir(prefix = 'relay-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 原会话 Agent 替身（runMaintenance 默认同步执行 job）。 */
export function createAgent(session, extra = {}) {
  return {
    id: session.id,
    session,
    options: { provider: 'mock', model: 'mock-model' },
    runMaintenance: (job) => job(new AbortController().signal),
    ...extra,
  };
}

/** actions 层 deps 替身（与 lib/index.js 的 deps 字段同名）。 */
export function createPluginDeps({ ctx, engine, handoffDir, cfg, lock } = {}) {
  return {
    ctx,
    cfg: cfg ?? resolveConfig({ handoffDir, retention: { recentTailTokens: 0 } }),
    lock: lock ?? createLock(),
    engine,
  };
}

/**
 * 交接/压缩流程的 fake ctx。
 *
 * @param {object} options
 * @param {object} options.llm createFakeLlm() 的返回值（必传；route 已在测试侧配好）
 * @param {object} [options.engine]
 * @param {boolean} [options.childHasFollowup] 新会话 agent 是否支持 followup（默认 true）
 * @param {boolean} [options.agentPresetsBroken] agentPresets.resolve 是否抛错
 * @param {boolean} [options.registryBroken] workspaceRegistry.create 是否抛错
 * @param {boolean} [options.reset] 建 ctx 时是否清插件级缓存（默认 true，避免用例串味）
 * @param {object} [options.services] 覆盖/追加 ctx 服务
 * @returns {{ctx:object, engine:object, record:object}}
 */
export function createHandoffHost({
  llm,
  engine = createFakeEngine(),
  childHasFollowup = true,
  agentPresetsBroken = false,
  registryBroken = false,
  reset = true,
  tokenMeter,
  services = {},
} = {}) {
  if (llm === undefined) throw new Error('createHandoffHost: 必须传 llm（用 createFakeLlm 构造）');
  if (reset) {
    clearPreviewPlans();
    clearModelInfoCache();
  }
  const record = {
    createCalls: [],
    followups: [],
    attached: [],
    renames: [],
    resolves: [],
    mounts: [],
    llmCalls: llm.calls,
    child: null,
    presetSetup: null,
  };

  const ctx = {
    tokenMeter:
      tokenMeter ??
      {
        measure(session) {
          const nodes = session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
          return { totalTokens: nodes.length * 100, surfaceTokens: nodes.length * 100, nodes };
        },
      },
    llm,
    agents: {
      async create(options) {
        record.createCalls.push(options);
        const child = new MockSession({
          id: options.sessionId,
          cwd: options.meta?.cwd,
          agentPreset: options.meta?.agentPreset,
        });
        record.child = child;
        const childAgent = {
          id: child.id,
          session: child,
          ...(childHasFollowup
            ? {
                followup(message) {
                  record.followups.push(message);
                  child.append('user/message', message, { surfaceOp: 'append' });
                  child.append('turn/start', { turn: 1 });
                },
              }
            : {}),
        };
        return { agent: childAgent };
      },
    },
    sessions: {
      async flush() {},
    },
    get(name) {
      switch (name) {
        case 'agentPresets':
          return {
            async resolve(id) {
              record.resolves.push(id);
              if (agentPresetsBroken) throw new Error('no preset registry');
              return { id: id ?? 'default-preset' };
            },
            async mount(_agentCtx, id) {
              record.mounts.push(id);
            },
          };
        case 'workspaceRegistry':
          return {
            async create(cwd) {
              if (registryBroken) throw new Error('workspace registry down');
              return {
                async attachSession(sessionId) {
                  record.attached.push({ cwd, sessionId });
                },
              };
            },
          };
        case 'sessionTitle':
          return {
            get() {
              return { title: '原会话标题' };
            },
            rename(session, title) {
              record.renames.push({ sessionId: session.id, title });
            },
          };
        case 'sessionProjections':
          return undefined;
        case 'agentDefaultModel':
          return { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) };
        default:
          return undefined;
      }
    },
    ...services,
  };

  return { ctx, engine, record };
}
