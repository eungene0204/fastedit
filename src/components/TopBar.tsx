import type { Strength } from '../../shared/types.ts';
import { STRENGTHS } from '../labels.ts';

interface Props {
  title: string;
  onTitle: (v: string) => void;
  strength: Strength;
  onStrength: (v: Strength) => void;
  onCopy: () => void;
  onExport: () => void;
}

export function TopBar(p: Props) {
  return (
    <header className="topbar">
      <div className="brand" aria-hidden>
        <span className="logo">f</span>
      </div>
      <input className="title" value={p.title} onChange={(e) => p.onTitle(e.target.value)} aria-label="문서 제목" />
      <div className="controls">
        <div className="segmented" role="radiogroup" aria-label="교정 강도">
          {STRENGTHS.map((s) => (
            <button
              key={s.value}
              role="radio"
              aria-checked={p.strength === s.value}
              className={p.strength === s.value ? 'on' : ''}
              title={s.hint}
              onClick={() => p.onStrength(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button className="ghost" onClick={p.onCopy} title="본문 복사">
          복사
        </button>
        <button className="ghost" onClick={p.onExport} title=".txt로 내보내기">
          내보내기
        </button>
      </div>
    </header>
  );
}
