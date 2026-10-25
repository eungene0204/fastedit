import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskPii } from '../preprocess/pii.ts';
import type { SentenceRef } from '../types.ts';
import { validateBatch, type BatchSentence, type ValidateOptions } from './validate.ts';
import { validateAlternatives } from './tone.ts';

const sent = (text: string, counter = { n: 0 }): BatchSentence => ({
  ref: { index: 0, start: 100, end: 100 + text.length, text, lang: 'ko' } as SentenceRef,
  masked: maskPii(text, counter),
});
const opts = (over: Partial<ValidateOptions> = {}): ValidateOptions => ({ task: 'polish', strength: 'normal', dictionary: [], minConfidence: 0.5, ...over });
const item = (over: Record<string, unknown>) => ({ sentence: 1, occurrence: 1, category: 'spelling', reason: '이유', confidence: 0.9, ...over });
const run = (text: string, items: unknown[], o: Partial<ValidateOptions> = {}) => {
  const r = validateBatch(items, [sent(text)], opts(o));
  return { out: r.bySentence.get(0) ?? [], dropped: r.dropped };
};

test('original 문자열로 위치를 직접 계산한다', () => {
  const { out } = run('자료는 제가 준비할께요.', [item({ original: '준비할께요', replacement: '준비할게요' })]);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].start, out[0].end, out[0].type], [7, 12, 'error']);
});

test('occurrence로 같은 문자열의 n번째를 고른다', () => {
  const text = '할께 그리고 할께';
  const { out } = run(text, [item({ original: '할께', replacement: '할게', occurrence: 2 })]);
  assert.equal(out[0].start, 7);
  const none = run(text, [item({ original: '할께', replacement: '할게', occurrence: 3 })]);
  assert.equal(none.dropped.original_not_found, 1);
});

test('원문에 없는 original, 잘못된 스키마, 없는 문장 번호는 그 제안만 버린다', () => {
  const { out, dropped } = run('회의는 3시에 합니다. 몇일 뒤', [
    item({ original: '없는 말', replacement: '다른 말' }),
    item({ original: '몇일', replacement: '며칠' }),
    { sentence: 1, original: 5 },
    item({ original: '몇일', replacement: '며칠', sentence: 9 }),
    item({ original: '몇일', replacement: '며칠', category: 'weird' }),
  ]);
  assert.deepEqual(out.map((s) => s.replacement), ['며칠']);
  assert.deepEqual(dropped, { original_not_found: 1, schema_invalid: 2, bad_sentence: 1 });
});

test('같은 문자열로 바꾸거나 과도하게 길어진 제안은 버린다', () => {
  const same = run('오늘 날씨', [item({ original: '오늘', replacement: '오늘' })]);
  assert.equal(same.dropped.no_change, 1);
  const long = run('좋다', [item({ original: '좋다', replacement: '아주 아주 아주 좋고 훌륭하며 매우 만족스러운 것이라고 할 수 있다', category: 'concision' })], { strength: 'light' });
  assert.equal(long.dropped.too_long, 1);
});

test('낮은 신뢰도와 허용되지 않은 카테고리는 버린다', () => {
  assert.equal(run('할께', [item({ original: '할께', replacement: '할게', confidence: 0.2 })]).dropped.low_confidence, 1);
  assert.equal(run('할께', [item({ original: '할께', replacement: '할게', category: 'concision' })], { task: 'spell' }).dropped.category_not_allowed, 1);
});

// ── 완료 기준: 숫자·고유명사·자리표시자를 바꾸는 제안은 100% 걸러진다 ──
const MUST_REJECT: [string, string, string, string, string][] = [
  // [설명, 문장, original, replacement, 기대 사유]
  ['숫자 변경', '회의는 3시에 합니다.', '3시에', '4시에', 'protected_changed'],
  ['숫자 삭제', '회의는 3시에 합니다.', '3시에 합니다', '시에 합니다', 'protected_changed'],
  ['숫자 일부 잘라내기', '매출은 1000원이다.', '00원', '0원', 'protected_changed'],
  ['금액 서식 변경', '가격은 1,000원이다.', '1,000원', '1000원', 'protected_changed'],
  ['소수점 변경', '값은 3.14이다.', '3.14', '3.15', 'protected_changed'],
  ['날짜 변경', '2024년 5월 3일에 만났다.', '5월 3일', '5월 4일', 'protected_changed'],
  ['날짜 형식 변경', '기한은 2024-05-03까지다.', '2024-05-03', '2024.05.03', 'protected_changed'],
  ['URL 변경', '주소는 https://example.com/a?b=1 입니다.', 'https://example.com/a?b=1', 'https://example.org/a?b=1', 'protected_changed'],
  ['URL 일부 변경', '주소는 https://example.com/a 입니다.', 'example.com/a', 'example.com/b', 'protected_changed'],
  ['숫자가 새로 생김', '그는 갔다.', '갔다', '3번 갔다', 'protected_changed'],
  ['고유명사(영문 대문자) 변경', 'We visited Paris last year.', 'Paris', 'London', 'proper_noun_changed'],
  ['고유명사 소문자화', 'We visited Paris last year.', 'Paris', 'paris', 'proper_noun_changed'],
  ['고유명사 일부 수정', '회사는 FastEdit를 쓴다.', 'Edit', 'edit', 'proper_noun_changed'],
  ['고유명사 삭제', 'We met Alice at noon.', 'Alice at', 'at', 'proper_noun_changed'],
  ['인용문 수정', '그는 "몇일 뒤"라고 했다.', '몇일', '며칠', 'quote_changed'],
  ['인용문 통째 삭제', '그는 “다시 올게”라고 했다.', '“다시 올게”라고', '라고', 'quote_changed'],
];

