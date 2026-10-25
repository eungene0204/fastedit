import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRules } from './rules.ts';

const fix = (text: string) => {
  let out = text;
  for (const s of runRules(text).reverse()) out = out.slice(0, s.from) + s.replacement + out.slice(s.to);
  return out;
};

test('자주 틀리는 표기를 고친다', () => {
  assert.equal(fix('몇일에 하나요? 감사하겠읍니다.'), '며칠에 하나요? 감사하겠습니다.');
  assert.equal(fix('제가 할께요. 금새 끝나요.'), '제가 할게요. 금세 끝나요.');
  assert.equal(fix('그건 안되요. 숙제 않했어.'), '그건 안 돼요. 숙제 안 했어.');
});

test('-ㄹ게는 받침 ㄹ 뒤에서만 고친다', () => {
  assert.deepEqual(runRules('선생님께 여쭤볼게요. 여러분께 드립니다.'), []);
});

test('의존 명사 띄어쓰기', () => {
  assert.equal(fix('할수있다. 먹을것없다.'), '할 수 있다. 먹을 것 없다.');
  assert.deepEqual(runRules('가수있는 무대'), []);
});

test('공백과 문장 부호', () => {
  assert.equal(fix('좋아요  정말 .'), '좋아요 정말.');
});

test('겹치는 제안을 만들지 않는다', () => {
  const s = runRules('안되요  몇일');
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1].to <= s[i].from);
});

test('겹친 마침표는 고치되 말줄임표는 둔다', () => {
  assert.equal(fix('합니다.. 그리고'), '합니다. 그리고');
  assert.deepEqual(runRules('글쎄... 모르겠다'), []);
});
