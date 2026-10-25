import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { buildTestHarness } from './testing/harness-factory.ts';
import { MockOpenRouter, sentencesOf, type MockRequest } from './testing/mock-openrouter.ts';

const mock = new MockOpenRouter();
let base = '';
before(async () => void (base = await mock.start()));
after(() => mock.stop());
beforeEach(() => {
  mock.requests = [];
  mock.handler = () => ({ content: '{"suggestions":[]}' });
});

const fix = (sentence: number, original: string, replacement: string, extra: Record<string, unknown> = {}) => ({
  sentence,
  original,
  occurrence: 1,
  replacement,
  category: 'spelling',
  reason: '맞춤법',
  confidence: 0.9,
  ...extra,
});
const reply = (...items: unknown[]) => ({ content: JSON.stringify({ suggestions: items }) });
const req = (text: string, over: Record<string, unknown> = {}) => ({ docVersion: 42, text, task: 'polish' as const, ...over });

test('문서 좌표로 제안을 돌려주고 docVersion·모델·프롬프트 버전을 채운다', async () => {
  const { harness } = buildTestHarness(base);
  mock.handler = () => reply(fix(1, '되요', '돼요'), fix(2, '할께', '할게'));
  const text = '그건 안 되요. 내일 할께 약속.';
  const res = await harness.suggest(req(text, { requestId: 'r1' }));
  assert.equal(res.requestId, 'r1');
  assert.equal(res.docVersion, 42);
  assert.equal(res.suggestions.length, 2);
  for (const s of res.suggestions) {
    assert.equal(text.slice(s.start, s.end), s.original);
    assert.equal(s.model, 'free/a:free');
    assert.equal(s.promptVersion, 'polish@v1');
    assert.equal(s.type, 'error');
  }
  assert.deepEqual([res.meta.cached, res.meta.modelCalls, res.meta.degraded], [0, 1, false]);
});

test('캐시된 문장은 모델을 다시 부르지 않는다 (빈 결과도 캐시)', async () => {
  const { harness } = buildTestHarness(base);
  mock.handler = (b) => (sentencesOf(b).length === 2 ? reply(fix(1, '되요', '돼요')) : reply());
  const text = '안 되요. 이건 괜찮다.';
  const first = await harness.suggest(req(text));
  assert.equal(mock.requests.length, 1);
  const second = await harness.suggest(req(text));
  assert.equal(mock.requests.length, 1);
  assert.equal(second.meta.cached, 2);
  assert.equal(second.meta.modelCalls, 0);
  assert.deepEqual(second.suggestions.map((s) => [s.start, s.end, s.replacement]), first.suggestions.map((s) => [s.start, s.end, s.replacement]));
  // 앞에 문장을 붙여 오프셋이 밀려도 캐시된 제안의 위치가 맞는다
  const shifted = '새 문장이다. ' + text;
  mock.handler = () => reply();
  const third = await harness.suggest(req(shifted));
  assert.equal(third.meta.cached, 2);
  assert.equal(shifted.slice(third.suggestions[0].start, third.suggestions[0].end), '되요');
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(sentencesOf(mock.requests[1]), ['새 문장이다.']);
});

test('설정이 다르면 캐시를 공유하지 않는다', async () => {
  const { harness } = buildTestHarness(base);
  await harness.suggest(req('한 문장이다.', { strength: 'light' }));
  await harness.suggest(req('한 문장이다.', { strength: 'strong' }));
  await harness.suggest(req('한 문장이다.', { task: 'spell' }));
  assert.equal(mock.requests.length, 3);
});

test('문장 9개는 배치 2개로 나뉘어 병렬 호출되고, 영어는 영어 프롬프트를 쓴다', async () => {
  const { harness } = buildTestHarness(base);
  const ko = Array.from({ length: 9 }, (_, i) => `문장 번호 ${i}.`).join(' ');
  await harness.suggest(req(ko));
  assert.deepEqual(mock.requests.map((r) => sentencesOf(r).length).sort(), [1, 8]);
  mock.requests = [];
  await harness.suggest(req('I has a apple. 오늘은 맑다.'));
  assert.equal(mock.requests.length, 2);
  const en = mock.requests.find((r) => sentencesOf(r)[0].startsWith('I has'))!;
  assert.match(en.messages[0].content, /English writing/);
});

test('잘못된 JSON·원문에 없는 original이 섞여 있어도 나머지 제안은 정상 반환된다', async () => {
  const { harness, logs } = buildTestHarness(base);
  mock.handler = () => ({
    content:
      '결과입니다:\n```json\n' +
      JSON.stringify({ suggestions: [fix(1, '되요', '돼요'), fix(1, '없는구간', 'x'), { sentence: 1, original: 3 }, fix(1, '3시', '4시', { category: 'word_choice' })] }).replace(/\]\}$/, ',]}') +
      '\n```',
  });
  const res = await harness.suggest(req('3시에 안 되요.'));
  assert.deepEqual(res.suggestions.map((s) => s.replacement), ['돼요']);
  assert.equal(res.meta.degraded, false);
  const rec = JSON.parse(logs.find((l) => l.includes('harness.request'))!);
  assert.deepEqual(rec.dropped, { original_not_found: 1, schema_invalid: 1, protected_changed: 1 });
});

