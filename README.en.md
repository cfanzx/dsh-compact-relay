<div align="center">

# dsh-compact-relay

**Context window indicator and session management plugin for the DeepSeek Harness composer.**

[简体中文](README.md) · English

[![npm](https://img.shields.io/npm/v/dsh-compact-relay?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-compact-relay)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-4d6bfe)](https://www.deepseek.com/harness/)
[![license](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![version](https://img.shields.io/badge/version-0.3.1-blue)](CHANGELOG.md)

</div>

![The indicator ring with its hover readout](assets/hero-ring.jpg)

## Overview

This plugin adds a 28px ring indicator beside the composer. It reports context occupancy and compression-assessment state in real time so that context can be managed before automatic compaction is triggered:

- **Gray**: below the minimum compression threshold; compaction is not required.
- **Blue**: the normal capacity zone is full; manual compaction is available to free space.
- **Amber (with notch)**: the suggested compression point has been reached (identified by the notch); click to preview the compression estimate and decide whether to run it.
- **Red**: the handoff threshold has been reached; generating a nine-section handoff document and switching to a new session is recommended.

The plugin mounts beside the existing composer. Default parameters are tuned for DSH 0.2.x; no change to the existing workflow is required.

## Core capabilities

### 1. Occupancy visualization

The ring is colored in segments according to the compression-assessment logic: the suggested compression point determined by the model or configured threshold, the positions of pinned messages, and the DSH native auto-compaction line (80% by default). When occupancy crosses the native auto-compaction line, the ring flashes red.

Hovering over the ring displays exact values: capacity used, cumulative compaction count, current suggestion, compression point, native auto-compaction line, and the number of pinned messages.

### 2. Preview-then-confirm compaction

Running `/bc` (or using the ring menu) previews the range to be compacted, the message count, and the estimated capacity to be freed. Execution requires explicit confirmation. The operation can be cancelled before confirmation, and no history is modified until it is committed; pinned messages are skipped automatically.

![Compaction preview with confirm and cancel](assets/compact-preview.jpg)

### 3. Structured session handoff

Running `/handoff` generates a handoff document with nine standard sections (overall goal, constraints, completed items, current progress, files involved, key decisions, known issues, open items, next steps), creates a new session in the current workspace, injects the document, and switches to it. The original session is retained intact.

### 4. Message pinning

Running `/pin` marks messages that must be preserved during compaction. Pinned messages appear as magenta blocks on the ring and as locked rows in the menu.

![The indicator ring menu](assets/menu.jpg)

## Ring legend

| Ring element | Meaning |
| --- | --- |
| Gray arc | Below the minimum compression threshold; compaction not recommended |
| Blue arc | The normal capacity zone is full |
| Amber arc | The compression point has been passed; compaction is suitable |
| Red arc | The handoff threshold has been passed; switching to a new session is recommended |
| Ring notch | Suggested compression point (determined by model assessment or the configured threshold) |
| Violet tick | DSH native auto-compaction line (reads `compaction-basic.thresholdRatio`, 80% by default) |
| Magenta blocks | Distribution of pinned messages in the history |
| Full-ring red flash | The native auto-compaction line has been crossed; DSH native auto-compaction is imminent |

![Crossing the native auto-compaction line](assets/native-alert.jpg)

## Installation

**Requirements**: DSH Desktop or `dsh web` 0.2.x (tested on 0.2.1-rc.2), Node.js 22+.

```sh
dsh plugin --profile desktop add dsh-compact-relay
```

In the desktop app, the plugin can also be installed from **Plugins → Add plugin** by package name, or directly from GitHub:

```sh
dsh plugin --profile desktop add github:cfanzx/dsh-compact-relay
```

Restart DSH after installation. Configuration changes saved inside the plugin take effect immediately and do not require a restart.

## Settings

Configuration is available under **Settings → 压缩接力** (in the account menu on DSH 0.2.1+):

- **Compaction hints**: configure the minimum compression line, compression line, and handoff line to control when warnings are emitted.
- **Compaction behaviour**: configure the summary retention limit, the recent-token retention count, and the handoff document directory.
- **DSH native auto-compaction**: read the host's current threshold and enable or disable DSH native auto-compaction (a backup is created before the profile configuration is modified; a restart is required for the change to take effect).
- **Colors & appearance**: configure five base colors; the system derives adapted shades for the light and dark themes automatically.
- **Help**: ring legend, usage notes, feedback links, and a "show the onboarding again" button.
- **About / dangerous operations**: version number, configuration file path, and factory reset.

![Settings](assets/settings.jpg)

Each setting includes a definition and a description of the effect of changing it. The help section contains five dynamic example rings that update in real time with the current colors and thresholds.

![Ring legend teaching card](assets/teaching-card.jpg)

The first time a session is opened, the ring plays a brief highlight animation with a short functional description (triggered automatically once only; it can be replayed from the Settings page).

![First-run onboarding](assets/onboarding.jpg)

## Commands

| Command | Description |
| --- | --- |
| `/bc` | Preview compaction: target range, message count, and estimated capacity to be freed |
| `/bc confirm` | Execute the previewed compaction |
| `/handoff` | Generate a nine-section handoff document, then create and switch to a new session |
| `/pin` / `/unpin` | Pin or unpin a message; pinned messages are skipped during compaction |
| `/bctest` | Small dry-run test (development debugging only) |

## Scope and limitations

- **Does not replace DSH native compaction**: native compaction remains under DSH host control; this plugin only reads the threshold, displays warnings, and provides a toggle in Settings.
- **Does not modify prompts or model replies**: history is replaced only when the user explicitly confirms a compaction or runs a handoff.
- **Summary quality depends on the underlying model**: summaries use a structured nine-section template with format validation and a single retry, but output quality remains limited by the selected model.
- **Local storage only**: plugin state is stored in `~/.dsh/compact-relay.json` and handoff documents in `~/.dsh/handoffs/`; no external data is synchronized.
- **UI language limitation**: the current UI is Simplified Chinese only; an English UI is planned with no fixed schedule.

## Version and license

- **Current version**: 0.3.1 (first public release), tested on macOS against DSH 0.2.1-rc.2 and using only public DSH exports. See [CHANGELOG.md](CHANGELOG.md) for changes, [ROADMAP.md](ROADMAP.md) for plans and known limitations, and [DEVELOPMENT.md](https://github.com/cfanzx/dsh-compact-relay/blob/main/DEVELOPMENT.md) for build and release workflows.
- **License**: [MIT](LICENSE). Feedback and Pull Requests are welcome via [GitHub Issues](https://github.com/cfanzx/dsh-compact-relay/issues).

## Credits

The design of this plugin references the public implementations of the following DSH community plugins and projects (ideas only; no code copied):

- [DeepSeek Harness](https://www.deepseek.com/harness/) — the host platform this plugin runs on; all host capabilities used here come from its public exports.
- [dsh-clear-mind](https://github.com/john-walks-slow/dsh-clear-mind) (MIT) — replacement transaction and boundary/lock checks.
- [dsh-handoff-compaction](https://github.com/knighthongyu/dsh-handoff-compaction) (MIT) — summary structure validation, retry and cache alignment.
- [dsh-compaction-policy](https://github.com/zyd232/dsh-compaction-policy) (MIT) — runtime gating of the preset-scoped engine.
- [context-vista](https://github.com/GooodWei/context-vista) (MIT) — ring drawing and session projections subscriptions.
- [dsh-session-handoff](https://github.com/WeiYe6/dsh-session-handoff) (MIT) — `/handoff` session creation and auto-switch flow.
- [dsh-smart-compact](https://github.com/hoyyang/dsh-smart-compact) (BSD-3-Clause) — budget measurement and handoff anchor design.
- [dsh-toolong-warning](https://github.com/Hjdd14/dsh-toolong-warning) (MIT) — compaction counting and reminders.
- [dsh-compaction-instant](https://github.com/TsFreddie/dsh-compaction-instant) (MIT) — transaction error classification contract.
- [dsh-plugin-memory](https://github.com/LittleBlackTong/dsh-plugin-memory) — settings-panel registration and rendering approach in DSH.
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) / [dsh-market](https://github.com/dsh-market/dsh-market) — community plugin catalog and in-app market.

Thanks to the authors above for publishing their work, and to everyone who tested the plugin and sent feedback.

## Contact

- **Official channel**: the GitHub repository <https://github.com/cfanzx/dsh-compact-relay> and [Issues](https://github.com/cfanzx/dsh-compact-relay/issues) — bug reports, feature requests and release announcements.
- **Developer email**: cfanzx@136.com — collaboration, security reports, and anything better discussed privately.
