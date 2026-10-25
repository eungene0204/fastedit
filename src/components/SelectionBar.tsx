import type { Controller, Snapshot } from '../editor/controller.ts';
import { anchor } from './position.ts';

// 문장이나 문단을 선택하면 위에 뜨는 다듬기 도구
export function SelectionBar(p: { ctrl: Controller; snap: Snapshot; container: HTMLElement | null; disabled: boolean }) {
  const sel = p.snap.selection;
  if (!sel || !sel.text.trim() || p.snap.rewrite?.loading) return null;
  const at = anchor(p.ctrl.view, p.container, sel.from);
  if (!at) return null;
  return (
    <div
      className="selbar"
      style={{ left: Math.max(0, at.left - 8), top: Math.max(0, at.top - 44) }}
      onMouseDown={(e) => e.preventDefault()}
      role="toolbar"
      aria-label="선택 영역 다듬기"
    >
      {p.disabled ? (
        <span className="muted">다듬기는 OpenRouter 키가 필요합니다</span>
      ) : (
        <button className="rewrite-trigger" onClick={() => p.ctrl.requestRewrite('all')}>다듬기</button>
      )}
    </div>
  );
}
