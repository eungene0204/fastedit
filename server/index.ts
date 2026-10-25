import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import type { CheckRequest, RewriteRequest, StatusResponse } from '../shared/types.ts';
import { checkBlocks, rewrite } from './check.ts';
import { config } from './config.ts';
import { createHarness } from './harness/index.ts';

const STRENGTHS = ['spell', 'basic', 'aggressive'];
const TONES = ['none', 'polite', 'concise', 'easy', 'formal'];

const bundle = await createHarness();
const { harness, registry, telemetry, governor } = bundle;

const app = new Hono();

app.get('/api/status', (c) => c.json<StatusResponse>({ llm: harness.enabled, models: registry.activeIds() }));

// ───────── 편집기용 API (규칙 즉시 결과 + 하네스 결과 스트림) ─────────

app.post('/api/check', async (c) => {
  const body = (await c.req.json().catch(() => null)) as CheckRequest | null;
  if (!body || !Array.isArray(body.blocks) || !STRENGTHS.includes(body.strength) || !TONES.includes(body.tone)) {
    return c.json({ error: '잘못된 요청입니다' }, 400);
  }
  if (body.blocks.length > config.maxBlocks) return c.json({ error: `문단은 한 번에 ${config.maxBlocks}개까지입니다` }, 413);
  const blocks = body.blocks.filter(
    (b) => typeof b?.id === 'string' && typeof b.text === 'string' && b.text.length <= config.maxBlockChars,
  );
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  return stream(c, async (s) => {
    const ctrl = new AbortController();
    s.onAbort(() => ctrl.abort());
    for await (const ev of checkBlocks(harness, blocks, body.strength, ctrl.signal)) {
      await s.write(JSON.stringify(ev) + '\n');
    }
  });
});

app.post('/api/rewrite', async (c) => {
  const body = (await c.req.json().catch(() => null)) as RewriteRequest | null;
  if (!body || typeof body.text !== 'string' || !body.text.trim() || (body.style !== 'all' && !TONES.slice(1).includes(body.style))) {
    return c.json({ error: '잘못된 요청입니다' }, 400);
  }
  if (body.text.length > config.maxBlockChars) return c.json({ error: `선택 영역은 ${config.maxBlockChars}자까지입니다` }, 413);
  try {
    return c.json(await rewrite(harness, body, c.req.raw.signal));
  } catch {
    return c.json({ alternatives: [] });
  }
});

// ───────── 모델 하네스 v1 API ─────────

const SuggestBody = z.object({
  requestId: z.string().max(100).optional(),
  docVersion: z.number().int(),
  text: z.string().max(config.maxTextChars),
  task: z.enum(['spell', 'polish']),
  strength: z.enum(['light', 'normal', 'strong']).optional(),
  language: z.enum(['ko', 'en', 'auto']).optional(),
  priority: z.enum(['user', 'auto']).optional(),
  dictionary: z.array(z.string().max(100)).max(500).optional(),
  stream: z.boolean().optional(),
});

const AlternativesBody = z.object({
  requestId: z.string().max(100).optional(),
  text: z.string().min(1).max(config.maxBlockChars),
  tone: z.enum(['polite', 'concise', 'simple', 'formal']),
  n: z.number().int().min(1).max(5).optional(),
  language: z.enum(['ko', 'en', 'auto']).optional(),
  priority: z.enum(['user', 'auto']).optional(),
  dictionary: z.array(z.string().max(100)).max(500).optional(),
});

const FeedbackBody = z.object({
  suggestionId: z.string().max(100),
  action: z.enum(['accept', 'reject']),
  model: z.string().max(200),
  promptVersion: z.string().max(50),
});

app.post('/api/v1/suggest', async (c) => {
  const parsed = SuggestBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: '잘못된 요청입니다' }, 400);
  const req = parsed.data;
  if (!req.stream) return c.json(await harness.suggest(req, c.req.raw.signal));
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  return stream(c, async (s) => {
    const ctrl = new AbortController();
    s.onAbort(() => ctrl.abort());
    for await (const ev of harness.suggestStream(req, ctrl.signal)) await s.write(JSON.stringify(ev) + '\n');
  });
});

app.post('/api/v1/alternatives', async (c) => {
  const parsed = AlternativesBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: '잘못된 요청입니다' }, 400);
  return c.json(await harness.alternatives(parsed.data, c.req.raw.signal));
});

app.post('/api/v1/feedback', async (c) => {
  const parsed = FeedbackBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: '잘못된 요청입니다' }, 400);
  telemetry.feedback(parsed.data);
  return c.json({ ok: true });
});

app.get('/api/v1/metrics', async (c) =>
  c.json({ ...telemetry.snapshot(), rateLimit: await governor.usage(), models: registry.activeIds() }),
);

if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist' }));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`fastedit server http://localhost:${info.port}  llm=${harness.enabled ? registry.activeIds().join(' → ') : 'off (규칙 기반만)'}`);
});
