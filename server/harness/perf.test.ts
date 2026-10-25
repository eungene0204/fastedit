import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildTestHarness } from './testing/harness-factory.ts';
import { MockOpenRouter } from './testing/mock-openrouter.ts';
import { percentile } from './telemetry/telemetry.ts';

// 지연 목표 측정 (목 서버 기준)
//  - 모델 호출: 목 서버가 MODEL_LATENCY_MS(기본 400ms)만큼 걸려 응답하는 상황에서 "첫 제안까지" 걸린 시간의 p95 ≤ 3초
//  - 캐시 적중: 같은 요청을 다시 보냈을 때 응답 시간의 p95 ≤ 100ms
// 측정 방법: 서로 다른 문서 N개를 순서대로 보내 첫 제안 이벤트가 나오기까지(스트리밍)를 재고,
// 같은 문서를 다시 보내 전체 응답 시간을 잰다.

const MODEL_LATENCY_MS = Number(process.env.MODEL_LATENCY_MS ?? 400);
const N = 40;
const mock = new MockOpenRouter();
let base = '';
before(async () => void (base = await mock.start()));
after(() => mock.stop());

test(`지연 목표: 첫 제안 p95 ≤ 3초, 캐시 적중 p95 ≤ 100ms (모델 지연 ${MODEL_LATENCY_MS}ms)`, async () => {
  const { harness } = buildTestHarness(base);
  mock.handler = () => ({
    delayMs: MODEL_LATENCY_MS,
    content: JSON.stringify({ suggestions: [{ sentence: 1, original: '되요', occurrence: 1, replacement: '돼요', category: 'spelling', reason: 'r', confidence: 0.9 }] }),
  });
  const docs = Array.from({ length: N }, (_, i) => `문서 ${i}번은 안 되요. 두 번째 문장이다. 세 번째 문장이다.`);

  const first: number[] = [];
  for (const text of docs) {
    const t = performance.now();
    for await (const ev of harness.suggestStream({ docVersion: 1, text, task: 'polish' })) {
      if (ev.kind === 'suggestions' && ev.suggestions.length) {
        first.push(performance.now() - t);
        break;
      }
    }
  }
  const hit: number[] = [];
  for (const text of docs) {
    const t = performance.now();
    const res = await harness.suggest({ docVersion: 1, text, task: 'polish' });
    hit.push(performance.now() - t);
    assert.equal(res.meta.modelCalls, 0);
    assert.equal(res.meta.cached, 3);
  }
  const p95First = percentile(first, 95);
  const p95Hit = percentile(hit, 95);
  console.log(`[perf] 첫 제안 p50=${percentile(first, 50).toFixed(0)}ms p95=${p95First.toFixed(0)}ms | 캐시 적중 p50=${percentile(hit, 50).toFixed(1)}ms p95=${p95Hit.toFixed(1)}ms`);
  assert.ok(p95First <= 3000, `첫 제안 p95 ${p95First}ms`);
  assert.ok(p95Hit <= 100, `캐시 적중 p95 ${p95Hit}ms`);
});
