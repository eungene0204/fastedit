import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { KvStore } from '../store/kv.ts';

export interface Cache {
  /** 입력 조각들로 캐시 키를 만든다. 원문은 키에 들어가지 않고 HMAC 해시만 남는다 */
  key(parts: unknown[]): string;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface CacheOptions {
  ttlSec: number;
  /** 암호화 비밀값(CACHE_ENCRYPTION_KEY). 없으면 프로세스마다 임시 키를 만든다 */
  secret?: string;
  warn?: (msg: string) => void;
}

/**
 * 결과의 original/replacement는 사용자 문장의 일부이므로 AES-256-GCM으로 암호화해 저장한다.
 * 키는 HMAC(비밀값, 입력)이라 키 이름만으로 원문을 추측할 수도 없다.
 * 비밀값이 없으면 임시 키를 쓴다: 재시작하거나 다른 인스턴스에서는 읽지 못해 캐시 미스가 될 뿐 평문은 남지 않는다.
 */
export class EncryptedCache implements Cache {
  private kv: KvStore;
  private ttlSec: number;
  private encKey: Buffer;
  private macKey: Buffer;

  constructor(kv: KvStore, opts: CacheOptions) {
    this.kv = kv;
    this.ttlSec = opts.ttlSec;
    let secret = opts.secret;
    if (!secret) {
      secret = randomBytes(32).toString('hex');
      (opts.warn ?? console.warn)('[cache] CACHE_ENCRYPTION_KEY가 없어 임시 키를 씁니다. 재시작·다중 인스턴스에서는 캐시가 공유되지 않습니다.');
    }
    this.encKey = Buffer.from(hkdfSync('sha256', secret, 'fastedit', 'cache-enc', 32));
    this.macKey = Buffer.from(hkdfSync('sha256', secret, 'fastedit', 'cache-mac', 32));
  }

  key(parts: unknown[]): string {
    return 'fastedit:c:' + createHmac('sha256', this.macKey).update(JSON.stringify(parts)).digest('hex');
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.kv.get(key);
      if (!raw) return undefined;
      const buf = Buffer.from(raw, 'base64');
      const d = createDecipheriv('aes-256-gcm', this.encKey, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')) as T;
    } catch {
      // 저장소 오류나 복호화 실패는 캐시 미스로 취급한다
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', this.encKey, iv);
      const enc = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
      await this.kv.set(key, Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64'), this.ttlSec);
    } catch {
      // 캐시 쓰기 실패는 요청을 실패시키지 않는다
    }
  }
}
