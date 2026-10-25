// 제안이 원문의 "건드리면 안 되는 것"을 보존했는지 검사하는 순수 함수들.
// 수정 전·후 문장에서 같은 종류의 토큰을 뽑아 개수를 비교한다.

const NUMBER_RE = /\d+(?:[.,:/]\d+)*/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'‘’“”]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PLACEHOLDER_RE = /⟦PII_\d+⟧/g;
const CAP_WORD_RE = /(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9]*/g;

const QUOTE_RES = [
  /"[^"\n]+"/g,
  /“[^”\n]+”/g,
  /‘[^’\n]+’/g,
  /「[^」\n]+」/g,
  /『[^』\n]+』/g,
  // 아포스트로피(don't)와 구분하기 위해 앞뒤가 글자·숫자가 아닐 때만 따옴표로 본다
  /(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])/gu,
];

function bump(m: Map<string, number>, key: string) {
  m.set(key, (m.get(key) ?? 0) + 1);
}

/** 숫자·날짜·금액·URL·이메일·자리표시자: 수정 전후에 정확히 같아야 한다 */
export function exactTokens(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of s.matchAll(PLACEHOLDER_RE)) bump(m, `ph:${x[0]}`);
  for (const x of s.matchAll(URL_RE)) bump(m, `url:${x[0].replace(/[.,;:!?)\]]+$/, '')}`);
  for (const x of s.matchAll(EMAIL_RE)) bump(m, `email:${x[0]}`);
  for (const x of s.matchAll(NUMBER_RE)) bump(m, `num:${x[0]}`);
  return m;
}

/** 따옴표 안 인용문 */
export function quotedSegments(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const re of QUOTE_RES) for (const x of s.matchAll(re)) bump(m, `q:${x[0]}`);
  return m;
}

/** 고유명사: 사용자 사전 + 문장 중간의 영문 대문자 단어. 줄어들면 안 된다 */
export function properNouns(s: string, dictionary: string[], includeFirst = false): Map<string, number> {
  const m = new Map<string, number>();
  for (const term of dictionary) {
    if (!term) continue;
    const n = s.split(term).length - 1;
    if (n) m.set(`dict:${term}`, n);
  }
  // 문장 첫 단어는 문법상 대문자이므로 고유명사로 보지 않는다
  const first = s.search(/\p{L}/u);
  for (const x of s.matchAll(CAP_WORD_RE)) if (includeFirst || x.index !== first) bump(m, `cap:${x[0]}`);
  return m;
}

export function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** b에서 a의 모든 항목이 줄어들지 않았는지 */
export function notReduced(before: Map<string, number>, after: Map<string, number>): boolean {
  for (const [k, v] of before) if ((after.get(k) ?? 0) < v) return false;
  return true;
}

export function applyEdit(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

/** text에서 needle의 n번째(1부터) 등장 위치. 없으면 -1 */
export function nthIndexOf(text: string, needle: string, n: number): number {
  let at = -1;
  for (let i = 0; i < n; i++) {
    at = text.indexOf(needle, at + 1);
    if (at === -1) return -1;
  }
  return at;
}
