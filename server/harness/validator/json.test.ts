import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractItems, extractJson } from './json.ts';

test('JSON 뒤에 글이 붙거나 객체가 두 번 나와도 첫 객체를 읽는다', () => {
  assert.deepEqual(extractJson('{"suggestions":[]}\n설명입니다. {"x":1}'), { suggestions: [] });
  assert.deepEqual(extractJson('{"suggestions":[]}{"suggestions":[1]}'), { suggestions: [] });
});

test('코드 블록과 앞쪽 설명을 무시한다', () => {
  assert.deepEqual(extractJson('결과:\n```json\n{"a":"b"}\n```'), { a: 'b' });
});

test('문자열 안의 중괄호·제어 문자·후행 쉼표를 견딘다', () => {
  assert.deepEqual(extractJson('{"a":"{ } \\" }"} 끝'), { a: '{ } " }' });
  assert.deepEqual(extractJson('{"a":"줄\n바꿈"}'), { a: '줄 바꿈' });
  assert.deepEqual(extractJson('{"a":[1,2,],"b":{"c":1,},}'), { a: [1, 2], b: { c: 1 } });
  assert.deepEqual(extractJson('{"a":"x,}"}'), { a: 'x,}' });
});

test('extractItems: 객체, 최상위 배열, 빈 배열', () => {
  assert.deepEqual(extractItems('{"suggestions":[{"a":1}]}', 'suggestions'), [{ a: 1 }]);
  assert.deepEqual(extractItems('[{"a":1}]', 'suggestions'), [{ a: 1 }]);
  assert.deepEqual(extractItems('{"suggestions":[]}', 'suggestions'), []);
  assert.deepEqual(extractItems('{}', 'suggestions'), []);
  assert.deepEqual(extractItems('{"alternatives":[{"text":"a"}]}', 'alternatives'), [{ text: 'a' }]);
});

test('출력이 중간에 잘려도 완결된 제안은 살린다', () => {
  const cut = '{"suggestions":[{"sentence":1,"original":"가","replacement":"나"},{"sentence":2,"original":"다","replac';
  assert.deepEqual(extractItems(cut, 'suggestions'), [{ sentence: 1, original: '가', replacement: '나' }]);
});

test('복구할 수 없으면 null (배치 실패)', () => {
  assert.equal(extractItems('죄송합니다. 도와드릴 수 없습니다.', 'suggestions'), null);
  assert.equal(extractItems('{"suggestions":[{"sentence":1,"orig', 'suggestions'), null);
  assert.equal(extractItems('{"other":[]}', 'suggestions'), null);
});
