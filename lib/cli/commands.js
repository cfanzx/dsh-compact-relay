/**
 * `dcr-debug` 子命令实现（0.5.6 Phase A）。
 *
 * 只读原则：本文件只读本机 JSONL / 日志 / state 快照，或在 `state --url` 时发 GET。
 * 不写事件流、不触发任何压缩/交接、不联网（除本机回环）。
 *
 * 新命令的加法：
 *   1. 在 `lib/cli/main.js` 的 `COMMANDS` 表里加一行（名字 → handler + 允许的 flags + 用法）；
 *   2. 在这里实现 handler（返回进程退出码；输出直接 console.log）；
 *   3. 在 `docs/debugging.md` 补一段；测试放 `test/events-cli.mjs`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVENT_KEEP_FAILURES,
  collapseEvents,
  eventRowOf,
  exportRowOf,
  filterEvents,
  isFailureRow,
  shouldRecordFailure,
} from '../core/events.js';
import { summarizeLedgerRecords } from '../core/ledger.js';
import { assertNoLeak } from '../dsh/diagnostics.js';
import { defaultEventsPath, readEventsFile } from '../dsh/events.js';
import { readLedgerFile } from '../dsh/ledger.js';
import { defaultStateSnapshotPath, readStateSnapshot, STATE_SNAPSHOT_BYTE_LIMIT } from '../dsh/state-snapshot.js';
import { jsonlStat } from '../dsh/jsonl.js';
import { formatBytes, formatDuration, shortText, table } from './render.js';
import { exchangeToken, getJson, isLoopbackUrl, knownLogDirs, normalizeBaseUrl, tokenOf } from './host.js';

const EXIT = Object.freeze({ ok: 0, usage: 2, unreachable: 3, auth: 4, data: 5 });

/** 输出一行（便于测试 grep）。 */
function out(line = '') {
  console.log(line);
}

/** 事件文件路径：`--file` 优先（测试/排障），否则 `$DSH_HOME/...`。 */
function eventsFileOf(values) {
  return typeof values.file === 'string' && values.file.length > 0 ? values.file : defaultEventsPath();
}

/** 读全部原始事件（读失败 → []，由调用方决定提示）。 */
function readRaw(file) {
  return readEventsFile(file, { maxRows: Number.MAX_SAFE_INTEGER });
}

/** 事件文件概况行。 */
function fileSummary(file, total, failCount, cancelledCount) {
  const stat = jsonlStat(file);
  const rows = readRaw(file);
  const lastAt = rows.length === 0 ? '—' : rows[rows.length - 1].at ?? '—';
  const size = stat.exists ? formatBytes(stat.size) : '不存在';
  return (
    `${total} 条 / 全部 ${rows.length} 条（fail ${failCount}，cancelled ${cancelledCount}）` +
    ` · ${file} · ${size} · 最近写入 ${lastAt}`
  );
}

/** failures 的过滤口径：fail/cancelled/stalled，但排除 busy/changed 这类正常可重试状态。 */
function failureRowsOf(records) {
  return collapseEvents(records).filter((row) => {
    if (!isFailureRow(row)) return false;
    return shouldRecordFailure({ code: row.code ?? undefined, cancelled: row.outcome === 'cancelled' });
  });
}

