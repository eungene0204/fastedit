import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreLine, scoreTone, type DatasetRow } from './score.ts';

const row = (over: Partial<DatasetRow> = {}): DatasetRow => ({
  input: '그건 안되요. 서울에서 할께요.',
  expected: [{ original: '안되요', replacement: '안 돼요' }, { original: '할께요', replacement: '할게요' }],
  mustNotChange: ['서울'],
  ...over,
});

test('정확히 일치하거나 겹치며 포함하는 제안을 재현으로 센다', () => {
  const s = scoreLine(row(), [
    { start: 3, end: 6, original: '안되요', replacement: '안 돼요' },
    { start: 11, end: 14, original: '할께요', replacement: '할게요' },
  ]);
  assert.deepEqual(s, { expected: 2, matched: 2, produced: 2, correct: 2, violations: 0 });
  // 더 좁게 고친 제안도 인정
  assert.equal(scoreLine(row(), [{ start: 4, end: 6, original: '되요', replacement: '돼요' }]).matched, 1);
});

test('엉뚱한 제안은 정밀도를 깎고, 금지 구간을 건드리면 위반으로 센다', () => {
  const s = scoreLine(row(), [
    { start: 8, end: 10, original: '서울', replacement: '부산' },
    { start: 0, end: 2, original: '그건', replacement: '그것은' },
  ]);
  assert.deepEqual(s, { expected: 2, matched: 0, produced: 2, correct: 0, violations: 1 });
});

test('톤 대안에서 보존 문자열을 잃으면 위반', () => {
  const r = row({ mustNotChange: ['3시', '김민수'] });
  assert.deepEqual(scoreTone(r, [{ text: '3시까지 김민수 님께' }, { text: '세 시까지 김민수 님께' }]), { alternatives: 2, violations: 1 });
});
