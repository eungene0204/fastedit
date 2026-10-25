import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmError } from '../client/openrouter-client.ts';
import { ModelRegistry } from '../registry/registry.ts';
import { model, testConfig } from '../testing/fixtures.ts';
import { CircuitBreaker, ModelSkipped, RouteError, Router, Throttled } from './router.ts';

const never = () => {
  throw new Error('실패해야 하는 호출이 성공했습니다');
};

const setup = (over: Record<string, unknown> = {}, now = () => Date.now()) => {
  const registry = new ModelRegistry(testConfig({ allowPaidFallback: true, ...over }));
  const breaker = new CircuitBreaker({ errorRateThreshold: 0.5, windowMs: 300_000, minSamples: 4, cooldownMs: 60_000, now });
  return { registry, breaker, router: new Router(registry, breaker, { maxAttempts: 3 }) };
};

test('첫 번째 모델이 성공하면 대체 없이 끝난다', async () => {
  const { router } = setup();
  const r = await router.run('polish', async (m) => m.id);
  assert.deepEqual([r.value, r.fellBack, r.attempts], ['free/a:free', false, 1]);
});

test('실패하면 다음 모델로 넘어가고 최대 시도 수를 지킨다', async () => {
  const { router } = setup({ models: ['a', 'b', 'c', 'd'].map((x, i) => model(`${x}:free`, { priority: i })), chains: {} });
  const tried: string[] = [];
  const err = await router
    .run('polish', async (m) => {
      tried.push(m.id);
      throw new LlmError('server', 'boom');
    })
    .then(never, (e: RouteError) => e);
  assert.equal(err.kind, 'all_failed');
  assert.equal(tried.length, 3);

  const { router: r2 } = setup();
  const ok = await r2.run('polish', async (m) => {
    if (m.id === 'free/a:free') throw new LlmError('timeout', 't');
    return m.id;
  });
  assert.deepEqual([ok.value, ok.fellBack, ok.attempts], ['free/b:free', true, 2]);
});

test('ModelSkipped는 시도 횟수에 세지 않는다', async () => {
  const { router } = setup();
  const r = await router.run('polish', async (m) => {
    if (m.tier === 'free') throw new ModelSkipped('quota');
    return m.id;
  });
  assert.equal(r.value, 'paid/c');
  assert.equal(r.attempts, 1);
  const { router: free } = setup({ allowPaidFallback: false });
  const err = await free.run('polish', async () => { throw new ModelSkipped('quota'); }).then(never, (e: RouteError) => e);
  assert.equal(err.kind, 'quota_exhausted');
});

test('Throttled는 대체 모델로 넘기지 않고 요청 전체를 중단한다', async () => {
  const { router } = setup();
  let calls = 0;
  const err = await router.run('polish', async () => { calls++; throw new Throttled(); }).then(never, (e: RouteError) => e);
  assert.equal(err.kind, 'throttled');
  assert.equal(calls, 1);
});

test('체인이 비어 있으면 no_model', async () => {
  const { router } = setup({ models: [model('a:free', { dataPolicy: 'may-train' })], chains: {} });
  const err = await router.run('polish', async () => 1).then(never, (e: RouteError) => e);
  assert.equal(err.kind, 'no_model');
});

test('서킷 브레이커: 오류율이 50%를 넘으면 차단하고, 쿨다운 뒤에 시험 호출을 허용한다', async () => {
  let t = 1_000_000;
  const { router, breaker } = setup({}, () => t);
  for (let i = 0; i < 4; i++) breaker.record('free/a:free', false);
  assert.equal(breaker.isOpen('free/a:free'), true);
  const r = await router.run('polish', async (m) => m.id);
  assert.equal(r.value, 'free/b:free');
  t += 61_000;
  assert.equal(breaker.isOpen('free/a:free'), false);
  // 창 밖으로 밀려나면 기록이 사라진다
  t += 300_000;
  assert.equal(breaker.errorRate('free/a:free'), 0);
});

test('오류율이 임계값 이하이거나 표본이 적으면 차단하지 않는다', () => {
  const { breaker } = setup();
  breaker.record('x', false);
  breaker.record('x', false);
  assert.equal(breaker.isOpen('x'), false); // 표본 2 < 4
  for (let i = 0; i < 4; i++) breaker.record('y', i % 2 === 0);
  assert.equal(breaker.isOpen('y'), false); // 정확히 50%
});

test('호출자가 취소하면 모델 실패로 세지 않는다', async () => {
  const { router, breaker } = setup();
  const err = await router.run('polish', async () => { throw new LlmError('aborted', 'x'); }).then(never, (e: RouteError) => e);
  assert.equal(err.kind, 'aborted');
  assert.equal(breaker.errorRate('free/a:free'), 0);
});
