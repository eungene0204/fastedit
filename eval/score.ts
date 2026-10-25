import type { HarnessSuggestion } from '../shared/harness.ts';

export interface DatasetRow {
  input: string;
  expected: { original: string; replacement: string }[];
  mustNotChange: string[];
  /** tone 평가셋에서만 */
  tone?: 'polite' | 'concise' | 'simple' | 'formal';
}

type Rel = Pick<HarnessSuggestion, 'start' | 'end' | 'original' | 'replacement'>;

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

function occurrences(text: string, needle: string): [number, number][] {
  const out: [number, number][] = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push([i, i + needle.length]);
  return out;
}

export interface LineScore {
  expected: number;
  matched: number;
  produced: number;
  correct: number;
  /** 바뀌면 안 되는 구간을 건드린 제안 수 */
  violations: number;
}

/**
 * 제안이 기대 수정을 재현했는지: 같은 (original, replacement)이거나,
 * 위치가 겹치면서 제안이 기대 수정을 포함(더 넓게 고침)하거나 기대 수정의 일부를 고친 경우.
 */
function hits(s: Rel, e: { original: string; replacement: string }, input: string): boolean {
  if (s.original === e.original && s.replacement === e.replacement) return true;
  return occurrences(input, e.original).some(([a, b]) => {
    if (!overlaps(s.start, s.end, a, b)) return false;
    const wider = s.start <= a && s.end >= b && s.replacement.includes(e.replacement);
    const part = s.start >= a && s.end <= b && e.replacement.includes(s.replacement);
    return wider || part;
  });
}

/** 바뀌면 안 되는 구간을 건드린 제안 (진단용) */
export function violatingSuggestions<T extends Rel>(row: DatasetRow, suggestions: T[]): T[] {
  const ranges = row.mustNotChange.flatMap((m) => occurrences(row.input, m));
  return suggestions.filter((s) => ranges.some(([a, b]) => overlaps(s.start, s.end, a, b)));
}

/** suggestions의 start/end는 이 줄(input) 기준 좌표여야 한다 */
export function scoreLine(row: DatasetRow, suggestions: Rel[]): LineScore {
  const matchedExpected = row.expected.filter((e) => suggestions.some((s) => hits(s, e, row.input)));
  const correct = suggestions.filter((s) => row.expected.some((e) => hits(s, e, row.input)));
  const protectedRanges = row.mustNotChange.flatMap((m) => occurrences(row.input, m));
  const violations = suggestions.filter((s) => protectedRanges.some(([a, b]) => overlaps(s.start, s.end, a, b))).length;
  return { expected: row.expected.length, matched: matchedExpected.length, produced: suggestions.length, correct: correct.length, violations };
}

export interface ToneScore {
  alternatives: number;
  violations: number;
}

/** 대안이 mustNotChange 문자열을 하나라도 잃었으면 위반 */
export function scoreTone(row: DatasetRow, alternatives: { text: string }[]): ToneScore {
  const violations = alternatives.filter((a) => row.mustNotChange.some((m) => !a.text.includes(m))).length;
  return { alternatives: alternatives.length, violations };
}

export const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
