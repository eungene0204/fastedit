import { baseKeymap } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { CheckBlock, CheckEvent, RewriteStyle, Strength, Suggestion, Tone } from '../../shared/types.ts';
import { rewrite, streamCheck } from '../lib/api.ts';
import { docFromText, schema } from './schema.ts';
import { getSugg, newId, suggAt, suggestionsPlugin, suggKey, type Sugg } from './suggestions.ts';

// 에디터와 교정 흐름(디바운스 → 요청 → 검증 → 표시)을 묶는 컨트롤러.
// React는 subscribe로 변경을 받아 패널·상태 바를 그린다.

const DEBOUNCE_MS = 500;
const FLASH_MS = 700;
const CONTEXT_CHARS = 400;

/** 요청을 보낸 뒤 문서가 바뀌어도 위치를 따라가도록 트랜잭션마다 매핑하는 구간 */
interface Tracked {
  from: number;
  to: number;
  text: string;
}

export interface RewriteState {
  style: RewriteStyle | 'all';
  range: Tracked;
  loading: boolean;
  alternatives: { style: RewriteStyle; text: string; reason: string }[];
  error?: string;
}

export type Status = 'idle' | 'checking' | 'error';

export interface Snapshot {
  items: Sugg[];
  active: string | null;
  status: Status;
  error?: string;
  progress: { done: number; total: number } | null;
  chars: number;
  selection: { from: number; to: number; text: string } | null;
  rewrite: RewriteState | null;
  model?: string;
}

export class Controller {
  view!: EditorView;
  strength: Strength = 'basic';
  tone: Tone = 'none';

  private listeners = new Set<() => void>();
  private snapshot!: Snapshot;
  /** 현재 설정으로 이미 검사를 보낸 문단 노드. 바뀌지 않은 문단은 노드 객체가 그대로 유지된다 */
  private checked = new WeakSet<PMNode>();
  private pending = new Map<string, Tracked>();
  private rejected = new Set<string>();
  /** 사용자가 수정·다듬기로 받아들인 글. 이 구간 안에서는 다시 제안하지 않는다 */
  private finalized = new Set<string>();
  private debounce?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastInput = 0;
  private buffered: { tracked: Tracked; ev: Extract<CheckEvent, { kind: 'result' }> }[] = [];
  private inflight = 0;
  private batch = { done: 0, total: 0 };
  private error?: string;
  private model?: string;
  private rewriteState: RewriteState | null = null;
  private rewriteAbort?: AbortController;

