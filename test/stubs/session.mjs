/**
 * `@deepseek-ai/dsh-session` 测试替身 —— 只实现 M4 用到的经 appendPluginRecord。
 *
 * 真实契约（DSH 0.2）：往会话日志追加一条 `ignorable` 的 `plugin:` 事件，
 * 不进模型可见 surface，返回事件 seq。这里转交给 mock session 自己记录。
 */
export function appendPluginRecord(session, type, data) {
  if (session === null || typeof session !== 'object' || typeof session.appendPluginRecord !== 'function') {
    throw new Error('appendPluginRecord: session does not support plugin records');
  }
  return session.appendPluginRecord(type, data);
}
