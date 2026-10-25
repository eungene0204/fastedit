import type { EditorView } from 'prosemirror-view';

/** 문서 위치를 스크롤 컨테이너 기준 좌표로 바꾼다 */
export function anchor(view: EditorView, container: HTMLElement | null, pos: number) {
  if (!container) return null;
  try {
    const c = view.coordsAtPos(pos);
    const box = container.getBoundingClientRect();
    const page = container.firstElementChild!.getBoundingClientRect();
    return { left: c.left - page.left, top: c.top - box.top + container.scrollTop, bottom: c.bottom - box.top + container.scrollTop };
  } catch {
    return null;
  }
}
