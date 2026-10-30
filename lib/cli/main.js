/**
 * `dcr-debug` CLI 入口（0.5.6 Phase A）—— 零依赖、只读、只发本机 GET。
 *
 * 为什么本体放 `lib/cli/`：npm 包的 `files` 白名单包含 `lib`，这样**换一台机器**
 * （Windows 用户回传诊断）也能用；`scripts/dcr-debug.mjs` 只是 3 行 wrapper。
 *
 * 用法（详见 docs/debugging.md）：
 *   node scripts/dcr-debug.mjs events --last 20 [--action X] [--outcome fail]
 *   node scripts/dcr-debug.mjs failures
 *   node scripts/dcr-debug.mjs show <id>
 *   node scripts/dcr-debug.mjs state [--url <带 token 的本机地址>]
 *   node scripts/dcr-debug.mjs logs [--tail 80] [--grep compact-relay]
 *   node scripts/dcr-debug.mjs export --out <文件.md> [--force]
 *
 * 退出码：0 成功（含 0 条记录）；2 用法错误；3 宿主不可达；4 宿主鉴权失败；
 * 5 数据文件读不了/写失败。
 */
import { commandEvents, commandExport, commandFailures, commandLogs, commandShow, commandState, EXIT } from './commands.js';

const COMMANDS = Object.freeze({
  events: {
    handler: commandEvents,
    flags: ['last', 'action', 'outcome', 'session', 'json', 'file', 'raw', 'help'],
    usage: 'events [--last N] [--action X] [--outcome fail] [--session S] [--raw] [--json] [--file P]',
    summary: '动作事件表（默认折叠 start/end）',
  },
  failures: {
    handler: commandFailures,
    flags: ['last', 'action', 'json', 'file', 'help'],
    usage: 'failures [--last N] [--action X] [--json] [--file P]',
    summary: '最近失败/取消（含宿主原始 message 与 context）',
  },
  show: {
    handler: commandShow,
    flags: ['json', 'file', 'help'],
    usage: 'show <id> [--json] [--file P]',
    summary: '一条动作的 start/end 两阶段 + 完整 context + 文件行号',
  },
  state: {
    handler: commandState,
    flags: ['url', 'session', 'json', 'offline', 'help'],
    usage: 'state [--url <本机地址>] [--session S] [--json] [--offline]',
    summary: '压力/摘要/原生线（默认读 state 快照，--url 时只读 GET 宿主）',
  },
  logs: {
    handler: commandLogs,
    flags: ['tail', 'grep', 'help'],
    usage: 'logs [--tail N] [--grep S]',
    summary: '从已知日志位置捞 compact-relay 相关行',
  },
  export: {
    handler: commandExport,
    flags: ['out', 'last', 'force', 'file', 'help'],
    usage: 'export --out <文件.md> [--last N] [--force] [--file P]',
    summary: '自包含诊断包（Markdown + 内嵌 JSON，已脱敏）',
  },
});

/** 打印总帮助。 */
function printHelp() {
  console.log('dcr-debug —— dsh-compact-relay 0.5.6 只读诊断 CLI');
  console.log('');
  console.log('用法：node scripts/dcr-debug.mjs <命令> [参数]');
  console.log('');
  for (const [name, definition] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(9)} ${definition.summary}`);
    console.log(`            ${definition.usage}`);
  }
  console.log('');
  console.log('退出码：0 成功；2 用法错误；3 宿主不可达；4 宿主鉴权失败；5 数据文件错误');
  console.log('数据位置：$DSH_HOME（缺省 ~/.dsh）下的 compact-relay-events.jsonl / compact-relay-state.json');
}

/** 打印单命令帮助。 */
function printCommandHelp(name) {
  const definition = COMMANDS[name];
  console.log(`${name} —— ${definition.summary}`);
  console.log(`用法：node scripts/dcr-debug.mjs ${definition.usage}`);
}

/**
 * 极简 argv 解析：`--name value` / `--name=value` / `--flag`；`-h` = help。
 * @param {string[]} argv
 * @returns {{command:string|null, positionals:string[], flags:Record<string,string|true>, help:boolean}}
 */
export function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        flags[name] = next;
        index += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  const command = positionals.length > 0 ? positionals.shift() : null;
  return { command, positionals, flags, help };
}

/**
 * CLI 主入口（wrapper 调用；测试可直接 import）。
 * @param {string[]} argv 不含 node/脚本名
 * @returns {Promise<number>} 进程退出码
 */
export async function main(argv) {
  const parsed = parseArgv(Array.isArray(argv) ? argv : []);
  if (parsed.help === true && parsed.command === null) {
    printHelp();
    return EXIT.ok;
  }
  if (parsed.command === null) {
    printHelp();
    return EXIT.ok;
  }
  const definition = COMMANDS[parsed.command];
  if (definition === undefined) {
    console.log(`未知命令：${parsed.command}`);
    printHelp();
    return EXIT.usage;
  }
  if (parsed.help === true || parsed.flags.help === true) {
    printCommandHelp(parsed.command);
    return EXIT.ok;
  }
  const unknown = Object.keys(parsed.flags).filter((name) => !definition.flags.includes(name));
  if (unknown.length > 0) {
    console.log(`未知参数：${unknown.map((name) => `--${name}`).join(' ')}`);
    console.log(`用法：node scripts/dcr-debug.mjs ${definition.usage}`);
    return EXIT.usage;
  }
  try {
    return await definition.handler(parsed.flags, parsed.positionals);
  } catch (error) {
    console.error(`dcr-debug 内部错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return EXIT.data;
  }
}