test('모델이 깨진 출력을 내면 다음 모델로 넘어간다', async () => {
  const { harness, telemetry } = buildTestHarness(base);
  mock.handler = (b) => (b.model === 'free/a:free' ? { content: '죄송합니다, 처리할 수 없습니다.' } : reply(fix(1, '되요', '돼요')));
  const res = await harness.suggest(req('안 되요.'));
  assert.deepEqual(res.suggestions.map((s) => s.model), ['free/b:free']);
  assert.equal(res.meta.modelCalls, 2);
  assert.equal(res.meta.degraded, false);
  assert.equal(telemetry.snapshot().counters.parse_failures, 1);
  assert.equal(telemetry.snapshot().counters.fallbacks, 1);
});

test('429·5xx·시간 초과가 이어지면 유료 모델로 넘어간다 (allowPaidFallback)', async () => {
  const { harness } = buildTestHarness(base);
  mock.handler = (b) => (b.model === 'paid/c' ? reply(fix(1, '되요', '돼요')) : b.model === 'free/a:free' ? { status: 429 } : { status: 503 });
  const res = await harness.suggest(req('안 되요.'));
  assert.deepEqual(res.suggestions.map((s) => s.model), ['paid/c']);
  assert.equal(res.meta.modelCalls, 3);
});

test('allowPaidFallback=false면 유료 모델을 쓰지 않고 degraded로 돌려준다', async () => {
  const { harness } = buildTestHarness(base, { allowPaidFallback: false });
  mock.handler = () => ({ status: 503 });
  const res = await harness.suggest(req('안 되요.'));
  assert.deepEqual([res.suggestions.length, res.meta.degraded, res.meta.reason], [0, true, 'all_failed']);
  assert.ok(mock.requests.every((r) => r.model !== 'paid/c'));
});

test('모든 모델이 실패해도 예외 없이 빈 제안과 degraded:true', async () => {
  const { harness } = buildTestHarness(base);
  mock.handler = () => ({ content: '' });
  const res = await harness.suggest(req('안 되요.'));
  assert.deepEqual([res.suggestions, res.meta.degraded], [[], true]);
});

test('한도에 도달해도 오류 없이 대체 또는 degraded: 자동 요청은 80%에서 거절, 사용자 요청은 통과', async () => {
  const { harness, governor } = buildTestHarness(base, { limits: { perMinute: 10, perDay: 100, softRatio: 0.8 }, allowPaidFallback: false });
  for (let i = 0; i < 8; i++) await governor.acquire('user', 'free'); // 80% 사용 중
  const auto = await harness.suggest(req('안 되요.', { priority: 'auto' }));
  assert.deepEqual([auto.meta.degraded, auto.meta.reason, auto.meta.modelCalls], [true, 'throttled', 0]);
  assert.equal(mock.requests.length, 0);
  const user = await harness.suggest(req('안 되요.', { priority: 'user' }));
  assert.equal(user.meta.degraded, false);
  assert.equal(mock.requests.length, 1);
  // 소진: 무료 한도가 바닥나면 유료 허용 시 유료로, 아니면 degraded
  await governor.acquire('user', 'free');
  const exhausted = await harness.suggest(req('다른 문장이다.', { priority: 'user' }));
  assert.deepEqual([exhausted.meta.degraded, exhausted.meta.reason], [true, 'quota_exhausted']);
});

test('무료 한도가 소진되면 유료 모델로 대체한다', async () => {
  const { harness, governor } = buildTestHarness(base, { limits: { perMinute: 2, perDay: 100, softRatio: 1 } });
  await governor.acquire('user', 'free');
  await governor.acquire('user', 'free');
  mock.handler = () => reply(fix(1, '되요', '돼요'));
  const res = await harness.suggest(req('안 되요.'));
  assert.deepEqual(res.suggestions.map((s) => s.model), ['paid/c']);
  assert.equal(res.meta.degraded, false);
});

test('API 키가 없으면 모델을 부르지 않고 degraded(llm_disabled)', async () => {
  const b = buildTestHarness(base);
  const { Harness } = await import('./harness.ts');
  const off = new Harness({ ...(b.harness as unknown as { d: ConstructorParameters<typeof Harness>[0] }).d, enabled: false });
  const res = await off.suggest(req('안 되요.'));
  assert.deepEqual([res.meta.degraded, res.meta.reason], [true, 'llm_disabled']);
  assert.equal(mock.requests.length, 0);
});

