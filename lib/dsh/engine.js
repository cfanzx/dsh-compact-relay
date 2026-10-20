/**
 * DSH 运行时能力接缝 —— 全插件唯一 import @deepseek-ai/* 的地方。
 *
 * 以后 DSH 升级导致这些符号变化，只改这一个文件。
 */
import {
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction';
import { BlockAssembler, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const engine = Object.freeze({
  /** 构造 DSH 认得的 checkpoint source（旧摘要识别、UI 关联都靠它）。 */
  compactCheckpointSource,
  /** 判断一条消息是不是 checkpoint（M2 不二压选段用）。 */
  isCompactCheckpointSource,
  /** 工具调用配对平衡判定——不要自己重写。 */
  toolPairingBalancedBefore,
  toolPairingBalancedAfter,
  /** 流式输出组装器。 */
  BlockAssembler,
  /** 构造合法的 user message（含 id/时间戳等）。 */
  createUserMessage,
  /** 错误 → 可持久化的 JSON 链。 */
  errorChain,
  /** 追加一条插件私有记录（M4 阶段标记；不进模型可见 surface）。 */
  appendPluginRecord,
  /** 声明一个模型可调用的工具（M4 mark_stage）。 */
  defineTool,
});

export default engine;
