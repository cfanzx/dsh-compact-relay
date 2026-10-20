/** 测试替身：@deepseek-ai/dsh-compaction 的最小实现。 */
export function compactCheckpointSource(compactionId, sourceCommandId) {
  return {
    kind: 'compact-checkpoint',
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
  };
}

export function isCompactCheckpointSource(source) {
  return source !== null && typeof source === 'object' && source.kind === 'compact-checkpoint';
}

export function toolPairingBalancedBefore() {
  return true;
}

export function toolPairingBalancedAfter() {
  return true;
}
