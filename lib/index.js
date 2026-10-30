/**
 * dsh-compact-relay —— 装配层。
 *
 * 这里只做三件事：读配置、建共享依赖、注册入口。
 * 业务逻辑一律不写在这里（见 ARCHITECTURE.md）。
 */
import { createInflight } from './actions/inflight.js';
import { readState } from './actions/state.js';
import { createLock } from './actions/lock.js';
import { registerCommands } from './adapters/commands.js';
import { registerHttp } from './adapters/http.js';
import { registerCompressCue } from './adapters/prompt.js';
import { registerTool } from './adapters/tool.js';
import { createSettingsStore } from './actions/settings.js';
import { createDiagCounters } from './dsh/diag-counters.js';
import engine from './dsh/engine.js';
import { createLedgerStore } from './dsh/ledger.js';
import { createEventStore } from './dsh/events.js';
import { writeStateSnapshot } from './dsh/state-snapshot.js';
import { createStateHub } from './dsh/state-hub.js';
import { createFavoriteWatcher } from './dsh/favorite-watch.js';

export const name = 'compact-relay';

/**
 * 需要的 DSH 服务；webServer 用 ctx.inject 单独要，headless 环境也能加载。
 *
 * 注意：`compaction` 是 **agent 作用域**的服务（挂在 preset 的隔离组里），
 * 根上下文拿不到——所以不放进 inject，改用 agent.ctx.compaction 动态取。
 *
 * `systemPrompt`（0.3.4）：它是 DSH 0.2.x 的核心根服务（点灯/命令等插件都依赖它），
 * 这里和 memory 插件一样放根 `inject`。**该服务缺失时本插件会 pending、apply 不会执行**
 * ——这是 cordis inject 的语义，不是 cue 特有的降级；apply 里的
 * `typeof ctx.systemPrompt?.context === 'function'` 守卫针对的是「服务在、但形状不对/
 * 被裁剪」的异常环境。cue 只是增强项，但它的依赖声明与其它入口同级，没有为它单独做
 * 可选注入（避免引入 scoping 风险）。报告「兼容性」一节记录了这个前置。
 */
export const inject = ['commands', 'agents', 'tokenMeter', 'llm', 'sessions', 'tools', 'systemPrompt'];

/**
 * @param {object} ctx
 * @param {object} [config] cordis 插件配置（cordis.patch.yml 里那一行）
 */
export function apply(ctx, config) {
  // 设置存储：cordis 配置是基础层，设置栏写入的用户覆盖层叠在上面；
  // 改完立即热替换 deps.cfg，不需要重启（见 lib/settings-store.js）。
  // A4：用户设置文件非法时回落默认，apply 不因此抛错；设置页会看到 settingsError。
  const settings = createSettingsStore({ config: config ?? {} });
  const log = typeof ctx.logger === 'function' ? ctx.logger('compact-relay') : undefined;
  // 0.5.6 A：插件版本（写进事件行 `v`，用来排「是不是旧版没埋点」）。
  const pluginVersion = (() => {
    try {
      const view = typeof settings.view === 'function' ? settings.view() : null;
      return view !== null && typeof view.version === 'string' ? view.version : undefined;
    } catch {
      return undefined;
    }
  })();
  if (settings.error !== null) {
    const where = settings.error.field === null ? '' : `（字段 ${settings.error.field}）`;
    log?.warn?.(`设置文件有误${where}：${settings.error.message}；已按默认配置启动。`);
  }
  const deps = {
    ctx,
    cfg: settings.current,
    settings,
    lock: createLock(),
    // M6：进行中动作登记表（HTTP cancel 用），与 lock 的分工见 actions/inflight.js。
    inflight: createInflight(),
    // 0.4 P0-2：诊断计数/耗时/错误码（纯内存，重启清零；见 dsh/diag-counters.js）。
    diag: createDiagCounters(),
    // 0.4 P1-3：轻账本（~/.dsh/compact-relay-ledger.jsonl；写失败静默降级，不影响动作）。
    ledger: createLedgerStore(),
    // 0.5.6 A：动作事件流（~/.dsh/compact-relay-events.jsonl；start/end 两行共享 id，
    // 失败 = outcome:'fail' 的读侧投影；写失败静默降级，绝不影响动作）。
    events: createEventStore({ version: pluginVersion }),
    engine,
    ...(log === undefined ? {} : { log }),
  };

  // 设置栏保存后热更新运行时配置（readState/actions 每次调用读 deps.cfg）。
  settings.onChange((next) => {
    deps.cfg = next;
  });
  ctx.effect(() => () => settings.close(), 'compact-relay: settings store');

  // M5：状态推送中枢（SSE）。订阅会话事件；0.3.4 起无论有没有订阅者都维护
  // 一份最新状态缓存，供下面的 systemPrompt 动态提示同步读取。
  // A9：readState 由这里注入，dsh 层不反向依赖 actions 层。
  const hub = createStateHub({
    readState: (sessionId) => {
      const state = readState(deps, { sessionId });
      // 0.5.6 A（D3）：state 快照（≤8KB、10s 节流、原子写、永不抛）——debug CLI 的离线数据源。
      // 放在 hub 的读路径上：指示灯/SSE 每次刷新都会经过这里，不需要额外定时器。
      writeStateSnapshot(state, { version: pluginVersion });
      return state;
    },
  });
  deps.hub = hub;
  // 0.5.3 P1-6：推荐收藏——助手消息落地后异步打分，结果只进 readState 投影（绝不自动收藏）。
  const favoriteWatch = createFavoriteWatcher(deps);
  favoriteWatch.setHub(hub);
  deps.favoriteWatch = favoriteWatch;
  ctx.on('session/event', (session, event) => {
    hub.onSessionEvent(session, event);
    favoriteWatch.onEvent(session, event);
  });
  ctx.effect(() => () => {
    favoriteWatch.close();
    hub.close();
  }, 'compact-relay: state hub + favorite watcher');

  // 0.3.4（BUG-010）：给模型一条「当前在可压缩区间」的动态 system-prompt 提示，
  // 让「这里适合压缩」从不可判断变成可判断。
  // 注意：systemPrompt 在根 inject 里 —— 宿主缺该服务时插件会 pending、apply 根本不会跑
  // （cordis inject 语义，详见文件顶部 inject 注释）；下面的 typeof 守卫只覆盖
  // 「服务在、但形状不对/被裁剪」的异常环境，此时跳过 cue（其它入口不受影响）。
  if (typeof ctx.systemPrompt?.context === 'function') {
    ctx.effect(() => registerCompressCue(ctx, deps, hub), 'compact-relay: compress cue');
  } else {
    log?.warn?.('宿主 systemPrompt 服务缺少 context()（形状异常），跳过「可压缩区间」动态提示；其它入口不受影响。');
  }

  registerCommands(ctx, deps);
  // 0.3.1：模型判断「这里适合压缩」（环上断点1）；0.3.4 起工具名改为 mark_compress_point。
  registerTool(ctx, deps);
  // 2026-10-20 安全修复：HTTP 端点必须和宿主 /api 用同一个 connection 服务做鉴权
  // （Host/Origin fence + 浏览器 token）。只 inject webServer 时拿不到 connection，
  // 会退化成「只挡伪造 Host」——本机进程仍可无 cookie 读端点。
  ctx.inject(['webServer', 'connection'], (webCtx) => registerHttp(webCtx, deps));
}
