import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryKv } from '../store/kv.ts';
import { EncryptedCache } from './cache.ts';

test('저장한 값을 읽고, 저장소에는 평문이 남지 않는다', async () => {
  const kv = new MemoryKv();
  const raw: string[] = [];
  const spy = { ...kv, get: kv.get.bind(kv), set: async (k: string, v: string, t: number) => { raw.push(k, v); await kv.set(k, v, t); } } as unknown as MemoryKv;
  const cache = new EncryptedCache(spy, { ttlSec: 60, secret: 'test-secret' });
  const secret = '비밀스러운 문장 할께요';
  const key = cache.key(['spell', secret]);
  await cache.set(key, { suggestions: [{ original: secret, replacement: '비밀 문장' }] });
  assert.deepEqual(await cache.get(key), { suggestions: [{ original: secret, replacement: '비밀 문장' }] });
  const stored = raw.join('\n');
  assert.ok(!stored.includes('비밀'), '키와 값에 원문이 없어야 한다');
  assert.ok(!Buffer.from(raw[1], 'base64').toString('utf8').includes('비밀'));
});

test('같은 입력은 같은 키, 다른 입력이나 다른 비밀값은 다른 키', () => {
  const a = new EncryptedCache(new MemoryKv(), { ttlSec: 1, secret: 's1' });
  const b = new EncryptedCache(new MemoryKv(), { ttlSec: 1, secret: 's2' });
  assert.equal(a.key(['x', 1]), a.key(['x', 1]));
  assert.notEqual(a.key(['x', 1]), a.key(['x', 2]));
  assert.notEqual(a.key(['x', 1]), b.key(['x', 1]));
});

test('변조되었거나 다른 키로 암호화된 값은 미스로 취급한다', async () => {
  const kv = new MemoryKv();
  const a = new EncryptedCache(kv, { ttlSec: 60, secret: 's1' });
  const b = new EncryptedCache(kv, { ttlSec: 60, secret: 's2' });
  await a.set('k', { v: 1 });
  assert.equal(await b.get('k'), undefined);
  await kv.set('k2', 'AAAA', 60);
  assert.equal(await a.get('k2'), undefined);
});

test('비밀값이 없으면 임시 키로 동작하며 경고한다', async () => {
  const warns: string[] = [];
  const c = new EncryptedCache(new MemoryKv(), { ttlSec: 60, warn: (m) => warns.push(m) });
  await c.set('k', { ok: true });
  assert.deepEqual(await c.get('k'), { ok: true });
  assert.equal(warns.length, 1);
});

test('TTL이 지나면 사라진다', async () => {
  let t = 0;
  const c = new EncryptedCache(new MemoryKv({ now: () => t }), { ttlSec: 10, secret: 's' });
  await c.set('k', 1);
  t = 9_000;
  assert.equal(await c.get('k'), 1);
  t = 10_001;
  assert.equal(await c.get('k'), undefined);
});
