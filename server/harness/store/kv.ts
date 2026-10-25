// 캐시·한도 카운터가 쓰는 최소 저장소 인터페이스. Redis와 인메모리 구현을 바꿔 쓸 수 있다.

export interface KvStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** 1 증가시킨 값을 돌려주고, 만료 시간을 ttlSec로 맞춘다 */
  incr(key: string, ttlSec: number): Promise<number>;
  decr(key: string): Promise<number>;
  close(): Promise<void>;
}

export class MemoryKv implements KvStore {
  private map = new Map<string, { value: string; expires: number }>();
  private now: () => number;
  private max: number;

  constructor(opts: { now?: () => number; maxEntries?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.max = opts.maxEntries ?? 20_000;
  }

  private live(key: string) {
    const e = this.map.get(key);
    if (e && e.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string) {
    return this.live(key)?.value;
  }

  async set(key: string, value: string, ttlSec: number) {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlSec * 1000 });
    // 가장 오래된 항목부터 버린다
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  async incr(key: string, ttlSec: number) {
    const n = Number(this.live(key)?.value ?? 0) + 1;
    this.map.set(key, { value: String(n), expires: this.now() + ttlSec * 1000 });
    return n;
  }

  async decr(key: string) {
    const e = this.live(key);
    const n = Number(e?.value ?? 0) - 1;
    if (e) e.value = String(n);
    return n;
  }

  async close() {
    this.map.clear();
  }
}

interface RedisLike {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, mode: 'EX', ttl: number): Promise<unknown>;
  decr(k: string): Promise<number>;
  multi(): { incr(k: string): unknown; expire(k: string, ttl: number): unknown; exec(): Promise<[Error | null, unknown][] | null> };
  quit(): Promise<unknown>;
}

export class RedisKv implements KvStore {
  private redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  static async connect(url: string): Promise<RedisKv> {
    // Redis를 안 쓰는 환경에서는 ioredis를 불러오지 않는다
    const { default: Redis } = await import('ioredis');
    const client = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true, retryStrategy: (n) => Math.min(n * 200, 2000) });
    client.on('error', (err: Error) => console.warn('[redis]', err.message));
    // 연결이 확인될 때까지 기다린다. 실패하면 재시도 루프가 프로세스를 붙잡지 않도록 끊는다
    try {
      await Promise.race([
        client.connect(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('연결 시간 초과')), 3000).unref()),
      ]);
    } catch (err) {
      client.disconnect();
      throw err;
    }
    return new RedisKv(client as unknown as RedisLike);
  }

  async get(key: string) {
    return (await this.redis.get(key)) ?? undefined;
  }

  async set(key: string, value: string, ttlSec: number) {
    await this.redis.set(key, value, 'EX', ttlSec);
  }

  async incr(key: string, ttlSec: number) {
    const tx = this.redis.multi();
    tx.incr(key);
    tx.expire(key, ttlSec);
    const out = await tx.exec();
    return Number(out?.[0]?.[1] ?? 0);
  }

  async decr(key: string) {
    return this.redis.decr(key);
  }

  async close() {
    await this.redis.quit();
  }
}

/** REDIS_URL이 있으면 Redis, 없거나 연결에 실패하면 인메모리 */
export async function createKv(url = process.env.REDIS_URL): Promise<KvStore> {
  if (!url) return new MemoryKv();
  try {
    const kv = await RedisKv.connect(url);
    await kv.get('fastedit:ping');
    return kv;
  } catch (err) {
    console.warn('[kv] Redis에 연결하지 못해 인메모리 저장소를 씁니다:', (err as Error).message);
    return new MemoryKv();
  }
}
