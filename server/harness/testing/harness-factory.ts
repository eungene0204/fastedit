import { EncryptedCache } from '../cache/cache.ts';
import { OpenRouterClient } from '../client/openrouter-client.ts';
import { KvRateGovernor } from '../governor/rate-governor.ts';
import { Harness } from '../harness.ts';
import { PromptBuilder } from '../prompts/builder.ts';
import { ModelRegistry } from '../registry/registry.ts';
import { CircuitBreaker, Router } from '../router/router.ts';
import { MemoryKv } from '../store/kv.ts';
import { Telemetry } from '../telemetry/telemetry.ts';
import { testConfig } from './fixtures.ts';

export function buildTestHarness(baseUrl: string, over: Record<string, unknown> = {}, logs: string[] = []) {
  const config = testConfig({
    allowPaidFallback: true,
    limits: { perMinute: 1000, perDay: 10000, softRatio: 0.8 },
    client: { firstTokenTimeoutMs: 500, totalTimeoutMs: 2000 },
    ...over,
  });
  const kv = new MemoryKv();
  const registry = new ModelRegistry(config);
  const telemetry = new Telemetry({ log: (l) => logs.push(l) });
  const governor = new KvRateGovernor(kv, config.limits);
  const harness = new Harness({
    config,
    registry,
    router: new Router(registry, new CircuitBreaker(config.router), config.router),
    client: new OpenRouterClient({ apiKey: 'k', baseUrl, ...config.client }),
    governor,
    cache: new EncryptedCache(kv, { ttlSec: config.cache.ttlSec, secret: 'test' }),
    telemetry,
    prompts: new PromptBuilder(),
    enabled: true,
  });
  return { harness, kv, telemetry, governor, registry, logs };
}
