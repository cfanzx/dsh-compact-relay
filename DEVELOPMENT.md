# Development

How this plugin is built, tested and shipped. For usage, see [README.md](README.md) (简体中文) / [README.en.md](README.en.md) (English); for the design, see [ARCHITECTURE.md](ARCHITECTURE.md); for the frozen requirements, see [REQUIREMENTS.md](REQUIREMENTS.md). 中文说明：这是给想改这个插件的开发者看的；用户文档见 README.md 与 TUTORIAL.md。

## Requirements

- Node.js 22.15+ for running the test suite (the harness uses `node:module.registerHooks`, added in 22.15; 22.11+ throws "does not provide an export named 'registerHooks'"). No runtime dependencies; nothing to `npm install` for the unit tests. Verified on macOS (Node 24.21) and Windows 11 (Node 24.22).
- DSH Desktop or `dsh web` 0.2.x if you want to see anything in a real UI
- Google Chrome for the end-to-end tests (macOS paths are in [test/e2e/README.md](test/e2e/README.md))

## Repository layout

```
lib/
  index.js          plugin entry: wiring, inject, effect()
  core/             pure logic — no DSH imports (config schema, ring math, colors,
                    handoff spec, placeholders, readiness, ...)
  dsh/              host seams — the only place that imports @deepseek-ai/* APIs
                    (0.4 P0-2 diagnostics: diag-counters.js counters/p50-p95/error codes,
                    diagnostics.js allowlist report + redaction, no IO and no network)
  actions/          business actions (compaction, handoff, pin, native toggle, preview, lock,
                    diagnostics — the 0.4 P0-2 data picker shared by the HTTP adapter)
  adapters/         registration surfaces (slash commands, HTTP routes, model tools)
  client/           browser half, split into ordered fragments 00…90
  client.js         build artifact — generated, never edit by hand
scripts/
  build-client.mjs  stitches lib/client/*.js into lib/client.js
test/
  smoke.mjs handoff.mjs plugin-load.mjs contract.mjs compact-log.mjs diagnostics.mjs
  harness/          mock DSH host + session + LLM for unit/integration tests
  e2e/              real-GUI tests (isolated DSH home + headless Chrome)
```

## Commands

```sh
npm test                    # build-client --check + all unit/integration tests
npm run test:e2e            # isolated DSH + Chrome end-to-end smoke
npm run test:e2e:settings   # Settings UI end-to-end
npm run test:e2e:compact    # real-model compaction + old-summary merge end-to-end

node scripts/build-client.mjs   # rebuild lib/client.js from lib/client/*
```

`npm test` starts by checking that `lib/client.js` matches the fragments; a stale artifact fails the suite on purpose.

## Editing the browser half

1. Edit a fragment under `lib/client/` (`30-indicator.js`, `50-settings.js`, …). Files are stitched in filename order: `00-*` opens the bundle wrapper, `90-*` closes it — don't reorder them.
2. Rebuild: `node scripts/build-client.mjs`.
3. Never edit `lib/client.js` directly, and commit the rebuilt artifact (DSH loads it straight from the package).
4. Run `npm test`.

The client talks to the host through two endpoints: `GET /api/compact-relay-state` (snapshot) and `GET /api/compact-relay-stream` (SSE, 150ms debounce, first frame immediately). Every state frame carries a monotonic `revision`; the client drops late frames.

## Trying your changes against a real DSH

```sh
# 1. put the source somewhere
git clone https://github.com/cfanzx/dsh-compact-relay ~/.dsh/vendor/dsh-compact-relay

# 2. point the profile at it
#    <profile>/package.json → "dsh-compact-relay": "file:/absolute/path"
#    <profile>/package.json → dsh.profile.bundles += "dsh-compact-relay"

# 3. install and restart
cd "$DSH_HOME/profiles/<profile>" && pnpm install   # or: corepack pnpm install
# restart DSH
```

- Host-half and browser-half changes both need a **DSH restart**; saving settings inside the plugin does not.
- pnpm installs `file:` dependencies as **hard links**: editing existing files is picked up, but **new files or directories need a fresh `pnpm install`** before they exist in the profile.
- While developing, use the `file:` dependency. `dsh plugin add` is for npm/git installs of released versions.

## Data the plugin touches

- `$DSH_HOME/compact-relay.json` — user settings overlay (written by the Settings page)
- `$DSH_HOME/handoffs/` — handoff documents
- `<profile>/cordis.patch.yml` — written **only** by the native auto-compaction toggle, after backing up to `.bak-dcr-*`

## DSH 0.2 API seams worth knowing

Collected from building this plugin; they are the traps that fail silently:

