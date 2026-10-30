#!/usr/bin/env node
/**
 * `dcr-debug` wrapper（0.5.6）—— 本体在 lib/cli/（随 npm 包发布），这里只转发 argv。
 * 用法见 docs/debugging.md；`node scripts/dcr-debug.mjs --help`。
 */
import { main } from '../lib/cli/main.js';

process.exitCode = await main(process.argv.slice(2));
