import type { HarnessConfig } from '../config.ts';
import { parseConfig } from '../config.ts';

export const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  tier: 'free',
  tasks: ['spell', 'polish', 'tone'],
  supportsJsonMode: true,
  supportsStreaming: true,
  contextLength: 100000,
  maxOutputTokens: 1000,
  dataPolicy: 'no-train',
  ...extra,
});

export function testConfig(over: Record<string, unknown> = {}): HarnessConfig {
  return parseConfig(
    JSON.stringify({
      dataCollection: 'deny',
      models: [model('free/a:free', { priority: 1 }), model('free/b:free', { priority: 2 }), model('paid/c', { tier: 'paid', priority: 3 })],
      chains: { polish: ['free/a:free', 'free/b:free', 'paid/c'], spell: ['free/a:free', 'free/b:free', 'paid/c'], tone: ['free/a:free', 'free/b:free', 'paid/c'] },
      ...over,
    }),
  );
}
