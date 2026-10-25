// 평가 하네스: npm run eval -- --task polish --model <id>[,<id>...]
//   --task   spell | polish | tone (필수)
//   --model  OpenRouter 모델 ID. 쉼표로 여러 개 (필수). config/models.yaml에 없는 ID도 쓸 수 있다
//   --rpm    분당 최대 요청 수 (기본 15; 무료 모델 한도 20/분보다 낮게)
//   --max-calls  모델 하나당 보낼 최대 요청 수 (기본 80; 무료 일일 한도 보호)
//   --retries    호출 실패(빈 응답·시간 초과 등) 시 같은 모델로 다시 시도하는 횟수 (기본 1)
//   --dataset    평가셋 파일/디렉터리 (기본 eval/datasets/<task>.*.jsonl)
//   --out    보고서 디렉터리 (기본 eval/reports)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { EncryptedCache } from '../server/harness/cache/cache.ts';
import { LlmError, OpenRouterClient, type LlmClient, type LlmRequest, type LlmResult } from '../server/harness/client/openrouter-client.ts';
import { loadConfig } from '../server/harness/config.ts';
import { Harness } from '../server/harness/harness.ts';
import { PromptBuilder } from '../server/harness/prompts/builder.ts';
import { ModelRegistry } from '../server/harness/registry/registry.ts';
import { CircuitBreaker, Router } from '../server/harness/router/router.ts';
import { MemoryKv } from '../server/harness/store/kv.ts';
import { Telemetry } from '../server/harness/telemetry/telemetry.ts';
import type { ModelSpec } from '../server/harness/types.ts';
import { ratio, scoreLine, scoreTone, violatingSuggestions, type DatasetRow } from './score.ts';

type Task = 'spell' | 'polish' | 'tone';

const { values: args } = parseArgs({
  options: {
    task: { type: 'string' },
    model: { type: 'string' },
    rpm: { type: 'string', default: '15' },
    'max-calls': { type: 'string', default: '80' },
    retries: { type: 'string', default: '1' },
    dataset: { type: 'string' },
    out: { type: 'string', default: 'eval/reports' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help || !args.task || !args.model || !['spell', 'polish', 'tone'].includes(args.task)) {
  console.error('사용법: npm run eval -- --task <spell|polish|tone> --model <id>[,<id>...] [--rpm 15] [--max-calls 60] [--dataset 경로] [--out eval/reports]');
  process.exit(args.help ? 0 : 2);
}
const task = args.task as Task;
const rpm = Number(args.rpm);
const maxCalls = Number(args['max-calls']);
const retries = Number(args.retries);
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY가 필요합니다 (.env 또는 환경 변수).');
  process.exit(2);
}

/** 요청 간격을 벌려 분당 호출 수를 rpm 이하로 유지하고, 총 호출 수를 제한한다 */
class PacedClient implements LlmClient {
  calls = 0;
  private next = 0;
  private inner: LlmClient;
  constructor(inner: LlmClient) {
    this.inner = inner;
  }
  private async pace() {
    if (this.calls >= maxCalls) throw new LlmError('client', `--max-calls(${maxCalls}) 초과`);
    this.calls++;
    const gap = 60_000 / rpm;
    const wait = Math.max(0, this.next - Date.now());
    this.next = Math.max(Date.now(), this.next) + gap;
    if (wait) await new Promise((r) => setTimeout(r, wait));
  }
  async complete(req: LlmRequest): Promise<LlmResult> {
    await this.pace();
    return this.inner.complete(req);
  }
  async *stream(req: LlmRequest): AsyncGenerator<string, LlmResult> {
    await this.pace();
    return yield* this.inner.stream(req);
  }
}

function loadRows(): { file: string; lang: string; rows: DatasetRow[] }[] {
  const target = args.dataset ?? 'eval/datasets';
  const files = target.endsWith('.jsonl')
    ? [target]
    : readdirSync(target).filter((f) => f.startsWith(`${task}.`) && f.endsWith('.jsonl')).map((f) => join(target, f));
  if (!files.length) throw new Error(`${task} 평가셋이 없습니다: ${target}`);
  return files.map((file) => ({
    file,
    lang: basename(file).split('.')[1] ?? 'ko',
    rows: readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as DatasetRow),
  }));
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9.-]+/g, '_');

