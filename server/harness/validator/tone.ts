import { z } from 'zod';
import { exactTokens, notReduced, properNouns, quotedSegments, sameCounts } from './checks.ts';

export type ToneDropReason = 'schema_invalid' | 'empty' | 'no_change' | 'duplicate' | 'protected_changed' | 'quote_changed' | 'proper_noun_changed' | 'too_long';

const AltSchema = z.object({
  text: z.string(),
  note: z.preprocess((v) => (typeof v === 'string' ? v : ''), z.string()),
});

export interface ToneValidation {
  alternatives: { text: string; note: string }[];
  dropped: Partial<Record<ToneDropReason, number>>;
}

/** 마스킹된 원문 `source`와 비교해 사실·숫자·자리표시자·인용문·고유명사가 보존된 대안만 남긴다 */
export function validateAlternatives(items: unknown[], source: string, dictionary: string[], n: number): ToneValidation {
  const dropped: ToneValidation['dropped'] = {};
  const drop = (r: ToneDropReason) => void (dropped[r] = (dropped[r] ?? 0) + 1);
  const srcExact = exactTokens(source);
  const srcQuotes = quotedSegments(source);
  const srcNames = properNouns(source, dictionary);
  const seen = new Set<string>([source.trim()]);
  const out: { text: string; note: string }[] = [];

  for (const raw of items) {
    const p = AltSchema.safeParse(raw);
    if (!p.success) {
      drop('schema_invalid');
      continue;
    }
    const text = p.data.text.trim();
    if (!text) drop('empty');
    else if (text === source.trim()) drop('no_change');
    else if (seen.has(text)) drop('duplicate');
    else if (text.length > source.length * 4 + 60) drop('too_long');
    else if (!sameCounts(srcExact, exactTokens(text))) drop('protected_changed');
    else if (!notReduced(srcQuotes, quotedSegments(text))) drop('quote_changed');
    // 원문의 고유명사가 대안 어디에든 남아 있어야 한다 (대안에서는 첫 단어도 센다)
    else if (!notReduced(srcNames, properNouns(text, dictionary, true))) drop('proper_noun_changed');
    else {
      seen.add(text);
      out.push({ text, note: p.data.note.trim() });
    }
  }
  return { alternatives: out.slice(0, n), dropped };
}
