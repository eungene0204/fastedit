import type { SuggestionType } from '../../shared/types.ts';
import type { Controller, Snapshot } from '../editor/controller.ts';
import { TYPE_LABEL } from '../labels.ts';

const TYPES: SuggestionType[] = ['error', 'clarity', 'tone'];

export function StatusBar({ ctrl, snap, llm }: { ctrl: Controller; snap: Snapshot; llm: boolean | null }) {
  const status =
    snap.status === 'checking' ? (
      <span className="state checking">
        <span className="spinner" aria-hidden /> 검사 중
      </span>
    ) : snap.status === 'error' ? (
      <span className="state error" title={snap.error}>
        일부 검사 실패
      </span>
    ) : (
      <span className="state done">✓ 완료</span>
    );
  return (
    <footer className="statusbar" aria-live="polite">
      <span>{snap.chars.toLocaleString()}자</span>
      <span className="counts">
        {TYPES.map((t) => (
          <span key={t} className="count">
            <i className={`dot dot-${t}`} aria-hidden />
            {TYPE_LABEL[t]} <b>{snap.items.filter((s) => s.type === t).length}</b>
          </span>
        ))}
      </span>
      {status}
      <span className="spacer" />
      {llm === false && <span className="badge warn">규칙 기반만 동작 중</span>}
      <button className="primary" disabled={!snap.items.length} onClick={() => ctrl.acceptAll()}>
        모두 수정
      </button>
    </footer>
  );
}
