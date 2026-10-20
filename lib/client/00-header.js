/**
 * dsh-compact-relay —— 浏览器半（DSH client bundle）。
 *
 * 职责：输入框左侧指示灯 / 悬停卡 / 菜单 / 压缩确认卡 / 交接单面板 / toast，
 *       以及 /handoff 命令卡（命令成功后自动切到新会话）。
 * 数据：GET /api/compact-relay-state、SSE /api/compact-relay-stream；
 * 动作：POST /api/compact-relay-action；交接单：GET /api/compact-relay-handoffs。
 *
 * 为什么是单文件：DSH 运行时没有打包器，package.json exports["./client"]
 * 必须指向已构建好的单文件 bundle；拆模块会报 client bundle not found。
 */
