#!/usr/bin/env node
/**
 * 对 --keep 留下的隔离 DSH host 手动调插件端点（M3 端到端用）。
 *
 * 用法：
 *   node test/e2e/action.mjs state [--session <id>]
 *   node test/e2e/action.mjs handoff --session <id>
 *   node test/e2e/action.mjs compact --session <id>
 *
 * 选项：
 *   --session <id>   会话 id；默认取 /tmp/relay-e2e/keep.json 里记录的那个
 *   --base-url <url> 直接指定 host 地址；默认取 keep.json 的 baseUrl
 *   --timeout <秒>   HTTP 超时（默认 handoff/compact 180s，state 10s）
 *   --json           只输出 JSON（便于脚本消费）
 *
 * 说明：
 *   * 插件端点与宿主 /api 同一套鉴权；脚本会用 host.token 走 /connect 换 API cookie 再请求。
 *   * handoff 可能触发真实模型调用（M3 实现而定），执行前请确认在隔离 home 里。
 */

import { parseArgs } from 'node:util';
import * as e2e from './lib.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: 'string' },
    'base-url': { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const command = positionals[0] ?? 'state';
if (values.help || !['state', 'handoff', 'compact'].includes(command)) {
  console.log(`用法：
  node test/e2e/action.mjs state   [--session <id>] [--base-url <url>]
  node test/e2e/action.mjs handoff --session <id> [--base-url <url>] [--timeout 180]
  node test/e2e/action.mjs compact --session <id> [--base-url <url>]

默认从 /tmp/relay-e2e/keep.json 读 baseUrl / sessionId（先跑 smoke.mjs --keep）。`);
  process.exit(values.help ? 0 : 2);
}

const keep = e2e.readKeepResult();
const baseUrl = values['base-url'] ?? keep?.baseUrl;
if (!baseUrl) {
  console.error(`没有 --base-url，也没有找到 keep 记录 ${e2e.KEEP_JSON}。`);
  console.error('先跑：node test/e2e/smoke.mjs --keep');
  process.exit(2);
}
const host = { baseUrl };
const sessionId = values.session ?? keep?.sessionId ?? null;

const print = (payload) => {
  if (values.json) console.log(JSON.stringify(payload));
  else console.log(JSON.stringify(payload, null, 2));
};

try {
  if (command === 'state') {
    const state = await e2e.stateGet(host, sessionId ?? undefined, {
      timeoutMs: Number(values.timeout ?? 10) * 1000,
    });
    print(state);
    process.exit(0);
  }

  if (!sessionId) {
    console.error('handoff/compact 必须显式带 --session <id>（插件根上下文 agents 不可枚举，不能靠 pickAgent 兜底）。');
    process.exit(2);
  }
  const result = await e2e.actionPost(host, command, { sessionId }, {
    timeoutMs: Number(values.timeout ?? 180) * 1000,
  });
  const body = typeof result.body === 'object' && result.body !== null ? result.body : {};
  const message = typeof body.message === 'string' ? body.message : '';
  // P2-T4：不同动作的成功判据不同，不能只看 ok:true。
  //  - compact：真压成功会带「压缩完成」；「没有可安全压缩的范围」是合法的无操作，标为 noop。
  //  - handoff：必须真的返回 childId + 交接单 path。
  let verdict = 'failed';
  if (result.status === 200 && body.ok === true) {
    if (command === 'compact') {
      if (message.includes('压缩完成')) verdict = 'compacted';
      else if (message.includes('没有可安全压缩')) verdict = 'noop';
    } else if (command === 'handoff') {
      if (typeof body.childId === 'string' && typeof body.path === 'string') verdict = 'handed-off';
    }
  }
  print({
    command,
    sessionId,
    httpStatus: result.status,
    verdict,
    ...(verdict === 'noop' ? { note: '没有可安全压缩的内容（不是失败）' } : {}),
    ...body,
  });
  process.exit(verdict === 'failed' ? 1 : 0);
} catch (error) {
  console.error(`请求失败：${error?.message ?? error}`);
  process.exit(1);
}