test('스트리밍: 캐시 결과가 먼저, 이어서 배치가 끝나는 순서대로, 마지막에 done', async () => {
  const { harness } = buildTestHarness(base);
  await harness.suggest(req('캐시된 문장이다.'));
  mock.handler = (b) => (sentencesOf(b).length === 8 ? { ...reply(fix(1, '되요', '돼요')), delayMs: 120 } : reply(fix(1, '할께', '할게')));
  const text = '캐시된 문장이다. 안 되요. ' + Array.from({ length: 8 }, (_, i) => `다른 ${i}번 문장 할께.`).join(' ');
  const events: string[] = [];
  for await (const ev of harness.suggestStream(req(text))) {
    events.push(ev.kind === 'done' ? 'done' : `${ev.cached ? 'cached' : 'batch'}:${ev.suggestions.length}`);
    if (ev.kind === 'done') assert.ok(ev.response.suggestions.length >= 2);
  }
  assert.equal(events[0], 'cached:0');
  assert.equal(events.at(-1), 'done');
  assert.equal(events.filter((e) => e.startsWith('batch')).length, 2);
});

test('톤 대안: 검증을 통과한 대안만, 되돌린 민감정보와 함께 돌려준다', async () => {
  const { harness } = buildTestHarness(base);
  mock.handler = (b: MockRequest) => {
    assert.ok(!b.messages.map((m) => m.content).join().includes('010-1234-5678'), '민감정보가 모델에 전달되면 안 된다');
    return {
      content: JSON.stringify({
        alternatives: [
          { text: '3시까지 ⟦PII_1⟧로 연락 부탁드립니다.', note: '공손' },
          { text: '4시까지 ⟦PII_1⟧로 연락 부탁드립니다.', note: '숫자 변경' },
          { text: '3시까지 연락 부탁드립니다.', note: '자리표시자 삭제' },
          { text: '3시까지 ⟦PII_1⟧로 연락 주시면 감사하겠습니다.', note: '더 공손' },
        ],
      }),
    };
  };
  const res = await harness.alternatives({ text: '3시까지 010-1234-5678로 연락해.', tone: 'polite' });
  assert.deepEqual(res.alternatives.map((a) => a.text), ['3시까지 010-1234-5678로 연락 부탁드립니다.', '3시까지 010-1234-5678로 연락 주시면 감사하겠습니다.']);
  assert.equal(res.promptVersion, 'tone@v1');
  const again = await harness.alternatives({ text: '3시까지 010-1234-5678로 연락해.', tone: 'polite' });
  assert.equal(again.meta.cached, 1);
  assert.equal(mock.requests.length, 1);
});

test('민감정보는 모델에 전달되지 않고, 로그·캐시·텔레메트리 어디에도 원문이 남지 않는다', async () => {
  const logs: string[] = [];
  const { harness, kv } = buildTestHarness(base, {}, logs);
  const pii = '010-1234-5678';
  const secretSentence = '비밀스러운우리집주소 문장이 할께요';
  const sent: string[] = [];
  mock.handler = (b) => {
    sent.push(b.messages.map((m) => m.content).join('\n'));
    return reply(fix(1, '할께요', '할게요'), fix(2, '⟦PII_1⟧', pii));
  };
  const stored: string[] = [];
  const origSet = kv.set.bind(kv);
  kv.set = async (k, v, t) => { stored.push(k, v); await origSet(k, v, t); };
  const res = await harness.suggest(req(`${secretSentence}. 전화는 ${pii} 입니다.`));
  assert.equal(res.suggestions.length, 1);
  assert.ok(sent.every((s) => !s.includes(pii)), '모델에 전달된 프롬프트에 전화번호가 없어야 한다');
  const everything = [...logs, ...stored].join('\n');
  for (const needle of [pii, '비밀스러운우리집주소', '할께요', '할게요']) assert.ok(!everything.includes(needle), `평문 노출: ${needle}`);
  const rec = JSON.parse(logs.find((l) => l.includes('harness.request'))!);
  assert.equal(rec.textLen, `${secretSentence}. 전화는 ${pii} 입니다.`.length);
  assert.match(rec.textHash, /^[0-9a-f]{12}$/);
});

test('피드백으로 모델·프롬프트 버전별 수락률을 집계한다', () => {
  const { telemetry } = buildTestHarness(base);
  const ev = { suggestionId: 'x', model: 'free/a:free', promptVersion: 'polish@v1' };
  telemetry.feedback({ ...ev, action: 'accept' });
  telemetry.feedback({ ...ev, action: 'accept' });
  telemetry.feedback({ ...ev, action: 'reject' });
  assert.deepEqual(telemetry.acceptance(), [{ model: 'free/a:free', promptVersion: 'polish@v1', accepted: 2, rejected: 1, acceptRate: 2 / 3 }]);
});