for (const [name, text, original, replacement, reason] of MUST_REJECT) {
  test(`보존 위반 차단: ${name}`, () => {
    const { out, dropped } = run(text, [item({ original, replacement, category: 'word_choice' })]);
    assert.deepEqual(out, [], `통과하면 안 됨: ${original} → ${replacement}`);
    assert.equal(dropped[reason as 'protected_changed'], 1, JSON.stringify(dropped));
  });
}

test('사용자 사전의 단어는 바꿀 수 없다', () => {
  const text = '우리는 널스페이스에서 일한다.';
  const bad = run(text, [item({ original: '널스페이스에서', replacement: '널 스페이스에서', category: 'spacing' })], { dictionary: ['널스페이스'] });
  assert.equal(bad.dropped.proper_noun_changed, 1);
  const ok = run(text, [item({ original: '일한다', replacement: '일합니다', category: 'word_choice' })], { dictionary: ['널스페이스'] });
  assert.equal(ok.out.length, 1);
});

test('문장 첫 단어의 대문자 교정은 고유명사로 막지 않는다', () => {
  const { out } = run('teh cat sat. Teh dog', [item({ original: 'teh', replacement: 'the' })]);
  assert.equal(out.length, 1);
  const first = validateBatch([item({ original: 'Teh', replacement: 'The' })], [sent('Teh cat sat on Mars.')], opts());
  assert.equal(first.bySentence.get(0)?.length, 1);
});

test('자리표시자: 바꾸거나 지우거나 만들어내면 버리고, 보존하면 원문 위치로 되돌린다', () => {
  const text = '연락처 010-1234-5678 로 연락주세요 할께요.';
  const masked = sent(text);
  const ph = [...masked.masked.tokens.keys()][0];
  assert.match(masked.masked.text, /⟦PII_1⟧/);
  const attempts = [
    { original: ph, replacement: '⟦PII_9⟧' }, // 바꿈
    { original: `연락처 ${ph}`, replacement: '연락처' }, // 지움
    { original: '연락주세요', replacement: `연락주세요 ${ph}` }, // 만들어냄
    { original: '⟦PII', replacement: 'x' }, // 가로지름
    { original: ph, replacement: '010-1234-5678' }, // 원래 값을 직접 적음
  ].map((a) => item({ ...a, category: 'word_choice' }));
  const r = validateBatch(attempts, [masked], opts());
  assert.equal(r.bySentence.get(0), undefined);
  assert.equal(Object.values(r.dropped).reduce((a, b) => a! + b!, 0), 5);

  const good = validateBatch([item({ original: `${ph} 로`, replacement: `${ph}로`, category: 'spacing' }), item({ original: '할께요', replacement: '할게요' })], [sent(text)], opts());
  const out = good.bySentence.get(0)!;
  assert.equal(out[0].original, '010-1234-5678 로');
  assert.equal(out[0].replacement, '010-1234-5678로');
  assert.equal(text.slice(out[0].start, out[0].end), '010-1234-5678 로');
  assert.equal(text.slice(out[1].start, out[1].end), '할께요');
});

test('겹치는 제안은 오류 > 명확성, 같으면 신뢰도 순으로 하나만 남긴다', () => {
  const text = '자료에 대한 준비는 제가 준비를 할께요';
  const { out, dropped } = run(text, [
    item({ original: text, replacement: '자료는 제가 준비할게요', category: 'concision', confidence: 0.99 }),
    item({ original: '할께요', replacement: '할게요', confidence: 0.6 }),
  ]);
  assert.deepEqual(out.map((s) => s.type), ['error']);
  assert.equal(dropped.overlap, 1);
});

test('톤 대안 검증: 숫자·자리표시자·인용문·사전을 지킨 서로 다른 대안만 남긴다', () => {
  const src = '3시까지 ⟦PII_1⟧로 "확인" 부탁해. 널스페이스 건이야.';
  const items = [
    { text: '3시까지 ⟦PII_1⟧로 "확인" 부탁드립니다. 널스페이스 건입니다.', note: '공손' },
    { text: '4시까지 ⟦PII_1⟧로 "확인" 부탁드립니다. 널스페이스 건입니다.', note: '숫자 변경' },
    { text: '3시까지 연락처로 "확인" 부탁드립니다. 널스페이스 건입니다.', note: '자리표시자 삭제' },
    { text: '3시까지 ⟦PII_1⟧로 확인 부탁드립니다. 널스페이스 건입니다.', note: '인용문 삭제' },
    { text: '3시까지 ⟦PII_1⟧로 "확인" 부탁드립니다. 스페이스 건입니다.', note: '사전 단어 변경' },
    { text: '3시까지 ⟦PII_1⟧로 "확인" 부탁드립니다. 널스페이스 건입니다.', note: '중복' },
    { text: src, note: '그대로' },
    { note: '스키마 오류' },
  ];
  const r = validateAlternatives(items, src, ['널스페이스'], 3);
  assert.equal(r.alternatives.length, 1);
  assert.deepEqual(r.dropped, { protected_changed: 2, quote_changed: 1, proper_noun_changed: 1, duplicate: 1, no_change: 1, schema_invalid: 1 });
});