/** 把上下文对象压成 `k=v k2=v2` 一行。 */
function contextTextOf(context) {
  if (context === null || typeof context !== 'object') return '—';
  return Object.entries(context)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

/* ------------------------------------------------------------------ *
 * events
 * ------------------------------------------------------------------ */

export function commandEvents(values, positionals) {
  if (positionals.length > 0) {
    out(`events 不接受位置参数：${positionals.join(' ')}`);
    return EXIT.usage;
  }
  const file = eventsFileOf(values);
  const raw = readRaw(file);
  if (raw.length === 0) {
    out(`还没有事件记录（${file}）。插件 < 0.5.6 或这次动作还没发生。`);
    return EXIT.ok;
  }
  const last = toPositiveInt(values.last, 20);
  const collapsed = collapseEvents(raw);
  const filtered = filterEvents(collapsed, {
    action: typeof values.action === 'string' ? values.action : undefined,
    outcome: typeof values.outcome === 'string' ? values.outcome : undefined,
    sessionId: typeof values.session === 'string' ? values.session : undefined,
  });
  const selected = last > 0 ? filtered.slice(-last) : filtered;
  const rows = [...selected].reverse(); // 最新在上

  if (values.raw === true) {
    const rawSelected = raw.filter((record) => selected.some((row) => row.id === record.id));
    if (values.json === true) out(JSON.stringify(rawSelected, null, 2));
    else {
      out(
        table(
          rawSelected.map((record) => [
            record.at,
            record.phase,
            record.action,
            record.outcome ?? '—',
            record.code ?? '—',
            record.id,
            shortText(record.message, 70),
          ]),
          { header: ['时间', '阶段', '动作', '结果', 'code', 'id', 'message'] },
        ),
      );
    }
    return EXIT.ok;
  }

  if (values.json === true) {
    // 机读模式：只输出 JSON（不掺摘要/提示），调用方可直接 JSON.parse。
    out(JSON.stringify(rows.map((row) => eventRowOf(row)), null, 2));
    return EXIT.ok;
  }
  {
    out(
      table(
        rows.map((row) => [
          row.at ?? '—',
          row.action,
          row.outcome ?? 'running',
          formatDuration(row.durationMs),
          row.trigger,
          row.code ?? '—',
          row.compactionId === null ? '—' : `comp ${shortText(row.compactionId, 12)}`,
          shortText(row.id, 22),
          shortText(row.message, 70),
        ]),
        { header: ['时间', '动作', '结果', '耗时', 'trigger', 'code', '关联', 'id', 'message'] },
      ),
    );
  }
  const failCount = collapsed.filter((row) => row.outcome === 'fail').length;
  const cancelledCount = collapsed.filter((row) => row.outcome === 'cancelled').length;
  out('');
  out(fileSummary(file, collapsed.length, failCount, cancelledCount));
  const latestFailure = collapsed.filter((row) => row.outcome === 'fail').slice(-1)[0];
  if (latestFailure !== undefined) out(`下一步：node scripts/dcr-debug.mjs show ${latestFailure.id}`);
  return EXIT.ok;
}

/* ------------------------------------------------------------------ *
 * failures
 * ------------------------------------------------------------------ */

export function commandFailures(values, positionals) {
  if (positionals.length > 0) {
    out(`failures 不接受位置参数：${positionals.join(' ')}`);
    return EXIT.usage;
  }
  const file = eventsFileOf(values);
  const raw = readRaw(file);
  if (raw.length === 0) {
    out(`本机还没有事件文件（${file}）。插件 < 0.5.6 或这次动作还没发生。`);
    return EXIT.ok;
  }
  const last = toPositiveInt(values.last, 10);
  let failures = failureRowsOf(raw);
  if (typeof values.action === 'string' && values.action.length > 0) {
    failures = failures.filter((row) => row.action === values.action);
  }
  const selected = last > 0 ? failures.slice(-last) : failures;

  if (values.json === true) {
    out(JSON.stringify(selected.map((row) => eventRowOf(row)), null, 2));
    return EXIT.ok;
  }
  if (selected.length === 0) {
    out('没有失败记录（busy/changed 这类正常可重试状态不算失败）。');
  } else {
    for (const row of [...selected].reverse()) {
      out(`${row.at}  ${row.action}  ${row.outcome}  code=${row.code ?? '—'}  trigger=${row.trigger}`);
      out(`  id=${row.id}  session=${row.sessionId ?? '—'}  duration=${formatDuration(row.durationMs)}`);
      out(`  message: ${row.message ?? '（无）'}`);
      out(`  context: ${contextTextOf(row.context)}`);
      out(`  详情：node scripts/dcr-debug.mjs show ${row.id}`);
      out('');
    }
  }
  out(
    `共 ${failures.length} 条失败/取消 · 失败保护保留最近 ${EVENT_KEEP_FAILURES} 条 · ` +
      `文件 ${file} · ${formatBytes(jsonlStat(file).size)}`,
  );
  out('导出给用户：node scripts/dcr-debug.mjs export --out <文件.md>');
  return EXIT.ok;
}

/* ------------------------------------------------------------------ *
 * show
 * ------------------------------------------------------------------ */

export function commandShow(values, positionals) {
  const token = positionals[0];
  if (typeof token !== 'string' || token.length === 0) {
    out('用法：dcr-debug show <id>（支持 id 末尾 8 位前缀）');
    return EXIT.usage;
  }
  const file = eventsFileOf(values);
  const raw = readRaw(file);
  const matched = raw.filter((record) => matchEventId(record.id, token));
  if (matched.length === 0) {
    out(`没有找到 id=${token} 的事件（${file}）。可用 events --last 20 看最近的 id。`);
    return EXIT.ok;
  }
  if (values.json === true) {
    out(JSON.stringify(matched, null, 2));
    return EXIT.ok;
  }
  const id = matched[0].id;
  const start = matched.find((record) => record.phase === 'start') ?? null;
  const end = matched.find((record) => record.phase === 'end') ?? null;
  const base = end ?? start;
  out(`■ ${base.action}  ${end === null ? 'stalled/running' : end.outcome}  ${formatDuration(base.durationMs)}`);
  out(`  start  ${start === null ? '—（没有 start 行）' : start.at}        end  ${end === null ? '—' : end.at}`);
  out(`  trigger : ${base.trigger}${base.actor === 'user' ? '' : `  actor : ${base.actor}`}`);
  out(`  session : ${base.sessionId ?? '—'}`);
  if (base.compactionId !== null) out(`  compaction : ${base.compactionId}`);
  if (base.planId !== null) out(`  plan : ${base.planId}`);
  if (base.childId !== null) out(`  child : ${base.childId}`);
  if (end !== null && end.code !== null) out(`  code : ${end.code}`);
  out(`  message : ${base.message ?? '—'}`);
  out(`  context : ${contextTextOf(base.context)}`);
  const lines = rawLinesOf(file);
  const lineNumbers = [];
  lines.forEach((line, index) => {
    if (line.includes(`"id":"${id}"`)) lineNumbers.push(index + 1);
  });
  out(`  记录 : ${file}:${lineNumbers.length === 0 ? '?' : lineNumbers.join(',')}`);
  return EXIT.ok;
}

/** id 匹配：完整 id 或末尾片段（8 位 hex / 带 evt- 前缀都行）。 */
function matchEventId(id, token) {
  if (typeof id !== 'string') return false;
  const wanted = token.trim();
  if (wanted.length === 0) return false;
  if (id === wanted) return true;
  return id.endsWith(wanted) || id.endsWith(`-${wanted}`);
}

function rawLinesOf(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

export async function commandState(values) {
  if (typeof values.url === 'string' && values.url.length > 0 && values.offline !== true) {
    return liveState(values);
  }
  const file = defaultStateSnapshotPath();
  const snapshot = readStateSnapshot(file);
  if (snapshot === null) {
    out(`还没有 state 快照（${file}）。`);
    out('快照由插件在 state 刷新时写入（≤8KB、10s 节流）；若插件 < 0.5.6，请用 --url 直连宿主。');
    return EXIT.ok;
  }
  if (values.json === true) {
    out(JSON.stringify(snapshot, null, 2));
    return EXIT.ok;
  }
  printStateBlock(snapshot.state, {
    source: `snapshot（${file} · ${snapshot.at}）`,
    sessionId: snapshot.sessionId,
    version: snapshot.v,
  });
  return EXIT.ok;
}

/** 直连宿主端点（必须回环；401/403 → 退出 4；连不上 → 退出 3）。 */
async function liveState(values) {
  const base = normalizeBaseUrl(values.url);
  if (!isLoopbackUrl(base)) {
    out(`拒绝非本机地址：${base}（只允许 127.0.0.1 / localhost / ::1）`);
    return EXIT.usage;
  }
  const token = tokenOf(base);
  const cleanBase = base.split('?')[0];
  let cookie;
  if (typeof token === 'string' && token.length > 0) {
    const exchanged = await exchangeToken(cleanBase, token);
    if (!exchanged.ok) {
      out(`换 cookie 失败（auth: ${exchanged.error ?? `connect ${exchanged.status}`}）`);
      return EXIT.auth;
    }
    cookie = exchanged.cookie;
  }
  const sessionQuery =
    typeof values.session === 'string' && values.session.length > 0
      ? `?sessionId=${encodeURIComponent(values.session)}`
      : '';
  const result = await getJson(`${cleanBase}/api/compact-relay-state${sessionQuery}`, { cookie });
  if (result.status === 401 || result.status === 403) {
    out(`宿主可达但鉴权失败（${result.status}）。请在 DSH 界面里复制带 token 的地址，再：`);
    out(`  node scripts/dcr-debug.mjs state --url '<带 token 的地址>'`);
    return EXIT.auth;
  }
  if (result.status === null) {
    out(`宿主不可达：${result.error ?? 'unknown'}（地址 ${cleanBase}）`);
    return EXIT.unreachable;
  }
  if (values.json === true) {
    out(JSON.stringify(result.body, null, 2));
    return EXIT.ok;
  }
  if (!result.ok || result.body === null) {
    out(`宿主返回 ${result.status}，没有可用 state。`);
    return EXIT.unreachable;
  }
  printStateBlock(result.body, { source: `live（${cleanBase}）`, sessionId: result.body.sessionId });
  return EXIT.ok;
}

/** state 摘要（快照/端点共用；字段与 /api/compact-relay-state 同名）。 */
function printStateBlock(state, { source, sessionId, version }) {
  if (state === null || typeof state !== 'object') {
    out(`state: 无活动会话（source: ${source}）`);
    return;
  }
  const window = Number.isFinite(state.window) ? state.window : null;
  const tokens = Number.isFinite(state.tokens) ? state.tokens : null;
  const percent = window !== null && window > 0 && tokens !== null ? `${((tokens / window) * 100).toFixed(1)}%` : '—';
  out(`source : ${source}`);
  out(`session: ${sessionId ?? '—'}${version === undefined || version === null ? '' : `  插件 ${version}`}`);
  out(
    `state  : 压力 ${tokens ?? '—'}/${window ?? '—'} (${percent}) · 摘要 ${state.summaries ?? '—'} · ` +
      `advice=${state.advice ?? '—'} · busy=${state.busy === true ? 'true' : 'false'}`,
  );
  const native = state.nativeAuto !== null && typeof state.nativeAuto === 'object' ? state.nativeAuto : null;
  const range = state.compactRange !== null && typeof state.compactRange === 'object' ? state.compactRange : null;
  out(
    `         原生线 ${native === null ? '—' : native.lineRatio ?? '—'} · 可压范围 ` +
      `${range === null ? '—' : `${range.nodes} 条 / ${range.tokens} tokens`}`,
  );
}

/* ------------------------------------------------------------------ *
 * logs
 * ------------------------------------------------------------------ */

export function commandLogs(values) {
  const tail = toPositiveInt(values.tail, 80);
  const grep = typeof values.grep === 'string' && values.grep.length > 0 ? values.grep : 'compact-relay';
  const lines = [];
  for (const dir of knownLogDirs()) {
    for (const file of listLogFiles(dir)) {
      const text = readTail(file, 512 * 1024);
      for (const line of text.split('\n')) {
        if (line.length === 0) continue;
        if (!line.includes(grep)) continue;
        lines.push({ file, line });
      }
    }
  }
  if (lines.length === 0) {
    out(`已知日志位置里没有含「${grep}」的行（${knownLogDirs().join(' / ')}）。`);
    out('提示：macOS 桌面宿主的 stdout 不进常规日志文件；失败请看事件流：dcr-debug failures');
    return EXIT.ok;
  }
  for (const entry of lines.slice(-tail)) out(`${path.basename(entry.file)}: ${entry.line}`);
  return EXIT.ok;
}

function listLogFiles(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.log') || name.endsWith('.txt'))
      .map((name) => path.join(dir, name))
      .sort((left, right) => {
        try {
          return fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs;
        } catch {
          return 0;
        }
      });
  } catch {
    return [];
  }
}

function readTail(file, bytes) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(file, 'r');
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

export function commandExport(values) {
  const outFile = typeof values.out === 'string' ? values.out : '';
  if (outFile.length === 0) {
    out('用法：dcr-debug export --out <文件.md> [--last N] [--force]');
    return EXIT.usage;
  }
  const target = path.resolve(outFile.replace(/^~(?=\/|$)/u, os.homedir()));
  if (fs.existsSync(target) && values.force !== true) {
    out(`目标已存在，不覆盖：${target}（加 --force 才覆盖）`);
    return EXIT.usage;
  }
  const file = eventsFileOf(values);
  const raw = readRaw(file);
  const last = toPositiveInt(values.last, 30);
  const collapsed = collapseEvents(raw);
  const actions = collapsed.slice(-last).map((row) => exportRowOf(row));
  const failures = failureRowsOf(raw).slice(-10).map((row) => exportRowOf(row));
  const snapshot = readStateSnapshot();
  const ledger = summarizeLedgerRecords(readLedgerFile());
  const payload = {
    schema: 'dcr-debug-export/v1',
    generatedAt: new Date().toISOString(),
    pluginVersion: pluginVersionOf(),
    events: {
      file: 'compact-relay-events.jsonl',
      rows: raw.length,
      total: collapsed.length,
      // 真正判一次目录可写（不是「文件存在」）；写不进去时导出仍可读旧数据。
      writeable: (() => {
        try {
          fs.accessSync(path.dirname(file), fs.constants.W_OK);
          return true;
        } catch {
          return false;
        }
      })(),
      recentActions: actions,
      recentFailures: failures,
    },
    state:
      snapshot === null
        ? null
        : {
            at: snapshot.at,
            version: snapshot.v,
            sessionId: mask(snapshot.sessionId),
            state: snapshot.state,
          },
    ledger,
  };
  const markdown = renderExportMarkdown(payload, { file, last });
  const check = assertNoLeak(markdown);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdown, 'utf8');
  } catch (error) {
    out(`写文件失败：${error instanceof Error ? error.message : String(error)}`);
    return EXIT.data;
  }
  const size = fs.statSync(target).size;
  out(`已导出：${target}（${formatBytes(size)}）`);
  if (check.ok !== true) out(`脱敏自检命中 ${check.hits.length} 类（${check.hits.join(', ')}），请先检查再外发。`);
  return EXIT.ok;
}

