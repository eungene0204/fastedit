import type { HarnessConfig } from '../config.ts';
import type { ModelSpec, Task } from '../types.ts';

export interface RegistryDeps {
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  baseUrl?: string;
}

export interface Chain {
  models: ModelSpec[];
  /** 요청의 provider.data_collection 값 */
  dataCollection: 'allow' | 'deny';
  /** onNoEligible=relax로 정책을 낮췄는지 */
  relaxed: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class ModelRegistry {
  private cfg: HarnessConfig;
  private models: ModelSpec[];
  private missing = new Set<string>();
  private fetchFn: typeof fetch;
  private warn: (msg: string) => void;
  private baseUrl: string;

  constructor(cfg: HarnessConfig, deps: RegistryDeps = {}) {
    this.cfg = cfg;
    this.models = cfg.models.map((m) => ({ ...m }));
    this.fetchFn = deps.fetch ?? fetch;
    this.warn = deps.log ?? ((m) => console.warn(`[registry] ${m}`));
    this.baseUrl = deps.baseUrl ?? 'https://openrouter.ai/api/v1';
  }

  all(): ModelSpec[] {
    return this.models;
  }

  get(id: string): ModelSpec | undefined {
    return this.models.find((m) => m.id === id);
  }

  isActive(m: ModelSpec): boolean {
    return m.enabled && !this.missing.has(m.id);
  }

  /** 현재 쓸 수 있는 모든 모델 ID (상태 표시용) */
  activeIds(): string[] {
    return this.models.filter((m) => this.isActive(m)).map((m) => m.id);
  }

  /** 작업의 대체 체인: 비활성·정책 불일치·허용되지 않은 유료 모델을 뺀 순서 */
  chain(task: Task): Chain {
    const base = this.cfg.chains[task]
      ? this.cfg.chains[task]!.map((id) => this.get(id)).filter((m): m is ModelSpec => Boolean(m))
      : [...this.models].filter((m) => m.tasks.includes(task)).sort((a, b) => a.priority - b.priority);
    const usable = base.filter((m) => this.isActive(m) && m.tasks.includes(task) && (m.tier === 'free' || this.cfg.allowPaidFallback));
    if (this.cfg.dataCollection === 'allow') return { models: usable, dataCollection: 'allow', relaxed: false };

    const strict = usable.filter((m) => m.dataPolicy === 'no-train');
    if (strict.length || !usable.length || this.cfg.onNoEligible === 'degrade') {
      return { models: strict, dataCollection: 'deny', relaxed: false };
    }
    return { models: usable, dataCollection: 'allow', relaxed: true };
  }

  /** OpenRouter 모델 목록과 대조해 사라진 모델을 비활성화하고, 돌아온 모델은 다시 켠다 */
  async refresh(): Promise<void> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = (await res.json()) as { data: { id: string }[] };
      const ids = new Set(data.map((m) => m.id));
      for (const m of this.models) {
        const gone = !ids.has(m.id);
        if (gone && !this.missing.has(m.id)) this.warn(`OpenRouter 목록에서 사라진 모델을 비활성화합니다: ${m.id}`);
        if (!gone && this.missing.has(m.id)) this.warn(`모델이 다시 나타나 활성화합니다: ${m.id}`);
        if (gone) this.missing.add(m.id);
        else this.missing.delete(m.id);
      }
    } catch (err) {
      this.warn(`모델 목록 조회 실패, 이전 상태를 유지합니다: ${(err as Error).message}`);
    }
  }

  /** 하루에 한 번 refresh. 반환값을 호출하면 멈춘다 */
  startDaily(): () => void {
    const timer = setInterval(() => void this.refresh(), DAY_MS);
    timer.unref();
    return () => clearInterval(timer);
  }
}
