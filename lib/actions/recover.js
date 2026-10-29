/**
 * 0.5.0：恢复归档的旧会话（交接后的恢复入口，HTTP `action: 'recover'`）。
 *
 * 这是客户端接力条恢复入口的**兜底**：新版客户端优先直接调
 * `ctx.uiWorkspace.unarchiveSession(sessionId)`（宿主 Client 侧同一条接缝，
 * 会同时更新本地归档集合）；老客户端/客户端拿不到 `unarchiveSession` 时，
 * 走本插件自己的 HTTP 动作，服务端调 `workspaceRegistry.unarchiveSession`。
 *
 * 幂等：宿主 unarchiveSession 对不在归档集合里的 id 直接 no-op，所以重复点
 * 「恢复旧会话」不会报错、也不会改 workspace 位置（归档从不改成员关系）。
 */
import { actionError } from '../core/errors.js';
import { archivedSessionIdsOf, isSessionArchived, workspaceRegistryOf } from '../dsh/handoff-archive.js';

function errorMessageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把旧会话从归档集合里恢复。
 * @param {{ctx:object, log?:{warn?:Function}}} deps
 * @param {{sessionId:string}} input 要恢复的会话 id（不是当前会话）
 * @returns {Promise<{ok:true, recovered:boolean, message:string, archivedSessionIds:string[]|null}>}
 */
export async function recoverArchivedSession(deps, { sessionId } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw actionError('recover', '缺少要恢复的会话 id', undefined, 400);
  }
  const registry = workspaceRegistryOf(deps.ctx);
  if (registry === null || typeof registry.unarchiveSession !== 'function') {
    throw actionError('recover', '当前 DSH 宿主没有 Workspace 归档恢复接口，无法恢复旧会话', undefined, 503);
  }

  const wasArchived = isSessionArchived(deps.ctx, sessionId);
  try {
    await registry.unarchiveSession(sessionId);
  } catch (error) {
    deps.log?.warn?.(`compact-relay: 恢复归档会话 ${sessionId} 失败：${errorMessageOf(error)}`);
    const unknown = error !== null && typeof error === 'object' && error.name === 'WorkspaceUnknownSessionError';
    throw actionError(
      'recover',
      unknown
        ? `恢复旧会话失败：宿主里找不到这个会话（${errorMessageOf(error)}）`
        : `恢复旧会话失败：${errorMessageOf(error)}`,
      error,
      unknown ? 404 : 500,
    );
  }

  return {
    ok: true,
    // false 表示本来就没归档（幂等 no-op），仍然算「恢复成功」——调用方可以直接打开。
    recovered: wasArchived !== false,
    message: wasArchived === false ? '这个会话本来就没有归档，可直接打开。' : '已恢复旧会话，可从侧栏重新打开。',
    // 0.5.3 P3-a：只回数量 + 本次恢复的 id（不再回全量归档集合）。
    archivedCount: (() => {
      const ids = archivedSessionIdsOf(deps.ctx);
      return Array.isArray(ids) ? ids.length : null;
    })(),
    newlyRecovered: wasArchived === false ? [] : [sessionId],
  };
}