async function evalModel(modelId: string) {
  const base = loadConfig();
  const spec: ModelSpec = base.models.find((m) => m.id === modelId) ?? {
    id: modelId,
    tier: modelId.endsWith(':free') ? 'free' : 'paid',
    tasks: ['spell', 'polish', 'tone'],
    supportsJsonMode: true,
    supportsStreaming: true,
    contextLength: 128_000,
    maxOutputTokens: 4096,
    dataPolicy: 'unknown',
    priority: 1,
    enabled: true,
  };
  // 평가는 이 모델 하나만 쓴다 (대체 없음). 한도는 PacedClient가 지킨다
  const config = {
    ...base,
    models: [{ ...spec, enabled: true, tasks: ['spell', 'polish', 'tone'] as Task[] }],
    // 같은 모델을 체인에 반복해 넣어 재시도를 흉내 낸다 (빈 응답이 잦은 무료 호스트 대비)
    chains: { [task]: Array(retries + 1).fill(modelId) as string[] },
    dataCollection: 'allow' as const,
    allowPaidFallback: true,
    limits: { perMinute: 1_000_000, perDay: 1_000_000, softRatio: 1 },
  };
  const kv = new MemoryKv();
  const registry = new ModelRegistry(config);
  const telemetry = new Telemetry({ log: () => {} });
  const client = new PacedClient(new OpenRouterClient({ apiKey: apiKey!, ...config.client }));
  const prompts = new PromptBuilder();
  const harness = new Harness({
    config,
    registry,
    router: new Router(registry, new CircuitBreaker({ ...config.router, minSamples: 1_000_000 }), { maxAttempts: retries + 1 }),
    client,
    governor: { acquire: async () => 'ok', usage: async () => ({ minute: 0, day: 0, perMinute: 0, perDay: 0, ratio: 0 }) },
    cache: new EncryptedCache(kv, { ttlSec: 60, secret: 'eval', warn: () => {} }),
    telemetry,
    prompts,
    enabled: true,
  });

  const sets = loadRows();
  const totals = { expected: 0, matched: 0, produced: 0, correct: 0, violations: 0, lines: 0, degradedLines: 0, validAltLines: 0, alternatives: 0 };
  const byLang: Record<string, { expected: number; matched: number; produced: number; correct: number }> = {};
  const dropped: Record<string, number> = {};
  const failures: string[] = [];
  const promptVersions = new Set<string>();
  let modelCalls = 0;
  const started = Date.now();

  for (const set of sets) {
    const lang = (byLang[set.lang] ??= { expected: 0, matched: 0, produced: 0, correct: 0 });
    if (task === 'tone') {
      for (const row of set.rows) {
        const res = await harness.alternatives({ text: row.input, tone: row.tone ?? 'polite', n: 3, priority: 'user' });
        modelCalls += res.meta.modelCalls;
        promptVersions.add(res.promptVersion);
        totals.lines++;
        if (res.meta.degraded) totals.degradedLines++;
        const s = scoreTone(row, res.alternatives);
        totals.alternatives += s.alternatives;
        totals.violations += s.violations;
        if (s.alternatives > 0) totals.validAltLines++;
        else failures.push(`[tone] 유효한 대안 없음 (${res.meta.reason ?? '검증 탈락'}): ${row.input.slice(0, 40)}`);
      }
      continue;
    }
    // 줄바꿈으로 이은 한 문서로 보내고, 제안을 줄별로 나눠 채점한다 (배치 크기는 하네스 설정을 따른다)
    const lineStarts: number[] = [];
    let text = '';
    for (const row of set.rows) {
      lineStarts.push(text.length);
      text += row.input + '\n';
    }
    const res = await harness.suggest({ docVersion: 1, text, task: task as 'spell' | 'polish', strength: 'normal', language: set.lang === 'en' ? 'en' : 'ko', priority: 'user' });
    modelCalls += res.meta.modelCalls;
    for (const s of res.suggestions) promptVersions.add(s.promptVersion);
    if (res.meta.degraded) failures.push(`[${set.lang}] 일부/전체 배치 실패: ${res.meta.reason}`);
    set.rows.forEach((row, i) => {
      const from = lineStarts[i];
      const to = from + row.input.length;
      const rel = res.suggestions.filter((s) => s.start >= from && s.end <= to).map((s) => ({ ...s, start: s.start - from, end: s.end - from }));
      const sc = scoreLine(row, rel);
      for (const v of violatingSuggestions(row, rel)) failures.push(`금지 변경 위반: "${v.original}" → "${v.replacement}" (${row.input.slice(0, 30)})`);
      if (sc.matched < sc.expected) failures.push(`놓친 수정: ${row.expected.map((e) => `${e.original}→${e.replacement}`).join(', ')} / 제안: ${rel.map((s) => `${s.original}→${s.replacement}`).join(', ') || '없음'}`);
      for (const k of ['expected', 'matched', 'produced', 'correct', 'violations'] as const) totals[k] += sc[k];
      for (const k of ['expected', 'matched', 'produced', 'correct'] as const) lang[k] += sc[k];
      totals.lines++;
    });
  }
  promptVersions.add(prompts.version(task, 'ko'));

  const snap = telemetry.snapshot();
  for (const [k, v] of Object.entries(snap.counters)) if (k.startsWith('dropped.')) dropped[k.slice(8)] = v;
  const okCalls = snap.counters[`model.${modelId}.ok`] ?? 0;
  const failCalls = snap.counters[`model.${modelId}.fail`] ?? 0;
  const parseFailures = snap.counters.parse_failures ?? 0;
  for (const [k, v] of Object.entries(snap.counters)) if (k.startsWith('model_errors.')) failures.push(`모델 호출 실패 ${k.slice(13)}: ${v}회`);
  const lat = snap.latency[`latency.model.${modelId}`];
  const metrics = {
    recall: task === 'tone' ? null : ratio(totals.matched, totals.expected),
    precision: task === 'tone' ? null : ratio(totals.correct, totals.produced),
    mustNotChangeViolations: totals.violations,
    jsonParseFailureRate: ratio(parseFailures, okCalls + failCalls),
    callFailureRate: ratio(failCalls, okCalls + failCalls),
    avgLatencyMs: lat?.avg ?? null,
    p95LatencyMs: lat?.p95 ?? null,
    ...(task === 'tone' ? { linesWithValidAlternative: ratio(totals.validAltLines, totals.lines), avgAlternatives: ratio(totals.alternatives, totals.lines) } : {}),
  };
  const report = {
    date: new Date().toISOString(),
    task,
    model: modelId,
    tier: spec.tier,
    dataPolicy: spec.dataPolicy,
    promptVersions: [...promptVersions].sort(),
    datasets: sets.map((s) => ({ file: s.file, rows: s.rows.length })),
    modelCalls,
    elapsedMs: Date.now() - started,
    metrics,
    counts: totals,
    byLanguage: byLang,
    validatorDropped: dropped,
    notes: failures,
  };
  return report;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`);
const ms = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${Math.round(v)}ms`);