- **Agent-scoped services.** `compaction` is agent-scoped (per-preset isolate group). A root-level plugin that injects `'compaction'` stays pending forever: `apply()` never runs, so commands and HTTP routes never register — while the browser half still loads and the indicator still shows, which makes it look fine.
- **Commands with arguments need `input`.** A slash command only receives parameters when its definition declares `input` (e.g. `input: { hint: 'confirm' }`). Otherwise `/cmd confirm` is sent to the model as a normal prompt.
- **v4 messages need producer-owned source kinds.** Injected messages must use `{ kind: 'plugin:<name>', form: ... }`; `{ kind: 'plugin' }` is rejected mid-turn with a format error.
- **`ctx.agents` has `get()` / `list()`, no `values()`.** Enumerating with `values()` returns nothing — state then shows `sessionId: null` and actions 409, silently.
- **No `ctx.sessions.open()`.** Use `ctx.uiWorkspace.openSession(id)`, and only for ids already in the client session list (poll `ctx.sessions.list.getSnapshot().byId[id]`).
- **Blank sessions render the hero page.** Appending a message to a blank session is invisible in 0.2; use `followup()` to inject and start the first turn.
- **`agents.create` needs a mounted preset**, otherwise the child session has no system prompt or tools. Its `meta` only accepts a fixed field set (cwd / parentSession / agentPreset / isSeeded / origin / delegationDepth) — don't put `title` there.
- **Peer ranges need an explicit prerelease branch.** `>=0.2.0-0 <0.3.0` silently excludes `0.2.1-rc.2` under node-semver; use
  `>=0.2.0-0 <0.2.1-0 || >=0.2.1-0 <0.3.0-0`.
- **Compaction transaction rules** (see `lib/actions/better-compact.js`): `sourceEventSeqs` must include every shadowed surface node; `compaction/start` and `compaction/end` must be paired even on failure; run the transaction inside `agent.runMaintenance()`; replay the full prefix before the instruction or the KV cache misses.

## Debugging

- **Isolated DSH boot with stderr**: copy `$DSH_HOME` (or just the profile) to a temp directory, run the desktop host entry with `ELECTRON_RUN_AS_NODE=1` and `DSH_HOME=<temp>`, and read the stderr — plugin activation failures and pending services are printed there. The printed GUI URL contains a token, so you can `curl` plugin endpoints.
- **State endpoint**: `GET /api/compact-relay-state?sessionId=…` is the quickest way to see what the host thinks.
- **Tests use isolated homes.** The e2e harness rsyncs the real DSH home into a temp dir; nothing in the tests may write to the real profile or sessions.
- **Real-GUI testing without a screen**: headless Chrome + CDP against the isolated GUI (see `test/e2e/`). Do not attach to someone else's Chrome.

## Iteration guard (when iterating with an AI agent)

Once a version is public, the risk shifts from "does it work" to "did a new feature break something that worked". Rules for every iteration:

1. **Baseline first.** Run `npm test` before touching anything. It already includes `scripts/build-client.mjs --check`, so a stale client bundle fails the suite.
2. **Test before code.** New behaviour gets a test case first; a bug fix gets a failing reproduction first. If a change cannot be covered by a test (pure UI/CSS), say so in the commit message and check it in a headless-GUI run instead.
3. **Never hand-edit `lib/client.js`.** Edit `lib/client/*.js`, then `node scripts/build-client.mjs`. The CLI (auto-injected) changes:
   - `lib/client/*` → rebuild + `npm test`
   - `lib/actions/*` / `lib/dsh/*` → `npm test` (smoke/handoff/contract all cover this layer)
   - `lib/core/config-schema.js` → `npm test` + Settings e2e (`npm run test:e2e:settings`)
   - docs/README only → `npm test` is enough, but keep version references in sync (badge **and** the "current version" section)
4. **Cross-platform.** The suite must stay green on Windows as well: `ssh win` to the Windows box, run `node test\{smoke,handoff,plugin-load,contract,compact-log}.mjs` with the portable Node under `C:\Users\satur\tools` (see §Windows). Do not add POSIX-only assumptions (`/dev/null` paths, literal `/tmp` comparisons, permission bits).
5. **Before release.** `npm test` + relevant e2e + the real-device checklist; then bump version, rebuild, `npm pack --dry-run`, publish, tag, release.
6. **Diff hygiene.** The final diff should only contain the intended files; check `git status` for `._*`, temp files, and hand-edited build artifacts.

## Release checklist

1. `npm test` and the relevant `npm run test:e2e:*` succeed.
2. `node scripts/build-client.mjs` — artifact is fresh.
3. Bump `version` in `package.json`, the README badge, and add a `CHANGELOG.md` section.
4. `npm pack --dry-run` — check the file list and size (`files` whitelist).
5. `npm publish` (the package is unscoped/public; publishing needs npm 2FA).
6. `git tag vX.Y.Z && git push --tags`, then create a GitHub release.
7. If listing on the plugin marketplace: PR one file to `awesome-dsh-plugin/awesome-dsh-plugin` (`data/plugins/<owner>__<repo>.yml`).
8. Restart DSH and click through the ring, the menu and Settings once.

## Contributing

Small fixes: fork, branch, PR. Behaviour changes: open an issue first so we can agree on the shape. Keep the no-runtime-dependencies property and the single-source schema (`lib/core/config-schema.js`): adding a field there is enough to make it appear in the Settings page.

MIT — see [LICENSE](LICENSE).
