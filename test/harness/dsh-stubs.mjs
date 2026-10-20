/**
 * `@deepseek-ai/dsh-*` 包解析钩子 —— 让 node 测试能加载只 import 这些包的 `lib/dsh/engine.js`。
 *
 * 必须在 **动态 import** lib 模块之前调用（静态 import 会先于模块体解析）：
 *
 *   import { registerDshStubHooks } from './harness/dsh-stubs.mjs';
 *   registerDshStubHooks();
 *   const { apply } = await import('../lib/index.js');
 *
 * 替身实现见 `test/stubs/*`；这里只负责把裸包名指过去，三套测试共用一份映射。
 */
import { registerHooks } from 'node:module';

export const DSH_STUB_MAP = Object.freeze({
  '@deepseek-ai/dsh-compaction': '../stubs/compaction.mjs',
  '@deepseek-ai/dsh-llm': '../stubs/llm.mjs',
  '@deepseek-ai/dsh-session': '../stubs/session.mjs',
  '@deepseek-ai/dsh-tools': '../stubs/tools.mjs',
});

export function registerDshStubHooks() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = DSH_STUB_MAP[specifier];
      if (target !== undefined) {
        return { url: new URL(target, import.meta.url).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}