function markdown(r: Awaited<ReturnType<typeof evalModel>>): string {
  const m = r.metrics;
  return [
    `# ${r.task} · ${r.model} · ${r.promptVersions.join(', ')}`,
    '',
    `- 날짜: ${r.date}  |  평가셋: ${r.datasets.map((d) => `${d.file} (${d.rows}문장)`).join(', ')}  |  모델 호출: ${r.modelCalls}회, ${(r.elapsedMs / 1000).toFixed(0)}초`,
    `- 모델 정책: tier=${r.tier}, dataPolicy=${r.dataPolicy}`,
    '',
    '| 지표 | 값 |',
    '|---|---|',
    ...(r.task === 'tone'
      ? [`| 유효 대안이 나온 문장 비율 | ${pct((m as { linesWithValidAlternative?: number }).linesWithValidAlternative)} |`]
      : [`| 정답 제안 재현율 | ${pct(m.recall)} (${r.counts.matched}/${r.counts.expected}) |`, `| 정밀도 | ${pct(m.precision)} (${r.counts.correct}/${r.counts.produced}) |`]),
    `| 금지 변경 위반 | ${m.mustNotChangeViolations} |`,
    `| JSON 파싱 실패율 | ${pct(m.jsonParseFailureRate)} |`,
    `| 호출 실패율 | ${pct(m.callFailureRate)} |`,
    `| 지연 평균 / p95 | ${ms(m.avgLatencyMs)} / ${ms(m.p95LatencyMs)} |`,
    '',
    `검증기가 버린 제안: ${Object.entries(r.validatorDropped).map(([k, v]) => `${k}=${v}`).join(', ') || '없음'}`,
    ...(r.notes.length ? ['', '메모:', ...r.notes.map((n) => `- ${n}`)] : []),
    '',
  ].join('\n');
}

const day = new Date().toISOString().slice(0, 10);
const dir = join(args.out!, day);
mkdirSync(dir, { recursive: true });
const rows: Awaited<ReturnType<typeof evalModel>>[] = [];
for (const id of args.model.split(',').map((s) => s.trim()).filter(Boolean)) {
  console.error(`\n▶ ${task} / ${id} (분당 ${rpm}회 이하)`);
  const r = await evalModel(id);
  rows.push(r);
  const stem = `${r.task}__${slug(r.model)}__${r.promptVersions.join('+').replace('@', '-')}`;
  writeFileSync(join(dir, `${stem}.json`), JSON.stringify(r, null, 2));
  writeFileSync(join(dir, `${stem}.md`), markdown(r));
  console.log(markdown(r));
}

if (rows.length > 1) {
  const head = task === 'tone' ? '| 모델 | 유효 대안 | 위반 | 파싱 실패 | 지연 avg/p95 |' : '| 모델 | 재현율 | 정밀도 | 위반 | 파싱 실패 | 지연 avg/p95 |';
  const lines = rows.map((r) => {
    const m = r.metrics;
    return task === 'tone'
      ? `| ${r.model} | ${pct((m as { linesWithValidAlternative?: number }).linesWithValidAlternative)} | ${m.mustNotChangeViolations} | ${pct(m.jsonParseFailureRate)} | ${ms(m.avgLatencyMs)} / ${ms(m.p95LatencyMs)} |`
      : `| ${r.model} | ${pct(m.recall)} | ${pct(m.precision)} | ${m.mustNotChangeViolations} | ${pct(m.jsonParseFailureRate)} | ${ms(m.avgLatencyMs)} / ${ms(m.p95LatencyMs)} |`;
  });
  const sep = head.replace(/[^|]/g, '-');
  const summary = [`# ${task} 비교 (${day})`, '', head, sep, ...lines, ''].join('\n');
  writeFileSync(join(dir, `compare-${task}.md`), summary);
  console.log(summary);
}
