import type { Sugg } from './suggestions.ts';

// 밑줄 아래에 붙는 수정안. ProseMirror 위젯이라 React 대신 DOM으로 직접 만든다.

export interface Actions {
  accept(id: string): void;
  reject(id: string): void;
  reveal(id: string): void;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// 에디터 선택·포커스가 흔들리지 않도록 mousedown은 막고 click에서 동작한다
function button(label: string, className: string, onClick: () => void) {
  const b = h('button', className, label);
  b.type = 'button';
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** 밑줄이 시작되는 자리에 붙어, 바로 아래에 수정안을 하이라이트로 보여 주는 요소 */
export function fixNote(s: Sugg, active: boolean, a: Actions): HTMLElement {
  const anchor = h('span', 'fix-anchor');
  anchor.contentEditable = 'false';
  const note = h('span', `fix type-${s.type}${active ? ' active' : ''}`);
  note.title = s.reason ? `${s.reason}\n클릭하면 수정합니다` : '클릭하면 수정합니다';
  note.addEventListener('mousedown', (e) => e.preventDefault());
  note.addEventListener('click', () => a.accept(s.id));
  note.append(h('span', 'fix-text', s.replacement || '(삭제)'), button('×', 'fix-x', () => a.reject(s.id)));
  note.lastElementChild!.setAttribute('aria-label', '거절');
  anchor.append(note);
  requestAnimationFrame(() => {
    // 오른쪽 끝에서 잘리지 않도록 에디터 안쪽으로 당긴다
    const limit = note.closest('.ProseMirror')?.getBoundingClientRect().right;
    const over = limit === undefined ? 0 : note.getBoundingClientRect().right - limit;
    if (over > 0) note.style.left = `${-over}px`;
    if (active) note.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  return anchor;
}
