import type { HarnessLanguage } from '../../../shared/harness.ts';

export interface BatchLimits {
  maxSentences: number;
  maxChars: number;
}

/** 같은 언어의 연속된 문장을 문장 수·글자 수 한도 안에서 묶는다 (순서 유지) */
export function makeBatches<T extends { text: string; lang: HarnessLanguage }>(items: T[], limits: BatchLimits): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const it of items) {
    const full = cur.length >= limits.maxSentences || chars + it.text.length > limits.maxChars;
    if (cur.length && (full || cur[0].lang !== it.lang)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
