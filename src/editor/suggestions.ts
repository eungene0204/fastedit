import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Suggestion } from '../../shared/types.ts';
import { fixNote, type Actions } from './widgets.ts';

/** 문서 절대 위치를 갖는 제안 */
export interface Sugg extends Suggestion {
  id: string;
}

interface Flash {
  id: string;
  from: number;
  to: number;
}

export interface SuggState {
  items: Sugg[];
  active: string | null;
  flashes: Flash[];
}

export interface UiBridge {
  actions: Actions;
}

type Meta =
  | { type: 'block'; from: number; to: number; phase: 'fast' | 'llm'; items: Sugg[] }
  | { type: 'remove'; ids: string[] }
  | { type: 'active'; id: string | null }
  | { type: 'flash'; add?: Flash[]; remove?: string[] };

export const suggKey = new PluginKey<SuggState>('suggestions');

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) => a.from < b.to && b.from < a.to;

function mapItems(items: Sugg[], tr: Transaction, doc: PMNode): Sugg[] {
  const out: Sugg[] = [];
  for (const s of items) {
    const from = tr.mapping.map(s.from, 1);
    const to = tr.mapping.map(s.to, -1);
    // 제안 구간의 글자가 바뀌었다면 그 제안은 더 이상 유효하지 않다
    if (from < to && doc.textBetween(from, to) === s.original) out.push({ ...s, from, to });
  }
  return out;
}

function applyMeta(state: SuggState, meta: Meta): SuggState {
  switch (meta.type) {
    case 'block': {
      const inBlock = (s: Sugg) => s.from >= meta.from && s.to <= meta.to;
      if (meta.phase === 'fast') {
        // 규칙 제안만 교체한다. 남아 있는 LLM 제안은 LLM 결과가 올 때까지 유지해 깜빡임을 막는다
        const rest = state.items.filter(
          (s) => !inBlock(s) || (s.source === 'llm' && !meta.items.some((n) => overlaps(n, s))),
        );
        return { ...state, items: [...rest, ...meta.items].sort((a, b) => a.from - b.from) };
      }
      const rest = state.items.filter((s) => !(inBlock(s) && s.source === 'llm'));
      const fresh = meta.items.filter((s) => !rest.some((r) => overlaps(r, s)));
      return { ...state, items: [...rest, ...fresh].sort((a, b) => a.from - b.from) };
    }
    case 'remove': {
      const ids = new Set(meta.ids);
      return {
        ...state,
        items: state.items.filter((s) => !ids.has(s.id)),
        active: state.active && ids.has(state.active) ? null : state.active,
      };
    }
    case 'active':
      return { ...state, active: meta.id };
    case 'flash': {
      const remove = new Set(meta.remove ?? []);
      return { ...state, flashes: [...state.flashes.filter((f) => !remove.has(f.id)), ...(meta.add ?? [])] };
    }
  }
}

export function suggestionsPlugin(ui: UiBridge) {
  return new Plugin<SuggState>({
    key: suggKey,
    state: {
      init: () => ({ items: [], active: null, flashes: [] }),
      apply(tr, prev) {
        let next = prev;
        if (tr.docChanged) {
          const items = mapItems(prev.items, tr, tr.doc);
          next = {
            items,
            // 글을 고치는 중에는 팝오버를 닫는다
            active: null,
            flashes: prev.flashes.map((f) => ({ ...f, from: tr.mapping.map(f.from, -1), to: tr.mapping.map(f.to, 1) })),
          };
        }
        const metas = (tr.getMeta(suggKey) as Meta[] | Meta | undefined) ?? [];
        for (const m of Array.isArray(metas) ? metas : [metas]) next = applyMeta(next, m);
        return next;
      },
    },
    props: {
      decorations(state) {
        const s = suggKey.getState(state)!;
        const decos = s.items.map((it) =>
          Decoration.inline(it.from, it.to, {
            class: `sug sug-${it.type}${s.active === it.id ? ' sug-active' : ''}`,
            'data-sid': it.id,
          }),
        );
        for (const f of s.flashes) if (f.from < f.to) decos.push(Decoration.inline(f.from, f.to, { class: 'flash' }));

        // 수정안은 밑줄 바로 아래에 하이라이트로 붙이고, 들어갈 자리를 위해 해당 문단의 행간을 넓힌다
        const widgetSpec = { stopEvent: () => true, ignoreSelection: true };
        const withFix = new Set<number>();
        for (const it of s.items) {
          decos.push(
            Decoration.widget(it.from, () => fixNote(it, s.active === it.id, ui.actions), {
              ...widgetSpec,
              key: `f:${it.id}:${it.replacement}:${s.active === it.id}`,
              side: -1,
            }),
          );
          withFix.add(state.doc.resolve(it.from).before(1));
        }
        for (const pos of withFix) decos.push(Decoration.node(pos, pos + state.doc.nodeAt(pos)!.nodeSize, { class: 'has-fix' }));

        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

export const getSugg = (state: EditorState) => suggKey.getState(state)!;

export const suggAt = (state: EditorState, pos: number) =>
  getSugg(state).items.find((s) => pos >= s.from && pos <= s.to);

let seq = 0;
export const newId = () => `s${++seq}`;
