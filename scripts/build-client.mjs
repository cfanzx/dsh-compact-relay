/**
 * 零依赖 client bundle 构建 —— 把 lib/client/*.js 按文件名排序拼成 lib/client.js。
 *
 * 为什么要构建：DSH 运行时没有打包器，package.json exports["./client"] 只认
 * 已构建好的单文件 bundle（拆出模块会报 client bundle not found）。所以源码
 * 分片段放 lib/client/，产物 lib/client.js 由本脚本生成，禁止手改。
 *
 * 片段里可以写一行 `/* @inline core/colors.js *\/`（注意是块注释形式），
 * 构建时会把该模块源码去掉 `export ` 前缀后内联进来 —— 这样纯逻辑只有一份
 * 源码（core/ 下可单测），浏览器侧也能用。
 *
 * 用法：
 *   node scripts/build-client.mjs           # 生成 lib/client.js
 *   node scripts/build-client.mjs --check   # 只校验：产物与源码不一致时退出 1（进 npm test）
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourceDir = path.join(root, 'lib/client');
const outFile = path.join(root, 'lib/client.js');
const inlinePattern = /^\s*\/\* @inline ([\w./-]+) \*\/\s*$/;

/** 把 core 模块的 ESM 导出改写成同一作用域里的声明（零依赖拼接的代价）。 */
function inlineModule(relPath) {
  const file = path.join(root, 'lib', relPath);
  if (!fs.existsSync(file)) throw new Error(`内联模块不存在：${relPath}`);
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(/^export (function|const|let|class) /gm, '$1 ')
    .replace(/^export default .*$/gm, '')
    .replace(/^export \{[^}]*\};\s*$/gm, '')
    .replace(/\n$/, '');
  // 片段在工厂函数体内：统一补 4 空格缩进（空行保持空行）
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : `    ${line}`))
    .join('\n');
}

/** 生成 lib/client.js 的完整内容（不落盘）。 */
export function build() {
  if (!fs.existsSync(sourceDir)) throw new Error(`源码目录不存在：${sourceDir}`);
  const files = fs
    .readdirSync(sourceDir)
    // 忽略隐藏文件 / macOS 资源分叉（拷贝或打包时常见的 `._xxx.js`），否则会把二进制当片段拼进去。
    .filter((name) => name.endsWith('.js') && !name.startsWith('.'))
    .sort();
  if (files.length === 0) throw new Error('lib/client/ 里没有源码片段');

  const parts = files.map((name) => {
    const text = fs.readFileSync(path.join(sourceDir, name), 'utf8');
    const out = text
      .split('\n')
      .map((line) => {
        const hit = inlinePattern.exec(line);
        return hit === null ? line : inlineModule(hit[1]).replace(/\n$/, '');
      })
      .join('\n');
    // 片段之间用单个空行分隔；片段自身以换行结尾时不再重复加
    return out.endsWith('\n') ? out : `${out}\n`;
  });
  return parts.join('');
}

const args = new Set(process.argv.slice(2));
const built = build();
if (args.has('--check')) {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  if (current === built) {
    console.log(`client bundle 已是最新（${built.length} 字节）`);
  } else {
    const a = current.split('\n');
    const b = built.split('\n');
    const at = a.findIndex((line, index) => line !== b[index]);
    console.error('client bundle 不是最新，源码片段改过了但没重新构建。');
    console.error(`  产物：${outFile}`);
    console.error(`  第一条不一致在产物第 ${at + 1} 行 / 构建结果第 ${at + 1} 行：`);
    console.error(`    产物：${JSON.stringify(a[at] ?? '<缺失>')}`);
    console.error(`    构建：${JSON.stringify(b[at] ?? '<缺失>')}`);
    console.error('  修复：node scripts/build-client.mjs');
    process.exit(1);
  }
} else {
  fs.writeFileSync(outFile, built);
  console.log(`已生成 ${path.relative(root, outFile)}（${built.length} 字节，来自 ${sourceDir.replace(root + '/', '')}/）`);
}
