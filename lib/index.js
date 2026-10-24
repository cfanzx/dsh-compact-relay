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
import engine from './dsh/engine.js';
import { createStateHub } from './dsh/state-hub.js';

export const name = 'compact-relay';

/** 需要的 DSH 服务；webServer 用 ctx.inject 单独要，headless 环境也能加载。
 *  注意：`compaction` 是 **agent 作用域**的服务（挂在 preset 的隔离组里），
 *  根上下文拿不到——所以不放进 inject，改用 agent.ctx.compaction 动态取。
 *  `systemPrompt`：0.3.4 起用它注入「可压缩区间」动态提示（memory 插件同款）；
 *  老宿主没有该服务时 apply 里会守卫跳过，不影响其它入口。
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
  const hub = createStateHub({ readState: (sessionId) => readState(deps, { sessionId }) });
  deps.hub = hub;
  ctx.on('session/event', (session, event) => hub.onSessionEvent(session, event));
  ctx.effect(() => () => hub.close(), 'compact-relay: state hub');

  // 0.3.4（BUG-010）：给模型一条「当前在可压缩区间」的动态 system-prompt 提示，
  // 让「这里适合压缩」从不可判断变成可判断。没有 systemPrompt 服务的宿主直接跳过
  // （不让插件 pending/抛错；提示是增强项，不是其它入口的前置）。
  if (typeof ctx.systemPrompt?.context === 'function') {
    ctx.effect(() => registerCompressCue(ctx, deps, hub), 'compact-relay: compress cue');
  } else {
    log?.warn?.('宿主没有 systemPrompt 服务，「可压缩区间」动态提示不可用（其它功能正常）。');
  }

  registerCommands(ctx, deps);
  // 0.3.1：模型判断「这里适合压缩」（环上断点1）；0.3.4 起工具名改为 mark_compress_point。
  registerTool(ctx, deps);
  // 2026-10-20 安全修复：HTTP 端点必须和宿主 /api 用同一个 connection 服务做鉴权
  // （Host/Origin fence + 浏览器 token）。只 inject webServer 时拿不到 connection，
  // 会退化成「只挡伪造 Host」——本机进程仍可无 cookie 读端点。
  ctx.inject(['webServer', 'connection'], (webCtx) => registerHttp(webCtx, deps));
}
