import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const task = z.enum(['spell', 'polish', 'tone']);

export const ModelSchema = z.object({
  id: z.string().min(1),
  tier: z.enum(['free', 'paid']),
  tasks: z.array(task).min(1),
  supportsJsonMode: z.boolean().default(false),
  supportsStreaming: z.boolean().default(false),
  contextLength: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  dataPolicy: z.enum(['no-train', 'retain', 'may-train', 'unknown']).default('unknown'),
  priority: z.number().default(100),
  enabled: z.boolean().default(true),
  extraBody: z.record(z.string(), z.unknown()).optional(),
});

export const ConfigSchema = z
  .object({
    dataCollection: z.enum(['allow', 'deny']).default('deny'),
    onNoEligible: z.enum(['degrade', 'relax']).default('degrade'),
    allowPaidFallback: z.boolean().default(false),
    limits: z
      .object({
        perMinute: z.number().int().positive().default(20),
        perDay: z.number().int().positive().default(50),
        softRatio: z.number().min(0).max(1).default(0.8),
      })
      .prefault({}),
    client: z
      .object({
        firstTokenTimeoutMs: z.number().positive().default(3000),
        totalTimeoutMs: z.number().positive().default(15000),
      })
      .prefault({}),
    router: z
      .object({
        maxAttempts: z.number().int().positive().default(3),
        errorRateThreshold: z.number().min(0).max(1).default(0.5),
        windowMs: z.number().positive().default(300_000),
        minSamples: z.number().int().positive().default(4),
        cooldownMs: z.number().nonnegative().default(60_000),
      })
      .prefault({}),
    batch: z
      .object({
        maxSentences: z.number().int().positive().default(8),
        maxChars: z.number().int().positive().default(1500),
        concurrency: z.number().int().positive().default(3),
      })
      .prefault({}),
    cache: z.object({ ttlSec: z.number().int().positive().default(604_800) }).prefault({}),
    validator: z.object({ minConfidence: z.number().min(0).max(1).default(0.5) }).prefault({}),
    models: z.array(ModelSchema).min(1),
    chains: z.partialRecord(task, z.array(z.string())).default({}),
  })
  .superRefine((cfg, ctx) => {
    const byId = new Map(cfg.models.map((m) => [m.id, m]));
    if (byId.size !== cfg.models.length) ctx.addIssue({ code: 'custom', message: '모델 ID가 중복되었습니다' });
    for (const [t, ids] of Object.entries(cfg.chains)) {
      for (const id of ids) {
        const m = byId.get(id);
        if (!m) ctx.addIssue({ code: 'custom', message: `chains.${t}: 정의되지 않은 모델 ${id}` });
        else if (!m.tasks.includes(t as 'spell')) ctx.addIssue({ code: 'custom', message: `chains.${t}: ${id}는 ${t} 작업을 지원하지 않습니다` });
      }
    }
  });

export type HarnessConfig = z.infer<typeof ConfigSchema>;

export function parseConfig(yamlText: string): HarnessConfig {
  return ConfigSchema.parse(parse(yamlText));
}

/** models.yaml을 읽고 환경 변수 덮어쓰기를 적용한다 */
export function loadConfig(path = process.env.FASTEDIT_MODELS_FILE ?? 'config/models.yaml', env = process.env): HarnessConfig {
  const cfg = parseConfig(readFileSync(path, 'utf8'));
  if (env.FASTEDIT_DATA_COLLECTION === 'allow' || env.FASTEDIT_DATA_COLLECTION === 'deny') cfg.dataCollection = env.FASTEDIT_DATA_COLLECTION;
  if (env.FASTEDIT_ALLOW_PAID !== undefined) cfg.allowPaidFallback = env.FASTEDIT_ALLOW_PAID === '1' || env.FASTEDIT_ALLOW_PAID === 'true';
  return cfg;
}
