/**
 * 0.5.0：交接成功后归档旧会话的宿主接缝（best effort，绝不阻断交接）。
 *
 * 宿主实证（DeepSeek Harness 0.2.1-rc.3 app.asar）：
 *   - `@deepseek-ai/dsh-workspace/lib/index.js`：`WorkspaceRegistry.archiveSession(sessionId, options)`
 *     不带 `stopActivity` 时先跑 `workspace/session-activity` waterfall；任何 provider
 *     （运行中的 turn / subagent / job / schedule）报活都会在写盘前抛
 *     `WorkspaceActiveSessionError`（带 `activity` 数组）。
 *   - 带 `stopActivity: true` 时跳过活动检查、先写归档集合，再 `workspace/session-stop`
 *     把旧会话的 turn/subagent/job/schedule 停掉。**自动交接不替用户做这个决定**：
 *     静默取消后台任务比「旧会话多留一行」破坏性大得多，所以本插件永远不传
 *     `stopActivity`；只对「正在收尾的 turn」做有限次等待重试，仍活跃就降级为不归档。
 *   - `WorkspaceRegistry.unarchiveSession(sessionId)` 幂等，且不做存在性探测；
 *     不在归档集合里的 id 直接 no-op。恢复入口可以放心重复调用。
 *   - `archivedSessionIds` 是 registry 全局归档集合；归档不改变 workspace 成员关系，
 *     恢复后回到原位（dsh-workspace/lib/index.js 的注释与 README 同口径）。
 *
 * 插件侧访问路径：`ctx.get('workspaceRegistry')`。本插件 `lib/dsh/sessions.js`
 * 建子会话时已经用同一个服务 `create(cwd)`/`attachSession(id)`，不是新接缝。
 */

/** 宿主归档集合里是否有这个会话；服务不可用/形状异常 → null（不知道，不猜 false）。 */
export function archivedSessionIdsOf(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry');
    const ids = registry?.archivedSessionIds;
    return Array.isArray(ids) ? ids : null;
  } catch {
    return null;
  }
}

/**
 * 旧会话当前是否在归档集合里。
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {boolean|null} null = 宿主没提供可读的归档状态
 */
export function isSessionArchived(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const ids = archivedSessionIdsOf(ctx);
  return ids === null ? null : ids.includes(sessionId);
}

/**
 * 取 workspace registry；拿不到/没有 archiveSession 时 null。
 * @param {object} ctx
 * @returns {object|null}
 */
export function workspaceRegistryOf(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry');
    return registry !== null && registry !== undefined && typeof registry === 'object' ? registry : null;
  } catch {
    return null;
  }
}

