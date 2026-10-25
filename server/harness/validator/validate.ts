import { z } from 'zod';
import type { HarnessCategory, HarnessStrength, HarnessSuggestionType } from '../../../shared/harness.ts';
import { PLACEHOLDER_RE, toOriginalRange, unmaskPii, type Masked } from '../preprocess/pii.ts';
import type { SentenceRef } from '../types.ts';
import { applyEdit, exactTokens, notReduced, nthIndexOf, properNouns, quotedSegments, sameCounts } from './checks.ts';

export type DropReason =
  | 'schema_invalid'
  | 'bad_sentence'
  | 'category_not_allowed'
  | 'empty_original'
  | 'no_change'
  | 'original_not_found'
  | 'too_long'
  | 'protected_changed'
  | 'quote_changed'
  | 'proper_noun_changed'
  | 'low_confidence'
  | 'split_placeholder'
  | 'placeholder_leak'
  | 'duplicate'
  | 'overlap';

export const TYPE_OF: Record<HarnessCategory, HarnessSuggestionType> = {
  spelling: 'error',
  spacing: 'error',
  grammar: 'error',
  punctuation: 'error',
  concision: 'clarity',
  readability: 'clarity',
  word_choice: 'clarity',
  formality: 'tone',
  politeness: 'tone',
};

const ALLOWED: Record<'spell' | 'polish', HarnessCategory[]> = {
  spell: ['spelling', 'spacing', 'grammar', 'punctuation'],
  polish: ['spelling', 'spacing', 'grammar', 'punctuation', 'concision', 'readability', 'word_choice'],
};

const TYPE_RANK: Record<HarnessSuggestionType, number> = { error: 0, clarity: 1, tone: 2 };

/** 교정 강도별 변경 길이 상한: replacement.length <= original.length * mul + add */
const LENGTH_LIMIT: Record<HarnessStrength, { mul: number; add: number }> = {
  light: { mul: 1.6, add: 12 },
  normal: { mul: 2.2, add: 20 },
  strong: { mul: 3, add: 30 },
};

const CATEGORIES = ['spelling', 'spacing', 'grammar', 'punctuation', 'concision', 'readability', 'word_choice', 'formality', 'politeness'] as const;

const ItemSchema = z.object({
  sentence: z.coerce.number().int(),
  original: z.string(),
  occurrence: z.preprocess((v) => v ?? 1, z.coerce.number().int().min(1)),
  replacement: z.string(),
  category: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(CATEGORIES)),
  reason: z.preprocess((v) => (typeof v === 'string' ? v : ''), z.string()),
  confidence: z.preprocess((v) => v ?? 0.6, z.coerce.number().transform((n) => Math.min(1, Math.max(0, n)))),
});

/** 문장 하나의 좌표계(문장 시작 = 0)로 표현한 검증된 제안 */
export interface RelativeSuggestion {
  start: number;
  end: number;
  original: string;
  replacement: string;
  reason: string;
  confidence: number;
  category: HarnessCategory;
  type: HarnessSuggestionType;
}

export interface BatchSentence {
  ref: SentenceRef;
  masked: Masked;
}

export interface ValidateOptions {
  task: 'spell' | 'polish';
  strength: HarnessStrength;
  dictionary: string[];
  minConfidence: number;
}

export interface ValidationResult {
  /** BatchSentence 배열 인덱스 → 제안 */
  bySentence: Map<number, RelativeSuggestion[]>;
  dropped: Partial<Record<DropReason, number>>;
}

/**
 * 모델이 준 제안 목록을 제안별로 검사한다. 하나라도 실패한 제안만 버리고 나머지는 살린다.
 * 위치(offset)는 모델이 아니라 여기서 original 문자열과 occurrence로 직접 계산한다.
 */
export function validateBatch(items: unknown[], sentences: BatchSentence[], o: ValidateOptions): ValidationResult {
  const dropped: ValidationResult['dropped'] = {};
  const drop = (r: DropReason) => void (dropped[r] = (dropped[r] ?? 0) + 1);
  const bySentence = new Map<number, RelativeSuggestion[]>();
  const limit = LENGTH_LIMIT[o.strength];

  for (const raw of items) {
    const parsed = ItemSchema.safeParse(raw);
    if (!parsed.success) {
      drop('schema_invalid');
      continue;
    }
    const it = parsed.data;
    const si = it.sentence - 1;
    const sent = sentences[si];
    if (!sent) {
      drop('bad_sentence');
      continue;
    }
    if (!ALLOWED[o.task].includes(it.category)) {
      drop('category_not_allowed');
      continue;
    }
    if (!it.original) {
      drop('empty_original');
      continue;
    }
    if (it.original === it.replacement) {
      drop('no_change');
      continue;
    }
    const m = sent.masked;
    const ms = nthIndexOf(m.text, it.original, it.occurrence);
    if (ms === -1) {
      drop('original_not_found');
      continue;
    }
    const me = ms + it.original.length;
    if (it.replacement.length > it.original.length * limit.mul + limit.add) {
      drop('too_long');
      continue;
    }

    // 수정 전·후 문장(마스킹된 상태)을 비교해 보존해야 할 것들이 그대로인지 확인한다
    const before = m.text;
    const after = applyEdit(before, ms, me, it.replacement);
    if (!sameCounts(exactTokens(before), exactTokens(after))) {
      drop('protected_changed');
      continue;
    }
    if (!notReduced(quotedSegments(before), quotedSegments(after))) {
      drop('quote_changed');
      continue;
    }
    if (!notReduced(properNouns(before, o.dictionary), properNouns(after, o.dictionary))) {
      drop('proper_noun_changed');
      continue;
    }
    if (it.confidence < o.minConfidence) {
      drop('low_confidence');
      continue;
    }

    const range = toOriginalRange(m.segments, ms, me);
    if (!range) {
      drop('split_placeholder');
      continue;
    }
    const replacement = unmaskPii(it.replacement, m.tokens);
    if (new RegExp(PLACEHOLDER_RE.source).test(replacement)) {
      drop('placeholder_leak');
      continue;
    }
    const [start, end] = range;
    const original = sent.ref.text.slice(start, end);
    if (original === replacement) {
      drop('no_change');
      continue;
    }

    const list = bySentence.get(si) ?? [];
    if (list.some((s) => s.start === start && s.end === end && s.replacement === replacement)) {
      drop('duplicate');
      continue;
    }
    list.push({
      start,
      end,
      original,
      replacement,
      reason: it.reason.trim(),
      confidence: it.confidence,
      category: it.category,
      type: TYPE_OF[it.category],
    });
    bySentence.set(si, list);
  }

  for (const [si, list] of bySentence) {
    const kept = resolveOverlaps(list);
    for (let i = kept.length; i < list.length; i++) drop('overlap');
    bySentence.set(si, kept);
  }
  return { bySentence, dropped };
}

/** 겹치는 제안은 유형 우선순위(오류 > 명확성 > 어조) → 신뢰도 → 짧은 구간 순으로 하나만 남긴다 */
export function resolveOverlaps<T extends { start: number; end: number; type: HarnessSuggestionType; confidence: number }>(list: T[]): T[] {
  const ranked = [...list].sort(
    (a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || b.confidence - a.confidence || a.end - a.start - (b.end - b.start),
  );
  const kept: T[] = [];
  for (const s of ranked) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}
