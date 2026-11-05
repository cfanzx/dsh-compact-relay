/** Opt-in real SDK contract checks. No host boot, profile, network or model calls.
 * DCR_DSH_NODE_MODULES=/isolated/extracted/dsh/node_modules node test/dsh-runtime-contract.mjs
 * The supplied modules must be an unmodified copy of the target DSH runtime.
 * Deliberately separate from npm test: a source checkout has no runtime dependencies.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const suppliedRoot = process.env.DCR_DSH_NODE_MODULES;
assert.ok(suppliedRoot && path.isAbsolute(suppliedRoot), 'Set DCR_DSH_NODE_MODULES to an absolute isolated runtime node_modules directory');
// Canonicalize symlinks (e.g. macOS /tmp -> /private/tmp) to avoid duplicate SDK class identities.
const root = fs.realpathSync(suppliedRoot);
const packageDir = (name) => path.join(root, '@deepseek-ai', name);
for (const name of ['dsh-session', 'dsh-compaction', 'dsh-llm', 'dsh-tools', 'dsh-session-format-v3-to-v4', 'dsh-client-connection']) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir(name), 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.2-rc.1', `${name}: this regression targets an unmixed 0.2.2-rc.1 SDK`);
  console.log(`Real SDK ${name}: ${pkg.version}`);
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^@deepseek-ai\/dsh-(compaction|llm|session|tools)$/u.test(specifier)) {
      return { url: pathToFileURL(path.join(root, specifier, 'lib/index.js')).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const load = (name) => import(pathToFileURL(path.join(packageDir(name), 'lib/index.js')).href);
const [{ Session }, llm, { assertV4RowAdmission }, { HostConnectionService }, { default: engine }, { replaceRangeWithSummary }] = await Promise.all([
  load('dsh-session'), load('dsh-llm'), load('dsh-session-format-v3-to-v4'), load('dsh-client-connection'),
  import('../lib/dsh/engine.js'), import('../lib/dsh/compact-transaction.js'),
]);

function session() {
  const value = new Session('dcr-isolated-runtime-contract');
  for (const text of ['first', 'second', 'retained tail']) {
    value.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  }
  return value;
}
const range = { startSeq: 0, endSeq: 1, shadowedSeqs: [0, 1], shadowedTokenCount: 1000 };
const summary = async () => ({ summary: [{ type: 'text', text: 'deterministic local summary' }], provider: 'stub', model: 'stub' });
const cases = [];
const test = (name, run) => cases.push({ name, run });

test('real Session + real engine: DCR replacement and V4 row/source admission', async () => {
  const value = session();
  let flushed = 0;
  const result = await replaceRangeWithSummary({ session: value, range, engine, summarize: summary, flush: async () => { flushed += 1; } });
  assert.equal(flushed, 1);
  assert.deepEqual(value.surface.nodes, [result.replaceSeq, 2]);
  const checkpoint = value.eventAt(result.replaceSeq);
  assert.deepEqual(checkpoint.sourceEventSeqs, [3, 4, 0, 1]);
  assert.equal(engine.isCompactCheckpointSource(checkpoint.data.source), true);
  for (const row of value.log) assertV4RowAdmission(row);
  assert.deepEqual(value.log.slice(3).map((row) => row.type), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
});

test('real Session: model failure closes lifecycle; same range can retry', async () => {
  const value = session();
  let flushed = 0;
  await assert.rejects(replaceRangeWithSummary({ session: value, range, engine, flush: async () => { flushed += 1; }, summarize: async () => { throw new Error('local model failure'); } }), /local model failure/u);
  assert.equal(flushed, 0, 'known v0.5.7 difference: failed lifecycle closure is in-memory only, not a durability check');
  assert.deepEqual(value.surface.nodes, [0, 1, 2]);
  assert.equal(value.log.at(-1).type, 'compaction/end');
  assert.ok(value.log.at(-1).data.error);
  await replaceRangeWithSummary({ session: value, range, engine, summarize: summary });
  assert.equal(value.surface.nodes.length, 2);
});

test('real Session: cancellation during summary closes lifecycle without replace', async () => {
  const value = session();
  const controller = new AbortController();
  let flushed = 0;
  await assert.rejects(replaceRangeWithSummary({ session: value, range, engine, flush: async () => { flushed += 1; }, signal: controller.signal, summarize: async () => { controller.abort(); return summary(); } }), (error) => error.code === 'cancelled');
  assert.equal(flushed, 0, 'known v0.5.7 difference: cancelled closure is not explicitly flushed');
  assert.deepEqual(value.surface.nodes, [0, 1, 2]);
  assert.deepEqual(value.log.slice(3).map((row) => row.type), ['compaction/start', 'compaction/end']);
});

test('real Session: changed surface closes without replacement; persistence error retains committed checkpoint', async () => {
  const changed = session();
  await assert.rejects(replaceRangeWithSummary({ session: changed, range, engine, summarize: async () => {
    changed.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text: 'concurrent change' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, sourceEventSeqs: [0, 1] });
    return summary();
  } }), (error) => error.code === 'changed');
  assert.equal(changed.log.at(-1).type, 'compaction/end');
  assert.ok(changed.log.at(-1).data.error);
  assert.equal(changed.log.some((row) => row.type === 'compaction/summary'), false);

  const value = session();
  let flushed = 0;
  await assert.rejects(replaceRangeWithSummary({ session: value, range, engine, summarize: summary, flush: async () => { flushed += 1; throw new Error('isolated disk failure'); } }), (error) => error.code === 'persistence');
  assert.equal(flushed, 1);
  assert.equal(value.surface.nodes.length, 2, 'a persistence error must not claim the in-memory commit was rolled back');
  assert.equal(value.log.filter((row) => row.type === 'compaction/end').length, 1);
  assert.equal(value.log.at(-1).data.error, undefined);
});

test('real V4 admission: producer-owned handoff source accepted, retired plugin kind rejected', () => {
  const row = { type: 'user/message', seq: 0, time: Date.now(), surfaceOp: 'append', data: llm.createUserMessage({ content: [{ type: 'text', text: 'isolated handoff' }], source: { kind: 'plugin:compact-relay', form: 'handoff' } }) };
  assert.doesNotThrow(() => assertV4RowAdmission(row));
  assert.throws(() => assertV4RowAdmission({ ...row, data: { ...row.data, source: { kind: 'plugin' } } }));
  const value = session();
  const before = [...value.surface.nodes];
  engine.appendPluginRecord(value, 'plugin:compact-relay/relay', { parentId: 'parent', childId: value.id });
  assert.deepEqual(value.surface.nodes, before);
  assert.equal(value.log.at(-1).ignorable, true);
  assertV4RowAdmission(value.log.at(-1));
});

test('real HostConnectionService: synchronous 403/401/browser/API admission, no credentials read', () => {
  // Never construct/apply the service: only its real admission methods run on harmless local inputs.
  const connection = Object.create(HostConnectionService.prototype);
  connection.owner = { get: () => ({ protocol: 'http:' }) };
  connection.browserPeer = { id: 'browser' };
  connection.peers = new Map([['api', { peer: { id: 'api' } }]]);
  let trusted = false;
  let authenticated = false;
  let api;
  connection.isTrusted = () => trusted;
  connection.browserAuth = { isAuthenticated: () => authenticated, authenticateApi: () => api };
  const request = { headers: {} };
  assert.equal(connection.requestRejection(request), 403);
  trusted = true;
  assert.equal(connection.requestRejection(request), 401);
  authenticated = true;
  assert.equal(connection.requestRejection(request), undefined);
  authenticated = false;
  api = 'api';
  assert.equal(connection.requestRejection(request), undefined);
  connection.disposed = true;
  assert.equal(connection.requestRejection(request), 401);
});

let passed = 0;
for (const { name, run } of cases) {
  try { await run(); passed += 1; console.log(`PASS  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}`, error); process.exitCode = 1; }
}
console.log(`real-runtime-contract: ${passed}/${cases.length} passed`);
