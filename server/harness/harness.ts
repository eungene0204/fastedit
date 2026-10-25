import { createHash, randomUUID } from 'node:crypto';
import type {
  AlternativesRequest,
  AlternativesResponse,
  DegradedReason,
  HarnessMeta,
  HarnessSuggestion,
  SuggestEvent,
  SuggestRequest,
  SuggestResponse,
} from '../../shared/harness.ts';
import { assemble, toSuggestion, type Provenance } from './assembler/assembler.ts';
import type { Cache } from './cache/cache.ts';
import { collectStream, LlmError, type LlmClient, type LlmResult } from './client/openrouter-client.ts';
import type { HarnessConfig } from './config.ts';
import type { RateGovernor } from './governor/rate-governor.ts';
import { makeBatches } from './preprocess/batch.ts';
import { detectLanguage, hasLetters } from './preprocess/lang.ts';
import { maskPii, unmaskPii, type Masked } from './preprocess/pii.ts';
import { splitSentences } from './preprocess/sentences.ts';
import type { PromptBuilder } from './prompts/builder.ts';
import type { ModelRegistry } from './registry/registry.ts';
import { ModelSkipped, RouteError, Throttled, type Router } from './router/router.ts';
import { Telemetry, type RequestRecord } from './telemetry/telemetry.ts';
import type { ChatMessage, SentenceRef, Task } from './types.ts';
import { extractItems } from './validator/json.ts';
import { validateAlternatives } from './validator/tone.ts';
import { validateBatch, type RelativeSuggestion } from './validator/validate.ts';

/** 검증기 규칙이 바뀌면 올려서 이전 캐시 결과를 무효화한다 */
const VALIDATOR_VERSION = 'v1';

export interface HarnessDeps {
  config: HarnessConfig;
  registry: ModelRegistry;
  router: Router;
  client: LlmClient;
  governor: RateGovernor;
  cache: Cache;
  telemetry: Telemetry;
  prompts: PromptBuilder;
  /** API 키가 없으면 false: 모델을 호출하지 않고 degraded 응답을 돌려준다 */
  enabled: boolean;
}

interface CachedSentence {
  suggestions: (RelativeSuggestion & Provenance)[];
}

interface CallStats {
  modelCalls: number;
  fallbacks: number;
  models: Set<string>;
  tokens: { prompt: number; completion: number; total: number };
  dropped: Record<string, number>;
  promptVersions: Set<string>;
}

const newStats = (): CallStats => ({
  modelCalls: 0,
  fallbacks: 0,
  models: new Set(),
  tokens: { prompt: 0, completion: 0, total: 0 },
  dropped: {},
  promptVersions: new Set(),
});

const FAIL_REASON: Record<string, DegradedReason> = {
  throttled: 'throttled',
  quota_exhausted: 'quota_exhausted',
  no_model: 'no_model',
  all_failed: 'all_failed',
  aborted: 'all_failed',
};

const dictHash = (d: string[]) => createHash('sha1').update(JSON.stringify([...d].sort())).digest('hex').slice(0, 10);

export class Harness {
  private d: HarnessDeps;
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(deps: HarnessDeps) {
    this.d = deps;
  }

  get enabled() {
    return this.d.enabled;
  }

