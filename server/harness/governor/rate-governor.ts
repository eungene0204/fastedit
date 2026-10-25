import type { HarnessPriority } from '../../../shared/harness.ts';
import type { KvStore } from '../store/kv.ts';
import type { Tier } from '../types.ts';

export type GovernorDecision = 'ok' | 'deny_low_priority' | 'exhausted';

export interface GovernorUsage {
  minute: number;
  day: number;
  perMinute: number;
  perDay: number;
  /** 0~1: 분·일 중 더 높은 사용률 */
  ratio: number;
}

export interface RateGovernor {
  acquire(priority: HarnessPriority, tier: Tier): Promise<GovernorDecision>;
  usage(): Promise<GovernorUsage>;
}

export interface GovernorOptions {
  perMinute: number;
  perDay: number;
  softRatio: number;
  now?: () => number;
}

/**
 * OpenRouter 무료 모델 한도(계정 전체)를 KvStore 카운터로 추적한다.
 * 호출 직전에 먼저 증가시켜 자리를 잡고, 거절하면 되돌린다 (여러 인스턴스가 같은 Redis를 공유).
 * 실패한 요청도 한도에 포함될 수 있으므로 결과와 무관하게 되돌리지 않는다.
 */
export class KvRateGovernor implements RateGovernor {
  private kv: KvStore;
  private o: GovernorOptions;
  private now: () => number;

  constructor(kv: KvStore, opts: GovernorOptions) {
    this.kv = kv;
    this.o = opts;
    this.now = opts.now ?? Date.now;
  }

  private keys() {
    const t = this.now();
    return { min: `fastedit:rg:min:${Math.floor(t / 60_000)}`, day: `fastedit:rg:day:${new Date(t).toISOString().slice(0, 10)}` };
  }

  async acquire(priority: HarnessPriority, tier: Tier): Promise<GovernorDecision> {
    // 유료 모델은 무료 한도와 무관하다
    if (tier === 'paid') return 'ok';
    const k = this.keys();
    const [minute, day] = await Promise.all([this.kv.incr(k.min, 120), this.kv.incr(k.day, 172_800)]);
    const hardOver = minute > this.o.perMinute || day > this.o.perDay;
    // 소프트 한도: 이 요청까지 포함한 사용량이 비율 이상이면 낮은 우선순위는 거절
    const softOver = minute > this.o.perMinute * this.o.softRatio || day > this.o.perDay * this.o.softRatio;
    if (hardOver || (softOver && priority === 'auto')) {
      await Promise.all([this.kv.decr(k.min), this.kv.decr(k.day)]);
      return hardOver ? 'exhausted' : 'deny_low_priority';
    }
    return 'ok';
  }

  async usage(): Promise<GovernorUsage> {
    const k = this.keys();
    const [m, d] = await Promise.all([this.kv.get(k.min), this.kv.get(k.day)]);
    const minute = Number(m ?? 0);
    const day = Number(d ?? 0);
    return {
      minute,
      day,
      perMinute: this.o.perMinute,
      perDay: this.o.perDay,
      ratio: Math.max(minute / this.o.perMinute, day / this.o.perDay),
    };
  }
}
