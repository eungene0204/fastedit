import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBatches } from './batch.ts';
import { detectLanguage } from './lang.ts';
import { maskPii, toOriginalRange, unmaskPii } from './pii.ts';
import { splitSentences } from './sentences.ts';

const texts = (t: string) => splitSentences(t).map((s) => s.text);

test('한국어 문장을 종결 부호와 줄바꿈으로 나눈다', () => {
  assert.deepEqual(texts('오늘은 맑다. 내일은 비가 온다! 정말일까? 그렇다.\n새 문단입니다'), [
    '오늘은 맑다.',
    '내일은 비가 온다!',
    '정말일까?',
    '그렇다.',
    '새 문단입니다',
  ]);
});

test('따옴표 안의 종결 부호에서는 끊지 않는다', () => {
  assert.deepEqual(texts('그는 "안 가요. 절대로." 라고 말했다. 그리고 떠났다.'), ['그는 "안 가요. 절대로." 라고 말했다.', '그리고 떠났다.']);
  assert.deepEqual(texts('그가 “잘 가!” 하고 외쳤다. 끝.'), ['그가 “잘 가!” 하고 외쳤다.', '끝.']);
});

test('소수점·도메인·영어 약어에서는 끊지 않는다', () => {
  assert.deepEqual(texts('값은 3.14입니다. example.com에 접속하세요.'), ['값은 3.14입니다.', 'example.com에 접속하세요.']);
  assert.deepEqual(texts('Dr. Kim met Mr. Lee. They talked.'), ['Dr. Kim met Mr. Lee.', 'They talked.']);
});

test('문장 오프셋이 원문과 정확히 일치한다', () => {
  const text = '  첫째 문장이다.   둘째 문장이다!\n\n셋째';
  for (const s of splitSentences(text)) assert.equal(text.slice(s.start, s.end), s.text);
});

test('언어 감지', () => {
  assert.equal(detectLanguage('안녕하세요 Notion을 씁니다'), 'ko');
  assert.equal(detectLanguage('This is an English sentence.'), 'en');
});

test('민감정보를 자리표시자로 바꾸고 되돌린다', () => {
  const text = '주민 900101-1234567, 카드 1234-5678-9012-3456, 전화 010-1234-5678, 메일 a.b@test.co.kr, 계좌 110-123-456789 입니다. 날짜 2024-05-03.';
  const m = maskPii(text);
  for (const raw of ['900101-1234567', '1234-5678-9012-3456', '010-1234-5678', 'a.b@test.co.kr', '110-123-456789']) {
    assert.ok(!m.text.includes(raw), raw);
  }
  assert.ok(m.text.includes('2024-05-03'), '날짜는 마스킹하지 않는다');
  assert.equal(m.tokens.size, 5);
  assert.equal(unmaskPii(m.text, m.tokens), text);
});

test('마스킹 좌표를 원문 좌표로 바꾼다', () => {
  const text = '연락처는 010-1234-5678 이고 주소는 서울이다.';
  const m = maskPii(text);
  const ms = m.text.indexOf('주소는');
  const r = toOriginalRange(m.segments, ms, ms + 3)!;
  assert.equal(text.slice(r[0], r[1]), '주소는');
  // 자리표시자 중간을 가로지르는 범위는 거절
  const t = m.text.indexOf('⟦');
  assert.equal(toOriginalRange(m.segments, t + 2, t + 5), null);
});

test('문장 수·글자 수·언어가 바뀌면 배치를 나눈다', () => {
  const mk = (n: number, lang: 'ko' | 'en' = 'ko', len = 10) => Array.from({ length: n }, () => ({ text: 'x'.repeat(len), lang }));
  assert.deepEqual(makeBatches(mk(20), { maxSentences: 8, maxChars: 1500 }).map((b) => b.length), [8, 8, 4]);
  assert.deepEqual(makeBatches(mk(5, 'ko', 400), { maxSentences: 8, maxChars: 1500 }).map((b) => b.length), [3, 2]);
  assert.deepEqual(makeBatches([...mk(2), ...mk(2, 'en')], { maxSentences: 8, maxChars: 1500 }).map((b) => b.length), [2, 2]);
});
