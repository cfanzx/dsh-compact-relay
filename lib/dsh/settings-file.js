/**
 * 设置文件读写（A9：dsh 能力层只认文件，不掺业务/视图）。
 *
 * 文件格式：`{v:1, config:{...}}` 信封；读侧兼容旧扁平文件（只读迁移，
 * 保存时由动作层升级）。这里只负责 JSON/原子写/默认路径，不校验配置语义。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultDshHome } from '../core/config-schema.js';

/** 设置文件名（放在 DSH_HOME 下）。 */
export const SETTINGS_FILE = 'compact-relay.json';

/** 信封版本号。 */
export const SETTINGS_VERSION = 1;

/** 默认设置文件路径。 */
export function defaultSettingsPath() {
  return path.join(defaultDshHome(), SETTINGS_FILE);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把设置文件读成「用户覆盖层」。
 *
 * 返回 `{user, error}`：error 为 null 表示读取成功（文件不存在也算成功）；
 * 否则 error 是 `{field,message}`，message 是给用户看的中文说明。
 * @param {string} file
 * @returns {{user:object, error:{field:string|null,message:string}|null}}
 */
export function readSettingsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { user: {}, error: null };
    return {
      user: {},
      error: { field: null, message: `读取设置文件失败：${error instanceof Error ? error.message : String(error)}；已按默认设置启动。` },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      user: {},
      error: { field: null, message: '设置文件不是合法 JSON；已按默认设置启动（原文件保留，可点「恢复默认」删除）。' },
    };
  }
  if (!isPlainObject(parsed)) {
    return { user: {}, error: { field: null, message: '设置文件内容不是 JSON 对象；已按默认设置启动。' } };
  }
  // 新信封：{v:1, config:{...}}
  if (Object.prototype.hasOwnProperty.call(parsed, 'v') || Object.prototype.hasOwnProperty.call(parsed, 'config')) {
    if (parsed.v === SETTINGS_VERSION && isPlainObject(parsed.config)) {
      return { user: parsed.config, error: null };
    }
    return {
      user: {},
      error: {
        field: 'config',
        message: `设置文件格式无法识别（v=${String(parsed.v)}）；已按默认设置启动（原文件保留，可点「恢复默认」删除）。`,
      },
    };
  }
  // 旧版扁平结构：整份当作覆盖层（只读兼容；保存时自动升级成信封）。
  return { user: parsed, error: null };
}

/**
 * 原子写入用户覆盖层（自动升级成 v1 信封）。
 * @param {string} file
 * @param {object} user
 */
export function writeSettingsFile(file, user) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: SETTINGS_VERSION, config: user }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 删除用户设置文件（不存在也不报错）。 */
export function removeSettingsFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 文件可能本就不存在 */
  }
}

/** 插件版本（从 package.json 读，避免设置页手写版本号漂移）。 */
export function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}
