/**
 * `@deepseek-ai/dsh-tools` 测试替身 —— defineTool 只做最小结构检查。
 *
 * 真实实现在注册时会编译参数 schema；测试只关心「工具名/描述/execute 装配对不对」，
 * 参数校验与 wire schema 交给真机（隔离复刻）验证。
 */
export function defineTool(options) {
  if (options === null || typeof options !== 'object') throw new Error('defineTool(options) requires an options object');
  if (typeof options.name !== 'string' || options.name.length === 0) throw new Error('defineTool requires a non-empty name');
  if (typeof options.execute !== 'function') throw new Error(`defineTool(${options.name}) requires an execute function`);
  return options;
}
