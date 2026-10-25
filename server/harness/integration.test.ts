import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './index.ts';
import { KvRateGovernor } from './governor/rate-governor.ts';
import { EncryptedCache } from './cache/cache.ts';
import { RedisKv } from './store/kv.ts';

// 실제 Redis·OpenRouter를 쓰는 테스트: INTEGRATION=1 일 때만 돈다.
//   REDIS_URL(기본 redis://127.0.0.1:6379), OPENROUTER_API_KEY 필요. OpenRouter 테스트는 요청 한도를 1회 쓴다.
const on = process.env.INTEGRATION === '1';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

test('Redis: 두 인스턴스가 한도를 공유하고 캐시는 암호화되어 저장된다', { skip: !on }, async () => {
  const kv = await RedisKv.connect(REDIS_URL);
  const prefix = `it${Date.now()}`;
  try {
    const opts = { perMinute: 4, perDay: 1000, softRatio: 1, now: () => Date.UTC(2030, 0, 1) + Number(prefix.slice(2)) % 1000 * 86_400_000 };
    const a = new KvRateGovernor(kv, opts);
    const b = new KvRateGovernor(kv, opts);
    const r = await Promise.all([a, b, a, b, a, b].map((g) => g.acquire('user', 'free')));
    assert.equal(r.filter((x) => x === 'ok').length, 4);

    const cache = new EncryptedCache(kv, { ttlSec: 30, secret: 'it' });
    const key = cache.key([prefix, '원문 문장']);
    await cache.set(key, { original: '원문 문장' });
    assert.deepEqual(await cache.get(key), { original: '원문 문장' });
  } finally {
    await kv.close();
  }
});

test('OpenRouter: 설정된 첫 모델로 실제 교정 요청이 끝까지 동작한다', { skip: !on || !process.env.OPENROUTER_API_KEY }, async () => {
  const b = await createHarness({ ...process.env, REDIS_URL: undefined });
  try {
    const res = await b.harness.suggest({ docVersion: 1, text: '내일 회의는 제가 준비할께요.', task: 'spell', priority: 'user' });
    console.log('[integration]', JSON.stringify(res.meta), res.suggestions.map((s) => `${s.original}→${s.replacement}`));
    assert.equal(res.meta.degraded, false);
  } finally {
    await b.stop();
  }
});