  // ───────────────────────── 모델 호출 (라우터 + 한도 관리자) ─────────────────────────

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.d.config.batch.concurrency) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  /** 체인의 모델을 순서대로 시도한다. 호출 → JSON 항목 추출까지 성공해야 그 모델의 성공으로 친다 */
  private async callModels(args: {
    task: Task;
    messages: ChatMessage[];
    key: 'suggestions' | 'alternatives';
    priority: 'user' | 'auto';
    temperature: number;
    stats: CallStats;
    signal?: AbortSignal;
  }): Promise<{ items: unknown[]; res: LlmResult }> {
    const { task, stats } = args;
    const routed = await this.d.router.run(
      task,
      async (model, ctx) => {
        const decision = await this.d.governor.acquire(args.priority, model.tier);
        if (decision === 'deny_low_priority') throw new Throttled();
        if (decision === 'exhausted') throw new ModelSkipped('quota');
        stats.modelCalls++;
        const req = { model, messages: args.messages, temperature: args.temperature, dataCollection: ctx.dataCollection, signal: args.signal };
        try {
          const res = model.supportsStreaming ? await collectStream(this.d.client.stream(req)) : await this.d.client.complete(req);
          const items = extractItems(res.content, args.key);
          if (!items) throw new LlmError('parse', `${model.id}: JSON을 복구하지 못했습니다`);
          this.d.telemetry.modelCall(model.id, true, res.latencyMs);
          return { items, res };
        } catch (err) {
          this.d.telemetry.modelCall(model.id, false, 0);
          if (err instanceof LlmError) this.d.telemetry.count(`model_errors.${err.kind}`);
          if (err instanceof LlmError && err.kind === 'parse') this.d.telemetry.count('parse_failures');
          throw err;
        }
      },
      args.signal,
    );
    if (routed.fellBack) stats.fallbacks++;
    const { items, res } = routed.value;
    stats.models.add(res.model);
    stats.tokens.prompt += res.usage.promptTokens;
    stats.tokens.completion += res.usage.completionTokens;
    stats.tokens.total += res.usage.totalTokens;
    return { items, res };
  }

  // ───────────────────────── 교정·윤문 제안 ─────────────────────────

  async suggest(req: SuggestRequest, signal?: AbortSignal): Promise<SuggestResponse> {
    const all: HarnessSuggestion[] = [];
    for await (const ev of this.suggestStream(req, signal)) {
      if (ev.kind === 'suggestions') all.push(...ev.suggestions);
      else return ev.response;
    }
    throw new Error('unreachable');
  }

  /** 캐시 적중분을 먼저, 이어서 배치 검증이 끝나는 순서대로 내보낸다 */
  async *suggestStream(req: SuggestRequest, signal?: AbortSignal): AsyncGenerator<SuggestEvent> {
    const started = Date.now();
    const requestId = req.requestId ?? randomUUID();
    const task = req.task;
    const strength = req.strength ?? 'normal';
    const priority = req.priority ?? 'user';
    const dictionary = req.dictionary ?? [];
    const { config, cache } = this.d;
    const stats = newStats();
    const all: HarnessSuggestion[] = [];
    let firstResultMs: number | null = null;
    let cachedSentences = 0;
    let missSentences = 0;
    let degradedReason: DegradedReason | undefined;
    const languages = new Set<string>();

    const sentences: SentenceRef[] = splitSentences(req.text)
      .filter((s) => hasLetters(s.text))
      .map((s, index) => ({
        index,
        start: s.start,
        end: s.end,
        text: s.text,
        lang: req.language && req.language !== 'auto' ? req.language : detectLanguage(s.text),
      }));
    for (const s of sentences) languages.add(s.lang);

    // 1) 캐시 조회: 같은 문장·작업·프롬프트 버전·설정이면 모델을 부르지 않는다
    const lookups = await Promise.all(
      sentences.map(async (s) => {
        const pv = this.d.prompts.version(task, s.lang);
        const key = cache.key([VALIDATOR_VERSION, task, pv, strength, s.lang, dictHash(dictionary), s.text]);
        return { s, pv, key, hit: await cache.get<CachedSentence>(key) };
      }),
    );
    const cachedOut: HarnessSuggestion[] = [];
    const misses: typeof lookups = [];
    for (const l of lookups) {
      if (!l.hit) {
        misses.push(l);
        continue;
      }
      cachedSentences++;
      for (const c of l.hit.suggestions) cachedOut.push(toSuggestion(requestId, l.s.start, c, c));
    }
    missSentences = misses.length;
    stats.promptVersions = new Set(lookups.map((l) => l.pv));
    if (cachedSentences) {
      firstResultMs = Date.now() - started;
      all.push(...cachedOut);
      yield { kind: 'suggestions', requestId, docVersion: req.docVersion, suggestions: cachedOut, cached: true };
    }

    // 2) 캐시에 없는 문장만 마스킹해서 배치로 묶어 보낸다
    if (misses.length && !this.d.enabled) degradedReason = 'llm_disabled';
    else if (misses.length) {
      const counter = { n: 0 };
      const items = misses.map((m) => ({ ...m, text: m.s.text, lang: m.s.lang, masked: maskPii(m.s.text, counter) }));
      const batches = makeBatches(items, config.batch);
      const pending = new Map<number, Promise<{ id: number; out: HarnessSuggestion[] | null; reason?: DegradedReason }>>();

      batches.forEach((batch, id) => {
        pending.set(
          id,
          this.slot(() => this.runSuggestBatch({ id, batch, task, strength, priority, dictionary, stats, requestId, signal })),
        );
      });
      while (pending.size) {
        const done = await Promise.race(pending.values());
        pending.delete(done.id);
        if (done.out === null) {
          degradedReason ??= done.reason ?? 'all_failed';
          continue;
        }
        firstResultMs ??= Date.now() - started;
        all.push(...done.out);
        yield { kind: 'suggestions', requestId, docVersion: req.docVersion, suggestions: done.out, cached: false };
      }
    }

    const meta: HarnessMeta = {
      cached: cachedSentences,
      modelCalls: stats.modelCalls,
      latencyMs: Date.now() - started,
      degraded: degradedReason !== undefined,
      ...(degradedReason ? { reason: degradedReason } : {}),
    };
    this.record({
      requestId,
      kind: 'suggest',
      task,
      priority,
      text: req.text,
      languages,
      stats,
      cachedSentences,
      missSentences,
      firstResultMs,
      totalMs: meta.latencyMs,
      degradedReason,
    });
    yield { kind: 'done', response: assemble({ requestId, docVersion: req.docVersion, suggestions: all, meta }) };
  }

  private async runSuggestBatch(a: {
    id: number;
    batch: { s: SentenceRef; pv: string; key: string; masked: Masked }[];
    task: 'spell' | 'polish';
    strength: 'light' | 'normal' | 'strong';
    priority: 'user' | 'auto';
    dictionary: string[];
    stats: CallStats;
    requestId: string;
    signal?: AbortSignal;
  }): Promise<{ id: number; out: HarnessSuggestion[] | null; reason?: DegradedReason }> {
    const { batch, stats } = a;
    const lang = batch[0].s.lang;
    const prompt = this.d.prompts.build({
      task: a.task,
      lang,
      strength: a.strength,
      sentences: batch.map((b) => b.masked.text),
    });
    try {
      const { items, res } = await this.callModels({
        task: a.task,
        messages: prompt.messages,
        key: 'suggestions',
        priority: a.priority,
        temperature: 0,
        stats,
        signal: a.signal,
      });
      stats.promptVersions.add(prompt.version);
      const result = validateBatch(
        items,
        batch.map((b) => ({ ref: b.s, masked: b.masked })),
        { task: a.task, strength: a.strength, dictionary: a.dictionary, minConfidence: this.d.config.validator.minConfidence },
      );
      for (const [reason, n] of Object.entries(result.dropped)) stats.dropped[reason] = (stats.dropped[reason] ?? 0) + n;

      const prov: Provenance = { model: res.model, promptVersion: prompt.version };
      const out: HarnessSuggestion[] = [];
      await Promise.all(
        batch.map(async (b, i) => {
          const rel = result.bySentence.get(i) ?? [];
          for (const r of rel) out.push(toSuggestion(a.requestId, b.s.start, r, prov));
          // 제안이 없다는 결과도 캐시한다
          const key = this.d.cache.key([VALIDATOR_VERSION, a.task, prompt.version, a.strength, b.s.lang, dictHash(a.dictionary), b.s.text]);
          await this.d.cache.set<CachedSentence>(key, { suggestions: rel.map((r) => ({ ...r, ...prov })) });
        }),
      );
      return { id: a.id, out };
    } catch (err) {
      if (err instanceof RouteError) return { id: a.id, out: null, reason: FAIL_REASON[err.kind] };
      throw err;
    }
  }

  // ───────────────────────── 톤 변환 대안 ─────────────────────────

  async alternatives(req: AlternativesRequest, signal?: AbortSignal): Promise<AlternativesResponse> {
    const started = Date.now();
    const requestId = req.requestId ?? randomUUID();
    const priority = req.priority ?? 'user';
    const n = Math.min(5, Math.max(1, req.n ?? 3));
    const dictionary = req.dictionary ?? [];
    const lang = req.language && req.language !== 'auto' ? req.language : detectLanguage(req.text);
    const stats = newStats();
    const version = this.d.prompts.version('tone', lang);
    let degradedReason: DegradedReason | undefined;
    let model: string | undefined;
    let alternatives: { text: string; note: string }[] = [];
    let cachedCount = 0;
    const key = this.d.cache.key([VALIDATOR_VERSION, 'tone', version, req.tone, n, lang, dictHash(dictionary), req.text]);

    const hit = hasLetters(req.text) ? await this.d.cache.get<{ alternatives: typeof alternatives; model: string }>(key) : undefined;
    if (hit) {
      alternatives = hit.alternatives;
      model = hit.model;
      cachedCount = 1;
    } else if (!hasLetters(req.text)) {
      // 바꿀 글자가 없다
    } else if (!this.d.enabled) degradedReason = 'llm_disabled';
    else {
      const masked = maskPii(req.text);
      const prompt = this.d.prompts.build({ task: 'tone', lang, tone: req.tone, n, selectedText: masked.text });
      stats.promptVersions.add(prompt.version);
      try {
        const { items, res } = await this.slot(() =>
          this.callModels({ task: 'tone', messages: prompt.messages, key: 'alternatives', priority, temperature: 0.5, stats, signal }),
        );
        const v = validateAlternatives(items, masked.text, dictionary, n);
        for (const [reason, c] of Object.entries(v.dropped)) stats.dropped[reason] = (stats.dropped[reason] ?? 0) + c;
        // 되돌린 뒤에도 자리표시자가 남아 있으면 민감정보 구간을 건드린 것이므로 버린다
        alternatives = v.alternatives
          .map((a) => ({ text: unmaskPii(a.text, masked.tokens), note: a.note }))
          .filter((a) => !/⟦PII_\d+⟧/.test(a.text));
        model = res.model;
        await this.d.cache.set(key, { alternatives, model });
      } catch (err) {
        if (!(err instanceof RouteError)) throw err;
        degradedReason = FAIL_REASON[err.kind];
      }
    }

    const meta: HarnessMeta = {
      cached: cachedCount,
      modelCalls: stats.modelCalls,
      latencyMs: Date.now() - started,
      degraded: degradedReason !== undefined,
      ...(degradedReason ? { reason: degradedReason } : {}),
    };
    this.record({
      requestId,
      kind: 'alternatives',
      task: 'tone',
      priority,
      text: req.text,
      languages: new Set([lang]),
      stats,
      cachedSentences: cachedCount,
      missSentences: cachedCount ? 0 : 1,
      firstResultMs: meta.latencyMs,
      totalMs: meta.latencyMs,
      degradedReason,
    });
    return { requestId, alternatives, model, promptVersion: version, meta };
  }

  // ───────────────────────── 관측 ─────────────────────────

  private record(a: {
    requestId: string;
    kind: RequestRecord['kind'];
    task: string;
    priority: string;
    text: string;
    languages: Set<string>;
    stats: CallStats;
    cachedSentences: number;
    missSentences: number;
    firstResultMs: number | null;
    totalMs: number;
    degradedReason?: DegradedReason;
  }) {
    const ref = Telemetry.textRef(a.text);
    this.d.telemetry.record({
      requestId: a.requestId,
      kind: a.kind,
      task: a.task,
      priority: a.priority,
      textLen: ref.len,
      textHash: ref.hash,
      languages: [...a.languages],
      promptVersions: [...a.stats.promptVersions],
      models: [...a.stats.models],
      modelCalls: a.stats.modelCalls,
      fallbacks: a.stats.fallbacks,
      cacheHitSentences: a.cachedSentences,
      cacheMissSentences: a.missSentences,
      tokens: a.stats.tokens,
      firstResultMs: a.firstResultMs,
      totalMs: a.totalMs,
      dropped: a.stats.dropped,
      degraded: a.degradedReason !== undefined,
      ...(a.degradedReason ? { reason: a.degradedReason } : {}),
    });
  }
}
