import { createHash } from 'node:crypto';
import type { HarnessMeta, HarnessSuggestion, SuggestResponse } from '../../../shared/harness.ts';
import type { RelativeSuggestion } from '../validator/validate.ts';

export interface Provenance {
  model: string;
  promptVersion: string;
}

/** 문장 상대 좌표의 제안을 요청 text 기준 최종 제안으로 만든다 */
export function toSuggestion(requestId: string, sentenceStart: number, s: RelativeSuggestion, prov: Provenance): HarnessSuggestion {
  const start = sentenceStart + s.start;
  const end = sentenceStart + s.end;
  const id = createHash('sha1').update(`${requestId}|${start}|${end}|${s.replacement}`).digest('hex').slice(0, 12);
  return {
    id,
    type: s.type,
    category: s.category,
    start,
    end,
    original: s.original,
    replacement: s.replacement,
    reason: s.reason,
    confidence: Math.round(s.confidence * 100) / 100,
    model: prov.model,
    promptVersion: prov.promptVersion,
  };
}

export function assemble(args: {
  requestId: string;
  docVersion: number;
  suggestions: HarnessSuggestion[];
  meta: HarnessMeta;
}): SuggestResponse {
  const suggestions = [...args.suggestions].sort((a, b) => a.start - b.start || a.end - b.end);
  return { requestId: args.requestId, docVersion: args.docVersion, suggestions, meta: args.meta };
}
