/**
 * 完整交接链（只读）动作层 —— HTTP 适配层与 dsh 读取器之间的薄包装。
 *
 * 0.5.1 DCR-05：客户端点「完整交接链」时一次取回整条链；服务端按需只读持久化日志，
 * **不把祖先会话加载进 ctx.sessions**（宿主对未加载会话的 readState 返回 sessionId:null，
 * 逐级 GET 会停在断点）。读取细节见 dsh/relay-chain.js。
 */
import { readRelayChain } from '../dsh/relay-chain.js';

/**
 * @param {{ctx:object}} deps
 * @param {{sessionId?:string}} [input]
 * @returns {ReturnType<typeof readRelayChain>}
 */
export function readCompactRelayChain(deps, { sessionId } = {}) {
  return readRelayChain(deps?.ctx, { sessionId });
}
