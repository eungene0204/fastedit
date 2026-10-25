import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { StatusResponse, Strength } from '../shared/types.ts';
import { Panel } from './components/Panel.tsx';
import { SelectionBar } from './components/SelectionBar.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Controller } from './editor/controller.ts';
import { getStatus } from './lib/api.ts';

function EditorApp() {
  const [ctrl] = useState(() => new Controller());
  const editorRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [title, setTitle] = useState('제목 없는 문서');
  const [strength, setStrength] = useState<Strength>('basic');
  const [server, setServer] = useState<StatusResponse | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // 스크롤할 때 선택 도구 위치를 다시 계산하기 위한 값
  const [, setScrollTick] = useState(0);

  useLayoutEffect(() => {
    const destroy = ctrl.mount(editorRef.current!, '');
    setMounted(true);
    return destroy;
  }, [ctrl]);

  useEffect(() => {
    getStatus().then(setServer, () => setServer({ llm: false, models: [] }));
  }, []);

  useEffect(() => ctrl.setOptions(strength, 'none'), [ctrl, strength]);

  const snap = useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot);

  // 모바일: 다듬기를 요청하면 하단 시트가 열린다
  const rewriting = Boolean(snap?.rewrite);
  useEffect(() => setSheetOpen(rewriting), [rewriting]);

  return (
    <div className="app">
      <TopBar
        title={title}
        onTitle={setTitle}
        strength={strength}
        onStrength={setStrength}
        onCopy={() => navigator.clipboard.writeText(ctrl.text())}
        onExport={() => {
          const url = URL.createObjectURL(new Blob([ctrl.text()], { type: 'text/plain;charset=utf-8' }));
          const a = Object.assign(document.createElement('a'), { href: url, download: `${title || 'fastedit'}.txt` });
          a.click();
          URL.revokeObjectURL(url);
        }}
      />
      {snap?.progress && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={snap.progress.total} aria-valuenow={snap.progress.done}>
          <div style={{ width: `${(snap.progress.done / snap.progress.total) * 100}%` }} />
        </div>
      )}
      <main className="workspace">
        <section className="editor-col">
          <div className="editor-scroll" ref={scrollRef} onScroll={() => setScrollTick((n) => n + 1)}>
            <div className="editor-page">
              <div className="editor" ref={editorRef} />
              {mounted && snap && (
                <>
                  <SelectionBar ctrl={ctrl} snap={snap} container={scrollRef.current} disabled={!server?.llm} />
                </>
              )}
            </div>
          </div>
          {snap && <StatusBar ctrl={ctrl} snap={snap} llm={server?.llm ?? null} />}
        </section>
        {snap && <Panel ctrl={ctrl} snap={snap} open={sheetOpen} onToggle={() => setSheetOpen((o) => !o)} />}
      </main>
    </div>
  );
}

function LandingPage() {
  return (
    <main className="landing">
      <nav className="landing-nav">
        <a className="landing-brand" href="/" aria-label="fastedit 홈"><span className="brand-mark">f.</span> fastedit</a>
        <a className="nav-cta" href="/editor">에디터 열기 <span>↗</span></a>
      </nav>

      <section className="landing-hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-dot" /> KOREAN & ENGLISH WRITING ASSISTANT</div>
          <h1>쓰는 흐름은 그대로,<br /><em>문장은 더 매끄럽게.</em></h1>
          <p className="hero-description">맞춤법부터 자연스러운 표현까지.<br />생각을 멈추지 않고, 더 좋은 문장으로 다듬어 보세요.</p>
          <div className="hero-actions">
            <a className="primary-cta" href="/editor">무료로 글 다듬기 <span>→</span></a>
            <span className="cta-note">가입 없이 바로 시작</span>
          </div>
          <div className="hero-proof"><div className="proof-icon">✳</div><span><strong>한국어와 영어</strong>를 한 곳에서<br />맞춤법 교정과 문장 윤문</span></div>
        </div>

        <div className="hero-art" aria-label="문장 교정 미리보기" role="img">
          <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
          <video className="demo-video" autoPlay muted loop playsInline preload="metadata" poster="/media/fastedit-demo-poster.jpg" aria-label="문장을 입력하고 맞춤법과 정중한 톤 제안을 적용하는 fastedit 영상">
            <source src="/media/fastedit-demo.webm" type="video/webm" />
          </video>
          <div className="floating-note note-top"><span>✓</span> 맞춤법 확인</div>
          <div className="floating-note note-bottom"><span>✳</span> 문장 흐름 개선</div>
          <div className="hero-spark spark-one">✳</div><div className="hero-spark spark-two">✦</div>
        </div>
        <div className="hero-bottom"><span>WRITE WITH YOUR OWN VOICE</span><span>아래로 스크롤 <b>↓</b></span></div>
      </section>

      <section className="landing-features" id="features">
        <div className="section-heading"><span className="section-label">A BETTER WAY TO WRITE</span><h2>글쓰기에 필요한 순간,<br />곁에서 가볍게.</h2><p>복잡한 설정 없이 쓰고, 확인하고, 원하는 제안만 적용하세요.</p></div>
        <div className="feature-grid">
          <article className="feature-card feature-lilac"><div className="feature-number">01 / 교정</div><div className="feature-visual spell-visual"><span className="spell-line">되<span className="red-underline">어있습니다</span><span className="spell-tip">되어 있습니다</span></span><span className="visual-check">✓</span></div><h3>놓치기 쉬운 맞춤법도</h3><p>띄어쓰기와 오탈자를 찾아 문장 위에서 바로 알려드려요.</p></article>
          <article className="feature-card feature-yellow"><div className="feature-number">02 / 윤문</div><div className="feature-visual polish-visual"><span>더 <b>읽기 좋은</b><br />문장으로</span><span className="polish-arrow">↗</span></div><h3>내 말투는 살리고, 더 자연스럽게</h3><p>문맥을 살펴 어색한 표현과 문장 흐름을 부드럽게 다듬어요.</p></article>
          <article className="feature-card feature-green"><div className="feature-number">03 / 선택 적용</div><div className="feature-visual choice-visual"><span className="choice-pill">원문 유지</span><span className="choice-pill chosen">제안 적용 <b>✓</b></span><span className="choice-cursor">↖</span></div><h3>마지막 선택은 언제나 나에게</h3><p>제안을 하나씩 확인하고, 마음에 드는 수정만 직접 적용하세요.</p></article>
        </div>
      </section>

      <section className="landing-final"><div className="final-spark">✳</div><span className="section-label">YOUR NEXT SENTENCE STARTS HERE</span><h2>좋은 문장은<br /><em>쓰는 사람을 닮으니까.</em></h2><p>당신의 목소리로, 더 매끄럽게 써보세요.</p><a className="primary-cta" href="/editor">지금 글 다듬기 <span>→</span></a></section>
      <footer className="landing-footer"><a className="landing-brand" href="/"><span className="brand-mark">f.</span> fastedit</a><span>© 2026 fastedit</span></footer>
    </main>
  );
}

export function App() {
  return window.location.pathname === '/editor' ? <EditorApp /> : <LandingPage />;
}
