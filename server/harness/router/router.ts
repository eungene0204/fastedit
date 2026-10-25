import { LlmError } from '../client/openrouter-client.ts';
import type { ModelRegistry } from '../registry/registry.ts';
import type { ModelSpec, Task } from '../types.ts';

export interface BreakerOptions {
  errorRateThreshold: number;
  windowMs: number;
  minSamples: number;
  cooldownMs: number;
  now?: () => number;
}

/** 최근 windowMs 동안의 오류율이 임계값을 넘으면 열린다. 마지막 실패 후 cooldownMs가 지나면 시험 호출을 허용한다 */
export class CircuitBreaker {
  private events = new Map<string, { t: number; ok: boolean }[]>();
  private o: BreakerOptions;
  private now: () => number;

  constructor(opts: BreakerOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
  }

  private recent(id: string) {
    const cutoff = this.now() - this.o.windowMs;
    const list = (this.events.get(id) ?? []).filter((e) => e.t >= cutoff);
    this.events.set(id, list);
    return list;
  }

  record(id: string, ok: boolean) {
    this.recent(id).push({ t: this.now(), ok });
  }

  errorRate(id: string): number {
    const list = this.recent(id);
    return list.length ? list.filter((e) => !e.ok).length / list.length : 0;
  }

  isOpen(id: string): boolean {
    const list = this.recent(id);
    if (list.length < this.o.minSamples) return false;
    if (list.filter((e) => !e.ok).length / list.length <= this.o.errorRateThreshold) return false;
    const lastFail = Math.max(...list.filter((e) => !e.ok).map((e) => e.t));
    return this.now() - lastFail < this.o.cooldownMs;
  }
}

/** 이 모델은 건너뛰고 다음 모델로 간다 (시도 횟수에 세지 않고 오류율에도 반영하지 않는다) */
export class ModelSkipped extends Error {
  constructor(message = 'skipped') {
    super(message);
    this.name = 'ModelSkipped';
  }
}

/** 요청 전체를 중단한다 (대체 모델로 넘기지 않는다) */
export class Throttled extends Error {
  constructor(message = 'throttled') {
    super(message);
    this.name = 'Throttled';
  }
}

export type RouteFailKind = 'no_model' | 'all_failed' | 'throttled' | 'quota_exhausted' | 'aborted';

export class RouteError extends Error {
  kind: RouteFailKind;
  attempts: { model: string; error: string }[];
  constructor(kind: RouteFailKind, attempts: { model: string; error: string }[]) {
    super(`${kind}: ${attempts.map((a) => `${a.model} (${a.error})`).join(', ') || '시도 없음'}`);
    this.name = 'RouteError';
    this.kind = kind;
    this.attempts = attempts;
  }
}

export interface RouteResult<T> {
  value: T;
  model: ModelSpec;
  /** 실제로 호출한 모델 수 */
  attempts: number;
  /** 첫 번째 후보가 아닌 모델이 응답했는지 */
  fellBack: boolean;
}

export interface RouterOptions {
  maxAttempts: number;
}

export class Router {
  private registry: ModelRegistry;
  private breaker: CircuitBreaker;
  private o: RouterOptions;

  constructor(registry: ModelRegistry, breaker: CircuitBreaker, opts: RouterOptions) {
    this.registry = registry;
    this.breaker = breaker;
    this.o = opts;
  }

  async run<T>(
    task: Task,
    fn: (model: ModelSpec, ctx: { dataCollection: 'allow' | 'deny' }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<RouteResult<T>> {
    const chain = this.registry.chain(task);
    const attempts: { model: string; error: string }[] = [];
    let skippedForQuota = false;
    let tried = 0;
    let candidates = chain.models.filter((m) => !this.breaker.isOpen(m.id));
    // 모두 차단되어 있으면 서킷을 무시하고 첫 모델이라도 시도하는 편이 낫다
    if (!candidates.length && chain.models.length) candidates = chain.models.slice(0, 1);
    if (!candidates.length) throw new RouteError('no_model', attempts);

    for (const model of candidates) {
      if (tried >= this.o.maxAttempts) break;
      if (signal?.aborted) throw new RouteError('aborted', attempts);
      try {
        const value = await fn(model, { dataCollection: chain.dataCollection });
        this.breaker.record(model.id, true);
        return { value, model, attempts: tried + 1, fellBack: model !== chain.models[0] || tried > 0 };
      } catch (err) {
        if (err instanceof Throttled) throw new RouteError('throttled', attempts);
        if (err instanceof ModelSkipped) {
          skippedForQuota = true;
          attempts.push({ model: model.id, error: err.message });
          continue;
        }
        tried++;
        const e = err as Error;
        if (e instanceof LlmError && e.kind === 'aborted') throw new RouteError('aborted', attempts);
        this.breaker.record(model.id, false);
        attempts.push({ model: model.id, error: e instanceof LlmError ? e.kind : e.message });
      }
    }
    throw new RouteError(skippedForQuota && tried === 0 ? 'quota_exhausted' : 'all_failed', attempts);
  }
}
