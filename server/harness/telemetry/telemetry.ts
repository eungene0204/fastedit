import { createHash } from 'node:crypto';
import type { FeedbackEvent } from '../../../shared/harness.ts';
import type { KvStore } from '../store/kv.ts';

/** 요청 하나의 관측 기록. 사용자 원문은 담지 않고 길이와 해시만 담는다 */
export interface RequestRecord {
  requestId: string;
  kind: 'suggest' | 'alternatives';
  task: string;
  priority: string;
  textLen: number;
  textHash: string;
  languages: string[];
  promptVersions: string[];
  models: string[];
  modelCalls: number;
  fallbacks: number;
  cacheHitSentences: number;
  cacheMissSentences: number;
  tokens: { prompt: number; completion: number; total: number };
  firstResultMs: number | null;
  totalMs: number;
  dropped: Record<string, number>;
  degraded: boolean;
  reason?: string;
}

const MAX_SAMPLES = 2000;

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export class Telemetry {
  private counters = new Map<string, number>();
  private series = new Map<string, number[]>();
  private accept = new Map<string, { accepted: number; rejected: number }>();
  private emit: (line: string) => void;
  private kv?: KvStore;

  constructor(opts: { log?: (line: string) => void; kv?: KvStore } = {}) {
    this.emit = opts.log ?? ((l) => console.log(l));
    this.kv = opts.kv;
  }

  /** 원문 대신 남기는 참조: 길이와 해시 앞 12자리 */
  static textRef(text: string): { len: number; hash: string } {
    return { len: text.length, hash: createHash('sha256').update(text).digest('hex').slice(0, 12) };
  }

  count(name: string, by = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, value: number) {
    const list = this.series.get(name) ?? [];
    list.push(value);
    if (list.length > MAX_SAMPLES) list.shift();
    this.series.set(name, list);
  }

  record(r: RequestRecord) {
    this.count(`requests.${r.kind}`);
    this.count('model_calls', r.modelCalls);
    this.count('fallbacks', r.fallbacks);
    this.count('cache.hit_sentences', r.cacheHitSentences);
    this.count('cache.miss_sentences', r.cacheMissSentences);
    this.count('tokens.total', r.tokens.total);
    if (r.degraded) this.count(`degraded.${r.reason ?? 'unknown'}`);
    for (const [reason, n] of Object.entries(r.dropped)) this.count(`dropped.${reason}`, n);
    this.observe(`latency.total.${r.kind}`, r.totalMs);
    if (r.firstResultMs !== null) this.observe(`latency.first.${r.kind}`, r.firstResultMs);
    this.emit(JSON.stringify({ evt: 'harness.request', ...r }));
  }

  /** 모델 호출 한 번의 결과 */
  modelCall(model: string, ok: boolean, latencyMs: number) {
    this.count(`model.${model}.${ok ? 'ok' : 'fail'}`);
    if (ok) this.observe(`latency.model.${model}`, latencyMs);
  }

  feedback(ev: FeedbackEvent) {
    const key = `${ev.model}|${ev.promptVersion}`;
    const cur = this.accept.get(key) ?? { accepted: 0, rejected: 0 };
    if (ev.action === 'accept') cur.accepted++;
    else cur.rejected++;
    this.accept.set(key, cur);
    void this.kv?.incr(`fastedit:fb:${key}:${ev.action}`, 90 * 86_400).catch(() => {});
    this.emit(JSON.stringify({ evt: 'harness.feedback', action: ev.action, model: ev.model, promptVersion: ev.promptVersion }));
  }

  /** 모델·프롬프트 버전별 수락률 */
  acceptance() {
    return [...this.accept].map(([key, v]) => {
      const [model, promptVersion] = key.split('|');
      const total = v.accepted + v.rejected;
      return { model, promptVersion, ...v, acceptRate: total ? v.accepted / total : 0 };
    });
  }

  snapshot() {
    const latency: Record<string, { count: number; avg: number; p50: number; p95: number }> = {};
    for (const [name, values] of this.series) {
      latency[name] = {
        count: values.length,
        avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
        p50: percentile(values, 50),
        p95: percentile(values, 95),
      };
    }
    return { counters: Object.fromEntries(this.counters), latency, acceptance: this.acceptance() };
  }
}
