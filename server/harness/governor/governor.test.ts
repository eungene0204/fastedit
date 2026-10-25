import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryKv } from '../store/kv.ts';
import { KvRateGovernor } from './rate-governor.ts';

const make = (over: Partial<ConstructorParameters<typeof KvRateGovernor>[1]> = {}) => {
  let t = Date.UTC(2026, 0, 1, 12, 0, 0);
  const kv = new MemoryKv({ now: () => t });
  const g = new KvRateGovernor(kv, { perMinute: 10, perDay: 50, softRatio: 0.8, now: () => t, ...over });
  return { g, kv, advance: (ms: number) => void (t += ms) };
};

test('80%까지는 모두 통과하고, 그 뒤로는 자동 요청만 거절한다', async () => {
  const { g } = make();
  for (let i = 0; i < 8; i++) assert.equal(await g.acquire('auto', 'free'), 'ok');
  assert.equal(await g.acquire('auto', 'free'), 'deny_low_priority');
  assert.equal(await g.acquire('user', 'free'), 'ok'); // 9번째
  assert.equal(await g.acquire('user', 'free'), 'ok'); // 10번째
  assert.equal(await g.acquire('user', 'free'), 'exhausted');
});

test('거절된 요청은 카운터를 되돌린다', async () => {
  const { g } = make();
  for (let i = 0; i < 8; i++) await g.acquire('auto', 'free');
  for (let i = 0; i < 5; i++) await g.acquire('auto', 'free');
  assert.equal((await g.usage()).minute, 8);
});

test('분이 바뀌면 분당 카운터가 초기화되고, 일일 카운터는 유지된다', async () => {
  const { g, advance } = make();
  for (let i = 0; i < 10; i++) await g.acquire('user', 'free');
  assert.equal(await g.acquire('user', 'free'), 'exhausted');
  advance(61_000);
  assert.equal(await g.acquire('user', 'free'), 'ok');
  const u = await g.usage();
  assert.equal(u.minute, 1);
  assert.equal(u.day, 11);
});

test('일일 한도를 넘으면 exhausted', async () => {
  const { g, advance } = make({ perMinute: 100, perDay: 5 });
  for (let i = 0; i < 5; i++) {
    assert.equal(await g.acquire('user', 'free'), 'ok');
    advance(61_000);
  }
  assert.equal(await g.acquire('user', 'free'), 'exhausted');
});

test('유료 모델은 무료 한도에 세지 않는다', async () => {
  const { g } = make({ perMinute: 1 });
  for (let i = 0; i < 5; i++) assert.equal(await g.acquire('auto', 'paid'), 'ok');
  assert.equal((await g.usage()).minute, 0);
});

test('인스턴스 둘이 같은 저장소를 공유하면 한도도 공유한다', async () => {
  const { kv } = make();
  const opts = { perMinute: 4, perDay: 50, softRatio: 1 };
  const a = new KvRateGovernor(kv, opts);
  const b = new KvRateGovernor(kv, opts);
  const results = await Promise.all([a.acquire('user', 'free'), b.acquire('user', 'free'), a.acquire('user', 'free'), b.acquire('user', 'free'), a.acquire('user', 'free'), b.acquire('user', 'free')]);
  assert.equal(results.filter((r) => r === 'ok').length, 4);
});
