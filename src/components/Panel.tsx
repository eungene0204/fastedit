import type { Controller, Snapshot } from '../editor/controller.ts';
import { REWRITE_STYLES } from '../labels.ts';

// 문장을 선택해 "더 쉽게" 같은 다듬기를 요청하면 대안을 여기에 보여 준다.
// 오류·명확성·어조 제안은 에디터 안에서 밑줄 아래에 바로 보인다.
export function Panel({ ctrl, snap, open, onToggle }: { ctrl: Controller; snap: Snapshot; open: boolean; onToggle: () => void }) {
  const r = snap.rewrite;
  const label = r && (r.style === 'all' ? '여러 톤' : REWRITE_STYLES.find((s) => s.value === r.style)?.label);

  return (
    <aside className={`panel${open ? ' open' : ''}${r ? '' : ' no-items'}`} aria-label="다듬기">
      <button className="sheet-handle" onClick={onToggle} aria-expanded={open}>
        <span className="grip" aria-hidden />
        다듬기 {r ? `· ${label}` : ''}
      </button>
      <div className="panel-head">
        <div className="panel-title">다듬기</div>
        {r && (
          <button className="icon" onClick={() => ctrl.closeRewrite()} aria-label="닫기">
            ×
          </button>
        )}
      </div>

      <div className="cards">
        {!r && (
          <div className="empty">
            다듬고 싶은 문장이나 문단을 선택하세요.
            <p className="muted">
              문장을 선택하고 다듬기를 누르면 여러 톤의 대안을 여기서 확인할 수 있어요.
            </p>
          </div>
        )}
        {r && (
          <article className="card rewrite">
            <div className="card-top">
              <span className="chip chip-rewrite">다듬기 · {label}</span>
            </div>
            <p className="quote">{r.range.text}</p>
            {r.loading && (
              <div className="rewrite-loading" aria-label="여러 톤의 대안 생성 중">
                <p>여러 톤으로 문장을 다듬고 있어요.</p>
                <div className="skeletons"><div /><div /><div /><div /></div>
              </div>
            )}
            {r.error && <p className="reason error-text">{r.error}</p>}
            {REWRITE_STYLES.map((style) => {
              const alternative = r.alternatives.find((a) => a.style === style.value);
              if (!alternative) return null;
              return (
                <section className="tone-alternative" key={style.value}>
                  <h3>{style.label}</h3>
                  <button className="alt" onClick={() => ctrl.applyRewrite(alternative.text)}>
                    <span className="alt-text">{alternative.text}</span>
                    {alternative.reason && <span className="reason">{alternative.reason}</span>}
                  </button>
                </section>
              );
            })}
            {!r.loading && !r.error && !r.alternatives.length && <p className="reason">더 나은 대안을 찾지 못했습니다.</p>}
          </article>
        )}
      </div>
    </aside>
  );
}
