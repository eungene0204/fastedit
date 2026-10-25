import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { model } from '../testing/fixtures.ts';
import { MockOpenRouter } from '../testing/mock-openrouter.ts';
import type { ModelSpec } from '../types.ts';
import { collectStream, LlmError, OpenRouterClient } from './openrouter-client.ts';

const mock = new MockOpenRouter();
let client: OpenRouterClient;
const spec = (over: Record<string, unknown> = {}) => ({ ...model('m:free'), priority: 1, enabled: true, ...over }) as unknown as ModelSpec;
const req = (over: Record<string, unknown> = {}) => ({ model: spec(over), messages: [{ role: 'user' as const, content: 'hi' }], dataCollection: 'deny' as const });

before(async () => {
  const base = await mock.start();
  client = new OpenRouterClient({ apiKey: 'k', baseUrl: base, firstTokenTimeoutMs: 150, totalTimeoutMs: 500 });
});
after(() => mock.stop());

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as LlmError).kind;
  }
  return 'none';
};

test('비스트리밍: 내용, 실제 모델 ID, 토큰 사용량을 돌려주고 provider 옵션을 보낸다', async () => {
  mock.handler = () => ({ content: '{"suggestions":[]}' });
  const r = await client.complete(req());
  assert.equal(r.content, '{"suggestions":[]}');
  assert.equal(r.model, 'm:free');
  assert.deepEqual(r.usage, { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  const sent = mock.requests.at(-1)!;
  assert.equal(sent.provider?.data_collection, 'deny');
  assert.deepEqual(sent.response_format, { type: 'json_object' });
});

test('JSON 모드를 지원하지 않는 모델에는 response_format을 보내지 않고 extraBody를 합친다', async () => {
  await client.complete(req({ supportsJsonMode: false, extraBody: { reasoning: { effort: 'none' } } }));
  const sent = mock.requests.at(-1)!;
  assert.equal(sent.response_format, undefined);
  assert.deepEqual(sent.reasoning, { effort: 'none' });
});

test('스트리밍: 토막 난 SSE를 이어 붙인다', async () => {
  const content = '{"suggestions":[{"original":"가나다라마바사아자차카타파하"}]}';
  mock.handler = () => ({ content });
  const deltas: string[] = [];
  const gen = client.stream(req());
  for (;;) {
    const n = await gen.next();
    if (n.done) {
      assert.equal(n.value.content, content);
      assert.ok(n.value.firstTokenMs !== undefined);
      assert.equal(n.value.usage.totalTokens, 120);
      break;
    }
    deltas.push(n.value);
  }
  assert.ok(deltas.length > 1);
});

test('오류 종류를 구분한다: 429, 5xx, 빈 응답, 본문 오류, 4xx', async () => {
  mock.handler = () => ({ status: 429 });
  assert.equal(await kindOf(client.complete(req())), 'rate_limit');
  mock.handler = () => ({ status: 503 });
  assert.equal(await kindOf(client.complete(req())), 'server');
  mock.handler = () => ({ content: '   ' });
  assert.equal(await kindOf(client.complete(req())), 'empty');
  assert.equal(await kindOf(collectStream(client.stream(req()))), 'empty');
  mock.handler = () => ({ bodyError: { code: 429, message: 'limit' } });
  assert.equal(await kindOf(client.complete(req())), 'rate_limit');
  mock.handler = () => ({ status: 404 });
  assert.equal(await kindOf(client.complete(req())), 'client');
});

test('전체 시간 초과와 첫 토큰 시간 초과를 AbortController로 끊는다', async () => {
  mock.handler = () => ({ content: 'x', delayMs: 800 });
  assert.equal(await kindOf(client.complete(req())), 'timeout');
  mock.handler = () => ({ content: 'xyz', firstTokenDelayMs: 400 });
  const t = Date.now();
  assert.equal(await kindOf(collectStream(client.stream(req()))), 'timeout');
  assert.ok(Date.now() - t < 350, '첫 토큰 제한(150ms)에서 끊어야 한다');
});

test('호출자가 취소하면 aborted', async () => {
  mock.handler = () => ({ content: 'x', delayMs: 300 });
  const ctrl = new AbortController();
  const p = kindOf(client.complete({ ...req(), signal: ctrl.signal }));
  setTimeout(() => ctrl.abort(), 30);
  assert.equal(await p, 'aborted');
});
