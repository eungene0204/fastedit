import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig, loadConfig } from '../config.ts';
import { model, testConfig } from '../testing/fixtures.ts';
import { ModelRegistry } from './registry.ts';

const ids = (r: ModelRegistry, t: 'polish' = 'polish') => r.chain(t).models.map((m) => m.id);

test('유료 모델은 allowPaidFallback이 켜져야 체인에 들어간다', () => {
  assert.deepEqual(ids(new ModelRegistry(testConfig())), ['free/a:free', 'free/b:free']);
  assert.deepEqual(ids(new ModelRegistry(testConfig({ allowPaidFallback: true }))), ['free/a:free', 'free/b:free', 'paid/c']);
});

test('dataCollection=deny면 no-train 모델만 쓰고 요청에도 deny를 넣는다', () => {
  const cfg = testConfig({ models: [model('a:free', { dataPolicy: 'may-train' }), model('b:free', { dataPolicy: 'no-train' })], chains: {} });
  const c = new ModelRegistry(cfg).chain('polish');
  assert.deepEqual(c.models.map((m) => m.id), ['b:free']);
  assert.equal(c.dataCollection, 'deny');
});

test('쓸 수 있는 모델이 없으면 onNoEligible에 따라 degrade 또는 relax', () => {
  const models = [model('a:free', { dataPolicy: 'may-train' })];
  const degrade = new ModelRegistry(testConfig({ models, chains: {}, onNoEligible: 'degrade' })).chain('polish');
  assert.deepEqual(degrade.models, []);
  const relax = new ModelRegistry(testConfig({ models, chains: {}, onNoEligible: 'relax' })).chain('polish');
  assert.deepEqual(relax.models.map((m) => m.id), ['a:free']);
  assert.equal(relax.dataCollection, 'allow');
  assert.equal(relax.relaxed, true);
});

test('체인이 없는 작업은 priority 순으로 모든 모델을 쓴다', () => {
  const cfg = testConfig({ models: [model('x:free', { priority: 5 }), model('y:free', { priority: 1 })], chains: {} });
  assert.deepEqual(ids(new ModelRegistry(cfg)), ['y:free', 'x:free']);
});

test('enabled=false와 지원하지 않는 작업은 제외한다', () => {
  const cfg = testConfig({ models: [model('a:free', { enabled: false }), model('b:free', { tasks: ['spell'] }), model('c:free')], chains: {} });
  assert.deepEqual(ids(new ModelRegistry(cfg)), ['c:free']);
});

test('refresh: 목록에서 사라진 모델은 비활성화하고 돌아오면 다시 켠다', async () => {
  const warnings: string[] = [];
  let listed = ['free/a:free', 'paid/c'];
  const fetchFn = (async () => new Response(JSON.stringify({ data: listed.map((id) => ({ id })) }))) as typeof fetch;
  const r = new ModelRegistry(testConfig({ allowPaidFallback: true }), { fetch: fetchFn, log: (m) => warnings.push(m) });
  await r.refresh();
  assert.deepEqual(ids(r), ['free/a:free', 'paid/c']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /free\/b:free/);
  listed = ['free/a:free', 'free/b:free', 'paid/c'];
  await r.refresh();
  assert.deepEqual(ids(r), ['free/a:free', 'free/b:free', 'paid/c']);
});

test('refresh가 실패하면 이전 상태를 유지한다', async () => {
  const r = new ModelRegistry(testConfig(), { fetch: (async () => { throw new Error('offline'); }) as typeof fetch, log: () => {} });
  await r.refresh();
  assert.equal(ids(r).length, 2);
});

test('설정 검증: 체인이 모르는 모델을 가리키면 거부한다', () => {
  assert.throws(() => testConfig({ chains: { polish: ['nope'] } }), /정의되지 않은 모델/);
  assert.throws(() => parseConfig('models: []'));
});

test('실제 config/models.yaml이 유효하고 환경 변수로 덮어쓸 수 있다', () => {
  const cfg = loadConfig('config/models.yaml', { FASTEDIT_DATA_COLLECTION: 'deny', FASTEDIT_ALLOW_PAID: '1' });
  assert.equal(cfg.dataCollection, 'deny');
  assert.equal(cfg.allowPaidFallback, true);
  assert.ok(cfg.models.length >= 2);
});
