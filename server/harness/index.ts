import { EncryptedCache } from './cache/cache.ts';
import { OpenRouterClient } from './client/openrouter-client.ts';
import { loadConfig, type HarnessConfig } from './config.ts';
import { KvRateGovernor } from './governor/rate-governor.ts';
import { Harness } from './harness.ts';
import { PromptBuilder } from './prompts/builder.ts';
import { ModelRegistry } from './registry/registry.ts';
import { CircuitBreaker, Router } from './router/router.ts';
import { createKv, type KvStore } from './store/kv.ts';
import { Telemetry } from './telemetry/telemetry.ts';

export interface HarnessBundle {
  harness: Harness;
  registry: ModelRegistry;
  telemetry: Telemetry;
  governor: KvRateGovernor;
  config: HarnessConfig;
  kv: KvStore;
  stop(): Promise<void>;
}

/** 환경 변수와 config/models.yaml로 실제 하네스를 조립한다 */
export async function createHarness(env = process.env): Promise<HarnessBundle> {
  const config = loadConfig(undefined, env);
  const kv = await createKv(env.REDIS_URL);
  const registry = new ModelRegistry(config);
  const apiKey = env.OPENROUTER_API_KEY ?? '';
  const telemetry = new Telemetry({ kv });
  const governor = new KvRateGovernor(kv, config.limits);
  const harness = new Harness({
    config,
    registry,
    router: new Router(registry, new CircuitBreaker(config.router), config.router),
    client: new OpenRouterClient({ apiKey, ...config.client }),
    governor,
    cache: new EncryptedCache(kv, { ttlSec: config.cache.ttlSec, secret: env.CACHE_ENCRYPTION_KEY }),
    telemetry,
    prompts: new PromptBuilder(),
    enabled: Boolean(apiKey),
  });
  if (apiKey) await registry.refresh();
  const stopDaily = registry.startDaily();
  return {
    harness,
    registry,
    telemetry,
    governor,
    config,
    kv,
    stop: async () => {
      stopDaily();
      await kv.close();
    },
  };
}
