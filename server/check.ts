import type { CheckBlock, CheckEvent, RewriteRequest, RewriteResponse, Strength, Suggestion, Tone } from '../shared/types.ts';
import type { HarnessTone } from '../shared/harness.ts';
import type { Harness } from './harness/harness.ts';
import { dropOverlaps, runRules } from './rules.ts';

// 편집기용 어댑터: 규칙 결과를 먼저 보내고, 모델 하네스 결과를 문단별로 뒤따라 보낸다.
// 모델 호출·검증·캐시·한도는 모두 하네스가 맡는다.

const STRENGTH: Record<Strength, { task: 'spell' | 'polish'; strength: 'light' | 'normal' | 'strong' }> = {
  spell: { task: 'spell', strength: 'light' },
  basic: { task: 'polish', strength: 'normal' },
  aggressive: { task: 'polish', strength: 'strong' },
};

const TONE: Record<Exclude<Tone, 'none'>, HarnessTone> = { polite: 'polite', concise: 'concise', easy: 'simple', formal: 'formal' };

export async function* checkBlocks(
  harness: Harness,
  blocks: CheckBlock[],
  strength: Strength,
  signal: AbortSignal,
): AsyncGenerator<CheckEvent> {
  const rules = new Map<string, Suggestion[]>();
  for (const b of blocks) {
    const s = runRules(b.text);
    rules.set(b.id, s);
    yield { kind: 'result', id: b.id, phase: 'fast', suggestions: s };
  }
  if (!harness.enabled) {
    yield { kind: 'done' };
    return;
  }

  const { task, strength: level } = STRENGTH[strength];
  const pending = new Map<string, Promise<CheckEvent>>();
  for (const b of blocks) {
    if (!b.text.trim()) continue;
    // 편집 중 자동으로 도는 요청이므로 priority=auto: 한도가 차오르면 하네스가 먼저 거절한다
    const p = harness
      .suggest({ docVersion: 0, text: b.text, task, strength: level, priority: 'auto' }, signal)
      .then((res): CheckEvent => {
        const llm: Suggestion[] = res.suggestions.map((s) => ({
          from: s.start,
          to: s.end,
          original: s.original,
          replacement: s.replacement,
          reason: s.reason,
          type: s.type,
          source: 'llm',
        }));
        return {
          kind: 'result',
          id: b.id,
          phase: 'llm',
          model: res.suggestions[0]?.model,
          suggestions: dropOverlaps(llm, rules.get(b.id)),
        };
      })
      // 오류는 사용자에게 노출하지 않는다 (하네스는 degraded 응답으로 돌려주므로 여기까지 오는 일은 드물다)
      .catch((): CheckEvent => ({ kind: 'result', id: b.id, phase: 'llm', suggestions: [] }));
    pending.set(b.id, p);
  }
  while (pending.size) {
    const ev = await Promise.race(pending.values());
    pending.delete((ev as { id: string }).id);
    if (!signal.aborted) yield ev;
  }
  yield { kind: 'done' };
}

const apply = (src: string, items: { from: number; to: number; replacement: string }[]) => {
  let out = src;
  for (const s of [...items].sort((a, b) => b.from - a.from)) out = out.slice(0, s.from) + s.replacement + out.slice(s.to);
  return out;
};

export async function rewrite(harness: Harness, req: RewriteRequest, signal: AbortSignal): Promise<RewriteResponse> {
  const styles: Exclude<Tone, 'none'>[] = req.style === 'all' ? Object.keys(TONE) as Exclude<Tone, 'none'>[] : [req.style];
  const results = await Promise.all(styles.map(async (style) => {
    try {
      const res = await harness.alternatives({ text: req.text, tone: TONE[style], n: req.style === 'all' ? 1 : 3, priority: 'user' }, signal);
      // 규칙 기반 맞춤법 교정을 적용하고, 원문과 같은 대안은 제외한다.
      const seen = new Set<string>();
      const alternatives = res.alternatives
        .map((a) => ({ style, text: apply(a.text, runRules(a.text)), reason: a.note }))
        .filter((a) => a.text !== req.text && !seen.has(a.text) && seen.add(a.text));
      return { alternatives, model: res.model };
    } catch {
      return { alternatives: [], model: undefined };
    }
  }));
  return { alternatives: results.flatMap((result) => result.alternatives), model: results.find((result) => result.model)?.model };
}
