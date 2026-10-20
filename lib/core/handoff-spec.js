/**
 * 交接单九段规格表 —— 段落「真相」的唯一来源（A1）。
 *
 * 以前标题散在 handoff-doc / prompts / validate-handoff / 客户端文案四处，
 * 0.4 的九段、程序收集段、readiness 都从这里派生：
 *  - owner:'model'   → 模型撰写（提示词只列这些）
 *  - owner:'program' → 代码从会话事实收集（不接受模型输出）
 *
 * 顺序即文档顺序；required 当前全 true（readiness 缺段直接判不通过）。
 */
export const HANDOFF_SPEC = Object.freeze([
  {
    key: 'goal',
    title: '总体目标',
    owner: 'model',
    required: true,
    hint: '这次任务最终要达成什么；用户的验收标准/原话尽量逐字保留',
  },
  {
    key: 'constraints',
    title: '约束',
    owner: 'model',
    required: true,
    hint: '不能违反的边界：权限/安全/用户明确要求/禁止事项',
  },
  {
    key: 'done',
    title: '已完成',
    owner: 'model',
    required: true,
    hint: '已交付且验证过的结果，带证据（命令/文件/真机现象）',
  },
  {
    key: 'progress',
    title: '当前进度',
    owner: 'program',
    required: true,
    hint: '程序收集：阶段标记、已压缩次数、已用容量、锁定消息、后台任务',
  },
  {
    key: 'files',
    title: '改过的文件',
    owner: 'program',
    required: true,
    hint: '程序收集：本会话日志里写/改过的文件路径',
  },
  {
    key: 'decisions',
    title: '关键决策',
    owner: 'model',
    required: true,
    hint: '做过的取舍及原因；没发生过就不写',
  },
  {
    key: 'issues',
    title: '已知问题',
    owner: 'model',
    required: true,
    hint: '仍存在的 bug/限制/风险；确实没有才写 (none)',
  },
  {
    key: 'todo',
    title: '未完成',
    owner: 'model',
    required: true,
    hint: '还没做完的具体事项（可执行粒度）',
  },
  {
    key: 'next',
    title: '下一步',
    owner: 'model',
    required: true,
    hint: '接手者第一步做什么；可执行、别写「继续努力」',
  },
]);

/** 九个标题，顺序固定。 */
export const HANDOFF_SECTIONS = Object.freeze(HANDOFF_SPEC.map((section) => section.title));

/** 模型负责的七段。 */
export const HANDOFF_MODEL_SECTIONS = Object.freeze(
  HANDOFF_SPEC.filter((section) => section.owner === 'model').map((section) => section.title),
);

/** 程序负责的两段。 */
export const HANDOFF_PROGRAM_SECTIONS = Object.freeze(
  HANDOFF_SPEC.filter((section) => section.owner === 'program').map((section) => section.title),
);

/** 按标题查规格；找不到返回 null。 */
export function handoffSpecOf(title) {
  return HANDOFF_SPEC.find((section) => section.title === title) ?? null;
}