/** 外发档 session 遮蔽（与 core/redact.maskSessionId 同口径；避免 CLI 依赖 actions）。 */
function mask(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length <= 8 ? value : `…${[...value].slice(-8).join('')}`;
}

function pluginVersionOf() {
  try {
    const file = path.resolve(import.meta.dirname, '..', '..', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function renderExportMarkdown(payload, { file, last }) {
  const lines = [];
  lines.push('# dcr 诊断包（dcr-debug export）');
  lines.push('');
  lines.push(`- 生成时间：${payload.generatedAt}`);
  lines.push(`- 插件版本：${payload.pluginVersion ?? '—'}`);
  lines.push('- 数据源：本机 `$DSH_HOME`（不写绝对路径；message 已脱敏）');
  lines.push('- 用途：贴进 issue / 回传给维护者；不要把原始事件文件直接公开');
  lines.push('');
  lines.push('## 概览');
  lines.push('');
  lines.push(`- 事件行数：${payload.events.rows}（折叠后动作 ${payload.events.total} 条）`);
  lines.push(`- 最近动作：${payload.events.recentActions.length} 条（本次导出取最近 ${last} 条）`);
  lines.push(`- 最近失败：${payload.events.recentFailures.length} 条（失败保护保留 ${EVENT_KEEP_FAILURES} 条）`);
  lines.push(`- 轻账本累计：压缩 ${payload.ledger.compactCount} 次 / 交接 ${payload.ledger.handoffCount} 次 / 腾出 ${payload.ledger.freedTokens} tokens`);
  lines.push('');
  lines.push('## 最近动作');
  lines.push('');
  if (payload.events.recentActions.length === 0) {
    lines.push('- （无）');
  } else {
    for (const row of payload.events.recentActions) {
      lines.push(
        `- ${row.at} · ${row.action} · ${row.outcome ?? 'running'} · ${formatDuration(row.durationMs)} · ` +
          `trigger=${row.trigger} · code=${row.code ?? '—'} · id=${row.id}`,
      );
    }
  }
  lines.push('');
  lines.push('## 最近失败');
  lines.push('');
  if (payload.events.recentFailures.length === 0) {
    lines.push('- （无）');
  } else {
    for (const row of payload.events.recentFailures) {
      lines.push(`### ${row.action} · ${row.code ?? 'internal'} · ${row.outcome}`);
      lines.push('');
      lines.push(`- 时间：${row.at} · id：${row.id} · trigger：${row.trigger}`);
      lines.push(`- session：${row.sessionId ?? '—'}`);
      lines.push(`- message：${row.message ?? '（无）'}`);
      lines.push(`- context：${contextTextOf(row.context)}`);
      lines.push('');
    }
  }
  lines.push('## state 快照');
  lines.push('');
  if (payload.state === null) {
    lines.push('- （无：插件还没写过快照，或本机没有活动会话）');
  } else {
    const state = payload.state.state;
    lines.push(`- 快照时间：${payload.state.at} · 插件 ${payload.state.version ?? '—'} · session ${payload.state.sessionId ?? '—'}`);
    lines.push(`- 压力：${state.tokens ?? '—'} / ${state.window ?? '—'}（ratio ${state.ratio ?? '—'}）`);
    lines.push(`- 摘要：${state.summaries ?? '—'} · 建议：${state.advice ?? '—'} · 原生线：${state.nativeAuto?.lineRatio ?? '—'}`);
  }
  lines.push('');
  lines.push('## 文件');
  lines.push('');
  lines.push(`- compact-relay-events.jsonl：${formatBytes(jsonlStat(file).size)}（行数上限 800、失败保护 ${EVENT_KEEP_FAILURES}）`);
  lines.push(`- compact-relay-state.json：${formatBytes(jsonlStat(defaultStateSnapshotPath()).size)}（上限 ${formatBytes(STATE_SNAPSHOT_BYTE_LIMIT)}）`);
  lines.push(`- compact-relay-ledger.jsonl：${formatBytes(jsonlStat(path.join(path.dirname(file), 'compact-relay-ledger.jsonl')).size)}（只读；只含数值）`);
  lines.push('');
  lines.push('## 机读块（JSON）');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(payload, null, 2));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

/** 十进制正整数参数；非法/缺省 → fallback。 */
function toPositiveInt(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export { EXIT };