  mount(el: HTMLElement, initialText: string) {
    const state = EditorState.create({
      doc: docFromText(initialText),
      plugins: [
        suggestionsPlugin({
          actions: {
            accept: (id) => this.accept(id),
            reject: (id) => this.reject(id),
            reveal: (id) => this.reveal(id),
          },
        }),
        history(),
        keymap(this.shortcuts()),
        keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo }),
        keymap(baseKeymap),
      ],
    });
    this.view = new EditorView(el, {
      state,
      dispatchTransaction: (tr) => this.dispatch(tr),
      handleClick: (view, pos) => {
        const s = suggAt(view.state, pos);
        this.setActive(s?.id ?? null);
        return false;
      },
      attributes: { spellcheck: 'false', 'aria-label': '본문', 'aria-multiline': 'true', role: 'textbox' },
    });
    this.emit();
    this.schedule(0);
    return () => this.view.destroy();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  // ── 설정 ────────────────────────────────────────────

  setOptions(strength: Strength, tone: Tone) {
    if (strength === this.strength && tone === this.tone) return;
    this.strength = strength;
    this.tone = tone;
    // 설정이 바뀌면 모든 문단을 다시 검사한다
    this.checked = new WeakSet();
    this.schedule(0);
  }

  // ── 제안 처리 ────────────────────────────────────────

  setActive(id: string | null) {
    if (getSugg(this.view.state).active === id) return;
    this.view.dispatch(this.view.state.tr.setMeta(suggKey, { type: 'active', id }));
  }

  accept(id: string) {
    const s = getSugg(this.view.state).items.find((it) => it.id === id);
    if (s) this.applyAll([s]);
  }

  acceptAll(type?: Sugg['type']) {
    const items = getSugg(this.view.state).items.filter((s) => !type || s.type === type);
    if (items.length) this.applyAll(items);
  }

  reject(id: string) {
    const { state } = this.view;
    const s = getSugg(state).items.find((it) => it.id === id);
    if (!s) return;
    this.rejected.add(this.rejectKey(state.doc, s));
    this.view.dispatch(state.tr.setMeta(suggKey, { type: 'remove', ids: [id] }));
  }

  /** 다음(또는 이전) 제안으로 이동해 팝오버를 연다 */
  focusNext(dir: 1 | -1 = 1) {
    const { state } = this.view;
    const { items, active } = getSugg(state);
    if (!items.length) return false;
    const cur = items.findIndex((s) => s.id === active);
    let next: Sugg | undefined;
    if (cur !== -1) next = items[(cur + dir + items.length) % items.length];
    else {
      const head = state.selection.head;
      next = dir === 1 ? (items.find((s) => s.to >= head) ?? items[0]) : ([...items].reverse().find((s) => s.from <= head) ?? items.at(-1));
    }
    this.reveal(next!.id);
    return true;
  }

  reveal(id: string) {
    const s = getSugg(this.view.state).items.find((it) => it.id === id);
    if (!s) return;
    const tr = this.view.state.tr
      .setSelection(TextSelection.create(this.view.state.doc, s.to))
      .setMeta(suggKey, { type: 'active', id })
      .scrollIntoView();
    this.view.dispatch(tr);
    this.view.focus();
  }

  // ── 선택 영역 다듬기 ──────────────────────────────────

  async requestRewrite(style: RewriteStyle | 'all' = 'all') {
    const { state } = this.view;
    const { from, to } = state.selection;
    if (from === to) return;
    const text = state.doc.textBetween(from, to, '\n');
    const context = state.doc.textBetween(Math.max(0, from - CONTEXT_CHARS), from, '\n');
    this.rewriteAbort?.abort();
    const abort = (this.rewriteAbort = new AbortController());
    this.rewriteState = { style, range: { from, to, text }, loading: true, alternatives: [] };
    this.emit();
    try {
      const res = await rewrite({ text, style, context: context || undefined, strength: this.strength, tone: this.tone }, abort.signal);
      if (abort.signal.aborted || !this.rewriteState) return;
      this.rewriteState = { ...this.rewriteState, loading: false, alternatives: res.alternatives };
      if (!res.alternatives.length) this.rewriteState.error = '더 나은 대안을 찾지 못했습니다.';
    } catch (err) {
      if (abort.signal.aborted || !this.rewriteState) return;
      this.rewriteState = { ...this.rewriteState, loading: false, error: (err as Error).message };
    }
    this.emit();
  }

  applyRewrite(text: string) {
    const r = this.rewriteState;
    if (!r) return;
    const { state } = this.view;
    if (state.doc.textBetween(r.range.from, r.range.to, '\n') !== r.range.text) {
      this.rewriteState = { ...r, error: '선택한 글이 그사이 바뀌었습니다. 다시 선택해 주세요.' };
      this.emit();
      return;
    }
    const lines = text.split('\n');
    for (const l of lines) this.addFinal(l);
    const tr = state.tr;
    if (lines.length === 1) tr.insertText(text, r.range.from, r.range.to);
    else {
      const paras = lines.map((l) => schema.node('paragraph', null, l ? [schema.text(l)] : []));
      tr.replace(r.range.from, r.range.to, new Slice(Fragment.from(paras), 1, 1));
    }
    const end = tr.mapping.map(r.range.to);
    const flash = { id: newId(), from: r.range.from, to: end };
    tr.setMeta(suggKey, { type: 'flash', add: [flash] });
    // 아래 dispatch가 카드를 함께 지운다 (여기서 따로 dispatch하면 tr이 어긋난다)
    this.rewriteAbort?.abort();
    this.rewriteState = null;
    this.view.dispatch(tr);
    this.markChecked([flash]);
    this.view.focus();
    this.clearFlash([flash.id]);
  }

  closeRewrite() {
    this.rewriteAbort?.abort();
    this.rewriteState = null;
    this.emit();
  }

  // ── 내보내기 ─────────────────────────────────────────

  text() {
    return this.view.state.doc.textBetween(0, this.view.state.doc.content.size, '\n');
  }

  // ── 내부 ─────────────────────────────────────────────

  private shortcuts() {
    const active = () => getSugg(this.view.state).active;
    return {
      Tab: () => this.focusNext(1),
      'Shift-Tab': () => this.focusNext(-1),
      Enter: () => {
        const id = active();
        if (!id) return false;
        this.accept(id);
        return true;
      },
      Escape: () => {
        const id = active();
        if (!id) return false;
        this.reject(id);
        return true;
      },
    };
  }

  private dispatch(tr: Transaction) {
    const state = this.view.state.apply(tr);
    this.view.updateState(state);
    if (tr.docChanged) {
      for (const t of this.pending.values()) this.mapTracked(t, tr);
      for (const b of this.buffered) this.mapTracked(b.tracked, tr);
      if (this.rewriteState) this.mapTracked(this.rewriteState.range, tr);
      if (!tr.getMeta('fastedit-accept')) this.lastInput = Date.now();
      this.schedule(DEBOUNCE_MS);
    }
    this.emit();
  }

  private mapTracked(t: Tracked, tr: Transaction) {
    t.from = tr.mapping.map(t.from, -1);
    t.to = tr.mapping.map(t.to, 1);
  }

  private applyAll(items: Sugg[]) {
    const { state } = this.view;
    const tr = state.tr.setMeta('fastedit-accept', true);
    const marks: { id: string; from: number; len: number; step: number }[] = [];
    for (const s of items) if (s.replacement.length >= 8) this.addFinal(s.replacement);
    // 뒤에서부터 바꿔야 앞쪽 위치가 흔들리지 않는다
    for (const s of [...items].sort((a, b) => b.from - a.from)) {
      tr.insertText(s.replacement, s.from, s.to);
      marks.push({ id: newId(), from: s.from, len: s.replacement.length, step: tr.steps.length });
    }
    const flashes = marks.map((m) => {
      const from = tr.mapping.slice(m.step).map(m.from, -1);
      return { id: m.id, from, to: from + m.len };
    });
    tr.setMeta(suggKey, [
      { type: 'remove', ids: items.map((s) => s.id) },
      { type: 'flash', add: flashes },
    ]);
    this.view.dispatch(tr);
    this.markChecked(flashes);
    this.clearFlash(flashes.map((f) => f.id));
  }

  private addFinal(text: string) {
    if (text.trim()) this.finalized.add(text);
    if (this.finalized.size > 200) this.finalized.delete(this.finalized.values().next().value!);
  }

  private finalRanges(text: string): [number, number][] {
    const out: [number, number][] = [];
    for (const f of this.finalized) {
      for (let i = text.indexOf(f); i !== -1; i = text.indexOf(f, i + f.length)) out.push([i, i + f.length]);
    }
    return out;
  }

  /** 수정이 반영된 문단은 이미 확정된 글이므로 다시 검사하지 않는다 (사용자가 직접 고치면 다시 검사) */
  private markChecked(ranges: { from: number; to: number }[]) {
    const { doc } = this.view.state;
    for (const r of ranges) {
      doc.nodesBetween(Math.max(0, r.from), Math.min(doc.content.size, r.to), (node, pos) => {
        const end = pos + node.nodeSize;
        // 같은 문단의 검사 결과가 아직 오는 중이면 그 결과를 받아야 하므로 건너뛴다
        const inflight = [...this.pending.values()].some((t) => t.from < end && pos < t.to);
        if (!inflight) this.checked.add(node);
        return false;
      });
    }
  }

  private clearFlash(ids: string[]) {
    setTimeout(() => {
      if (!this.view.isDestroyed) this.view.dispatch(this.view.state.tr.setMeta(suggKey, { type: 'flash', remove: ids }));
    }, FLASH_MS);
  }

  private rejectKey(doc: PMNode, s: Suggestion) {
    const $pos = doc.resolve(s.from);
    const offset = s.from - $pos.start();
    return `${$pos.parent.textContent}\u0000${offset}\u0000${s.original}\u0000${s.replacement}`;
  }

  private schedule(ms: number) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.run(), ms);
  }

  private run() {
    const { doc } = this.view.state;
    const blocks: CheckBlock[] = [];
    const tracked = new Map<string, Tracked>();
    let prev = '';
    doc.forEach((node, offset) => {
      const text = node.textContent;
      if (text.trim() && !this.checked.has(node)) {
        const id = newId();
        const from = offset + 1;
        blocks.push({ id, text, context: prev ? prev.slice(-CONTEXT_CHARS) : undefined });
        tracked.set(id, { from, to: from + node.content.size, text });
        this.checked.add(node);
      }
      if (text.trim()) prev = text;
    });
    if (!blocks.length) return;

    // 붙여넣기처럼 문단이 많을 때만 진행 표시줄을 쓴다
    if (this.inflight === 0) this.batch = { done: 0, total: 0 };
    this.batch.total += blocks.length;
    this.error = undefined;

    for (let i = 0; i < blocks.length; i += 50) {
      const chunk = blocks.slice(i, i + 50);
      for (const b of chunk) this.pending.set(b.id, tracked.get(b.id)!);
      this.inflight++;
      this.emit();
      const llmDone = new Set<string>();
      streamCheck({ strength: this.strength, tone: this.tone, blocks: chunk }, (ev) => {
        if (ev.kind === 'done') return;
        const t = this.pending.get(ev.id);
        if (!t) return;
        if (ev.kind === 'error') {
          this.error = ev.message;
        } else {
          if (ev.model) this.model = ev.model;
          this.receive(t, ev);
        }
        // 규칙 단계만 있는 응답(LLM 꺼짐)도 완료로 친다
        if (ev.kind === 'error' || ev.phase === 'llm') llmDone.add(ev.id);
        if (llmDone.has(ev.id)) {
          this.pending.delete(ev.id);
          this.batch.done++;
        }
        this.emit();
      })
        .catch((err) => {
          this.error = (err as Error).message;
          // 실패한 문단은 다음 입력 때 다시 검사한다
          this.checked = new WeakSet();
        })
        .finally(() => {
          for (const b of chunk) {
            if (this.pending.delete(b.id)) this.batch.done++;
          }
          this.inflight--;
          this.emit();
        });
    }
  }

  private receive(tracked: Tracked, ev: Extract<CheckEvent, { kind: 'result' }>) {
    // 타이핑 중에는 아무것도 띄우지 않는다: 입력이 멈출 때까지 결과를 모아 둔다
    const idle = Date.now() - this.lastInput;
    if (idle < DEBOUNCE_MS) {
      this.buffered.push({ tracked: { ...tracked }, ev });
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), DEBOUNCE_MS - idle + 20);
      return;
    }
    this.applyResult(tracked, ev);
  }

  private flush() {
    if (Date.now() - this.lastInput < DEBOUNCE_MS) {
      this.flushTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
      return;
    }
    const items = this.buffered;
    this.buffered = [];
    for (const b of items) this.applyResult(b.tracked, b.ev);
  }

  private applyResult(t: Tracked, ev: Extract<CheckEvent, { kind: 'result' }>) {
    const { state } = this.view;
    // 결과가 오기 전에 원문이 바뀌었다면 버린다 (바뀐 문단은 디바운스 후 다시 요청된다)
    if (t.from > t.to || t.to > state.doc.content.size || state.doc.textBetween(t.from, t.to) !== t.text) return;
    const final = this.finalRanges(t.text);
    const items: Sugg[] = ev.suggestions
      .filter((s) => !final.some(([a, b]) => s.from < b && a < s.to))
      .map((s) => ({ ...s, id: newId(), from: t.from + s.from, to: t.from + s.to }))
      .filter((s) => !this.rejected.has(this.rejectKey(state.doc, s)));
    this.view.dispatch(state.tr.setMeta(suggKey, { type: 'block', from: t.from, to: t.to, phase: ev.phase, items }));
  }

  private emit() {
    if (!this.view) return;
    const { state } = this.view;
    const s = getSugg(state);
    const { from, to } = state.selection;
    const busy = this.pending.size > 0;
    this.snapshot = {
      items: s.items,
      active: s.active,
      status: busy ? 'checking' : this.error ? 'error' : 'idle',
      error: this.error,
      progress: busy && this.batch.total >= 3 ? { ...this.batch } : null,
      chars: state.doc.textContent.length,
      selection: from === to ? null : { from, to, text: state.doc.textBetween(from, to, '\n') },
      rewrite: this.rewriteState,
      model: this.model,
    };
    for (const fn of this.listeners) fn();
  }
}
