// 외부 LLM으로 보내기 전에 민감정보를 ⟦PII_n⟧ 자리표시자로 바꾸고, 결과에서 되돌린다.

export const PLACEHOLDER_RE = /⟦PII_\d+⟧/g;

interface Pattern {
  re: RegExp;
  accept?: (m: string) => boolean;
}

const digits = (s: string) => s.replace(/\D/g, '').length;

// 앞쪽 패턴이 같은 구간에서 우선한다
const PATTERNS: Pattern[] = [
  { re: /(?<!\d)\d{6}-?[1-4]\d{6}(?!\d)/g }, // 주민등록번호
  { re: /(?<!\d)\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}(?!\d)|(?<!\d)\d{16}(?!\d)/g }, // 카드번호
  { re: /(?<!\d)01[016789][- ]?\d{3,4}[- ]?\d{4}(?!\d)/g }, // 휴대전화
  { re: /(?<!\d)0\d{1,2}-\d{3,4}-\d{4}(?!\d)/g }, // 유선전화
  { re: /\+\d{1,3}[ -]?\(?\d{1,4}\)?(?:[ -]?\d{2,4}){2,3}(?!\d)/g }, // 국제 전화
  { re: /(?<!\d)\(?\d{3}\)?[ -]\d{3}-\d{4}(?!\d)/g }, // 미국식 전화
  { re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g }, // 이메일
  // 계좌번호: 하이픈으로 나뉜 10~14자리 (날짜 2024-05-03 같은 8자리는 제외)
  { re: /(?<!\d)\d{2,6}(?:-\d{2,8}){2,3}(?!\d)/g, accept: (m) => digits(m) >= 10 && digits(m) <= 16 },
  { re: /(?<![\d,.])\d{10,14}(?![\d,.])/g }, // 구분 없는 긴 숫자열
];

export interface PiiSegment {
  /** 마스킹된 텍스트에서의 위치 */
  mStart: number;
  mEnd: number;
  /** 원문에서의 위치 */
  oStart: number;
  oEnd: number;
}

export interface Masked {
  text: string;
  /** 자리표시자 → 원래 값 */
  tokens: Map<string, string>;
  segments: PiiSegment[];
}

/** counter는 한 요청 안에서 자리표시자 번호가 겹치지 않게 공유한다 */
export function maskPii(text: string, counter: { n: number } = { n: 0 }): Masked {
  const hits: { start: number; end: number }[] = [];
  for (const { re, accept } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (accept && !accept(m[0])) continue;
      if (hits.some((h) => start < h.end && h.start < end)) continue;
      hits.push({ start, end });
    }
  }
  hits.sort((a, b) => a.start - b.start);

  const tokens = new Map<string, string>();
  const segments: PiiSegment[] = [];
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    out += text.slice(cursor, h.start);
    const token = `⟦PII_${++counter.n}⟧`;
    tokens.set(token, text.slice(h.start, h.end));
    segments.push({ mStart: out.length, mEnd: out.length + token.length, oStart: h.start, oEnd: h.end });
    out += token;
    cursor = h.end;
  }
  out += text.slice(cursor);
  return { text: out, tokens, segments };
}

export function unmaskPii(text: string, tokens: Map<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (t) => tokens.get(t) ?? t);
}

/** 마스킹된 범위 [ms, me)를 원문 범위로 바꾼다. 자리표시자를 가로지르면 null */
export function toOriginalRange(segments: PiiSegment[], ms: number, me: number): [number, number] | null {
  // delta = 원문 길이 - 마스킹 길이
  let startDelta = 0;
  let endDelta = 0;
  for (const s of segments) {
    if ((ms > s.mStart && ms < s.mEnd) || (me > s.mStart && me < s.mEnd)) return null;
    if (s.mEnd <= ms) startDelta += s.oEnd - s.oStart - (s.mEnd - s.mStart);
    if (s.mEnd <= me) endDelta += s.oEnd - s.oStart - (s.mEnd - s.mStart);
  }
  return [ms + startDelta, me + endDelta];
}
