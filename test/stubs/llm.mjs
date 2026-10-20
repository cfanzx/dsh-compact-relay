/** 测试替身：@deepseek-ai/dsh-llm 的最小实现。 */
export class BlockAssembler {
  constructor() {
    this.chunks = [];
    this._usage = undefined;
    this._finish = undefined;
  }
  push(chunk) {
    this.chunks.push(chunk);
    if (chunk.type === 'usage') this._usage = chunk.usage;
    if (chunk.type === 'finish') this._finish = chunk.reason;
  }
  get usage() {
    return this._usage;
  }
  get finish() {
    return this._finish ?? { kind: 'stop' };
  }
  blocks() {
    const texts = new Map();
    for (const chunk of this.chunks) {
      if (chunk.type === 'text-delta') texts.set(chunk.index, (texts.get(chunk.index) ?? '') + chunk.text);
    }
    return [...texts.values()].map((text) => ({ type: 'text', text }));
  }
}

export function createUserMessage({ content, source }) {
  return { role: 'user', content, source, id: 'mock-message' };
}

export function errorChain(error) {
  return { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
}