/** 错误里的活动族（turn/subagent/job/schedule…）；只用于提示，不参与归档决策。 */
function activityKindsOf(error) {
  if (error === null || typeof error !== 'object' || !Array.isArray(error.activity)) return [];
  const kinds = [];
  for (const entry of error.activity) {
    const kind = entry !== null && typeof entry === 'object' ? entry.kind : undefined;
    if (typeof kind === 'string' && kind.length > 0 && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function errorMessageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isActiveError(error) {
  if (error === null || typeof error !== 'object') return false;
  return (
    error.name === 'WorkspaceActiveSessionError' ||
    error.code === 'workspace/session-active' ||
    Array.isArray(error.activity)
  );
}

/**
 * 归档交接后的旧会话（best effort）。
 *
 * 语义：
 *   - 已归档 → `already`（幂等；不重复写盘）；
 *   - 成功 → `archived`；
 *   - 旧会话还有活（turn/subagent/job/schedule）→ 等短暂的空闲重试机会，仍活跃就
 *     `active`，**不 stopActivity**；
 *   - 宿主没有 registry/archiveSession → `unavailable`；
 *   - 宿主找不到会话 / 写盘失败 → `unknown` / `failed`。
 * 任何分支都不抛错；调用方只需要把返回结果写进提示/日志。
 *
 * @param {object} ctx 根上下文
 * @param {string} sessionId 旧会话 id
 * @param {{log?:{warn?:Function}, attempts?:number, delayMs?:number}} [options]
 * @returns {Promise<{status:'already'|'archived'|'unavailable'|'active'|'unknown'|'failed', archived:boolean, activityKinds:string[]}>}
 */
export async function archiveHandoffSource(ctx, sessionId, { log, attempts = 2, delayMs = 150 } = {}) {
  const failed = (status, activityKinds = []) => ({ status, archived: false, activityKinds });
  if (typeof sessionId !== 'string' || sessionId.length === 0) return failed('unknown');

  const registry = workspaceRegistryOf(ctx);
  if (registry === null || typeof registry.archiveSession !== 'function') {
    log?.warn?.('compact-relay: 旧会话未归档：宿主没有 workspaceRegistry.archiveSession（交接已完成）');
    return failed('unavailable');
  }

  // 幂等：重复交接/上一次已经归档成功时不再写盘，也不触发活动检查。
  if (isSessionArchived(ctx, sessionId) === true) return { status: 'already', archived: true, activityKinds: [] };

  const totalAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      await registry.archiveSession(sessionId);
      return { status: 'archived', archived: true, activityKinds: [] };
    } catch (error) {
      lastError = error;
      const active = isActiveError(error);
      const kinds = activityKindsOf(error);
      // 只对「还在跑」等一等：交接命令刚返回时，旧会话里可能有一个 turn 正在收尾；
      // 默认等 150ms 再试一次，仍活跃就放弃，绝不自动 stopActivity。
      if (active && attempt < totalAttempts) {
        await wait(delayMs * attempt);
        continue;
      }
      if (active) {
        const label = kinds.length > 0 ? kinds.join('/') : 'active';
        log?.warn?.(
          `compact-relay: 旧会话 ${sessionId} 归档失败：仍有任务在跑（${label}）；不自动停止任务，旧会话保持可见（交接已完成）`,
        );
        return failed('active', kinds);
      }
      if (error !== null && typeof error === 'object' && error.name === 'WorkspaceUnknownSessionError') {
        log?.warn?.(`compact-relay: 旧会话 ${sessionId} 归档失败：宿主里找不到该会话（${errorMessageOf(error)}）；交接已完成`);
        return failed('unknown');
      }
      log?.warn?.(`compact-relay: 旧会话 ${sessionId} 归档失败：${errorMessageOf(error)}（交接已完成）`);
      return failed('failed');
    }
  }
  // 理论上循环里已经返回；留一个不抛错的兜底。
  log?.warn?.(`compact-relay: 旧会话 ${sessionId} 归档失败：${errorMessageOf(lastError)}（交接已完成）`);
  return failed(isActiveError(lastError) ? 'active' : 'failed', activityKindsOf(lastError));
}

/**
 * 宿主侧栏置顶集合（0.5.1 批 2）。
 *
 * 宿主实证（`@deepseek-ai/dsh-workspace/lib/index.js`）：`WorkspaceRegistry`
 * - `get pinnedSessionIds()`：registry 全局置顶集合，pin 顺序（最近置顶在前）；
 * - `pinSession(id)` / `unpinSession(id)`；
 * - 置顶与归档互斥：`archiveSession` 在**同一次写盘**里把该 id 从 pinnedSessionIds 移除
 *   （源码注释「Archiving drops the session's pin in the same durable write」）。
 * 所以「归档会取消置顶」不是本插件的推测，是宿主真实行为；这里只读判断，
 * 不替用户 unpin/pin。拿不到/形状异常 → null（不猜 false）。
 * @param {object} ctx
 * @returns {string[]|null}
 */
export function pinnedSessionIdsOf(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry');
    const ids = registry?.pinnedSessionIds;
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * 旧会话当前是否在侧栏置顶。
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {boolean|null} null = 宿主没提供可读的置顶集合
 */
export function isSessionPinned(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const ids = pinnedSessionIdsOf(ctx);
  return ids === null ? null : ids.includes(sessionId);
}

/**
 * 归档结果 → 交接完成 message 里的一行（成功/失败都不丢信息）。
 * 成功时明确告诉用户恢复入口；失败时固定写「归档失败，不影响交接」。
 * @param {{status:string, archived:boolean, activityKinds?:string[]}} result
 * @returns {string}
 */
export function handoffArchiveNoteOf(result) {
  const status = result !== null && typeof result === 'object' ? result.status : 'failed';
  if (status === 'archived') {
    // 0.5.1 DCR-04：指向宿主真实的视图标签/动作文案（实测 dsh-client-ui-workspace：
    // viewOptions 三选一里是「全部对话（显示已归档）」，会话行动作是「取消归档」；
    // 宿主没有「全部会话」这个视图）。
    return '旧会话已归档（可在新会话输入框上方「已接力自 …」→「恢复旧会话」找回；侧栏视图选「全部对话（显示已归档）」，再对该会话点「取消归档」）。';
  }
  if (status === 'already') {
    return '旧会话此前已在归档中（可在新会话输入框上方「已接力自 …」→「恢复旧会话」找回）。';
  }
  // 0.5.1 批 2：用户显式关掉归档（handoff archive:false）。
  if (status === 'skipped') {
    return '按你的选择，旧会话未归档（仍在列表里；侧栏置顶保持不变）。';
  }
  // 0.5.1 批 2：旧会话在侧栏置顶，未经确认不归档（宿主归档会同时取消置顶）。
  if (status === 'pinned') {
    return '旧会话已置顶，本次未自动归档（归档会取消置顶；如要归档，可在交接确认里选「交接并归档（取消置顶）」，或先取消置顶）。';
  }
  const kinds = Array.isArray(result?.activityKinds) && result.activityKinds.length > 0 ? result.activityKinds.join('/') : null;
  if (status === 'active') {
    return `旧会话归档失败，不影响交接（仍有任务在跑：${kinds ?? 'active'}；不自动停止任务，旧会话仍在列表里）。`;
  }
  if (status === 'unavailable') {
    return '旧会话归档失败，不影响交接（当前宿主没有 workspace 归档接口；旧会话仍在列表里）。';
  }
  if (status === 'unknown') {
    return '旧会话归档失败，不影响交接（宿主里找不到该会话）。';
  }
  return '旧会话归档失败，不影响交接（旧会话仍在列表里）。';
}
