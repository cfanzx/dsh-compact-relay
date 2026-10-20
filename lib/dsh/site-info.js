/**
 * 交接单的「现场快照」—— 生成文档那一刻，宿主 / 工作区 / 后台任务的真实状态。
 *
 * 为什么要有：交接文档原来只装对话内容，接手者看不到
 * 「DSH 刚重启过 / 有后台任务在跑 / 工作区是哪个分支」这些现场信息，
 * 文档里的「下一步」可能一出厂就过时。这里只读，不写任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { sessionLog } from './session-view.js';

/** refs 引用名白名单：只认 refs/ 下的常规字符，挡住 `.git/HEAD` 里的相对路径穿越（P3-07）。 */
const REF_NAME_PATTERN = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** 本进程启动时刻（模块加载时算一次，同一进程内稳定）。 */
const HOST_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000));

/**
 * 读 `.git/HEAD` 拿分支与提交（只读文件、不跑 git 命令；worktree 的 `.git` 文件也认）。
 * @param {string|undefined} cwd
 * @returns {{branch:string|null, head:string}|null}
 */
export function gitInfo(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  try {
    const dotGit = path.join(cwd, '.git');
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const text = fs.readFileSync(dotGit, 'utf8');
      const match = /^gitdir:\s*(.+)$/m.exec(text);
      if (match === null) return null;
      gitDir = path.resolve(cwd, match[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (ref === null) return { branch: null, head: head.slice(0, 8) };
    const refName = ref[1].trim();
    // P3-07：ref 内容来自仓库里的 .git/HEAD，可以被写成 `../../../../etc/passwd`
    // 这类相对路径；直接 path.join 会越出仓库读任意文件。只认 refs/ 下的正常
    // 引用名（且没有任何 .. 段），不合法就当作「读不到分支」，绝不按原样拼路径。
    if (!REF_NAME_PATTERN.test(refName) || refName.split('/').includes('..')) {
      return { branch: null, head: '' };
    }
    let sha = '';
    // linked worktree：refs 在 .git/commondir 指向的公共 git dir 里，不在 worktree 自己的 gitDir。
    const candidates = [gitDir];
    try {
      const commonDirFile = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
      if (commonDirFile.length > 0) candidates.push(path.resolve(gitDir, commonDirFile));
    } catch {
      /* 普通仓库没有 commondir */
    }
    for (const dir of candidates) {
      try {
        sha = fs.readFileSync(path.join(dir, refName), 'utf8').trim().slice(0, 8);
        if (sha.length > 0) break;
      } catch {
        /* 试下一个候选 */
      }
    }
    return { branch: refName.replace(/^refs\/heads\//, ''), head: sha };
  } catch {
    return null;
  }
}

/**
 * 会话日志里登记了但还没 settled 的后台任务。
 * @param {object} session
 * @returns {{kind:string,label:string}[]}
 */
export function pendingJobs(session) {
  /** @type {Map<string, {kind:string,label:string}>} */
  const running = new Map();
  for (const event of sessionLog(session)) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'job/registered') {
      const data = event.data ?? {};
      const id = typeof data.jobId === 'string' && data.jobId.length > 0 ? data.jobId : `#${event.seq}`;
      running.set(id, {
        kind: typeof data.kind === 'string' && data.kind.length > 0 ? data.kind : 'job',
        label: typeof data.label === 'string' ? data.label.replace(/\s+/g, ' ').trim().slice(0, 60) : '',
      });
    } else if (event.type === 'job/settled') {
      const id = event.data?.jobId;
      if (typeof id === 'string' && id.length > 0) running.delete(id);
    }
  }
  return [...running.values()];
}

/**
 * 汇总一份给交接文档头的现场快照。
 * @param {object} input
 * @param {object} [input.session]
 * @param {Date} [input.now]
 * @returns {object}
 */
export function buildSiteSnapshot({ session, now = new Date() } = {}) {
  const cwd = session?.header?.cwd;
  const config = typeof session?.requestHeader === 'function' ? session.requestHeader()?.config : undefined;
  return {
    now,
    hostStartedAt: HOST_STARTED_AT,
    hostUptimeMs: Math.max(0, now.getTime() - HOST_STARTED_AT.getTime()),
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
    git: gitInfo(cwd),
    jobs: pendingJobs(session),
    provider: config !== undefined && typeof config.provider === 'string' ? config.provider : null,
    model: config !== undefined && typeof config.model === 'string' ? config.model : null,
  };
}
