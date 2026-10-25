// 문단 → 문장 분할. 문장 오프셋은 원문 기준이다.

export interface Span {
  start: number;
  end: number;
  text: string;
}

const TERMINATORS = new Set(['.', '?', '!', '…', '。', '？', '！']);
const CLOSERS = new Set(['"', '”', '’', '」', '』', ')', ']', '）']);
const OPEN_CLOSE: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '(': ')', '[': ']', '（': '）' };
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc', 'inc', 'ltd', 'st', 'no', 'e.g', 'i.e', 'fig', 'approx']);
const isHangul = (ch: string | undefined) => !!ch && /[가-힣]/.test(ch);

/** 줄바꿈으로 나뉜 각 줄(문단)을 반환한다. 빈 줄은 제외한다 */
export function splitParagraphs(text: string): Span[] {
  const out: Span[] = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    const lead = line.length - line.trimStart().length;
    const body = line.trim();
    if (body) out.push({ start: pos + lead, end: pos + lead + body.length, text: body });
    pos += line.length + 1;
  }
  return out;
}

function splitParagraph(p: Span): Span[] {
  const s = p.text;
  const out: Span[] = [];
  const stack: string[] = [];
  let from = 0;

  const push = (to: number) => {
    const raw = s.slice(from, to);
    const trimmed = raw.trim();
    if (trimmed) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ start: p.start + from + lead, end: p.start + from + lead + trimmed.length, text: trimmed });
    }
    from = to;
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // 짝이 있는 따옴표·괄호 안에서는 문장을 끊지 않는다
    if (stack.length && ch === stack[stack.length - 1]) {
      stack.pop();
      continue;
    }
    if (OPEN_CLOSE[ch]) {
      stack.push(OPEN_CLOSE[ch]);
      continue;
    }
    if (ch === '"') {
      // 곧은 큰따옴표는 열고 닫는 모양이 같으므로 토글
      if (stack[stack.length - 1] === '"') stack.pop();
      else stack.push('"');
      continue;
    }
    if (stack.length || !TERMINATORS.has(ch)) continue;

    // 종결 부호 묶음(?!, ..., 등)과 뒤따르는 닫는 따옴표를 문장에 포함한다
    let end = i + 1;
    while (end < s.length && TERMINATORS.has(s[end])) end++;
    while (end < s.length && CLOSERS.has(s[end])) end++;
    const next = s[end];

    if (ch === '.') {
      const prevWord = /([A-Za-z.]+)$/.exec(s.slice(0, i))?.[1]?.toLowerCase();
      if (prevWord && ABBREVIATIONS.has(prevWord)) continue;
      // 숫자 사이의 소수점, 도메인·파일명의 점
      if (next !== undefined && !/\s/.test(next) && !(isHangul(s[i - 1]) && isHangul(next))) continue;
    } else if (next !== undefined && !/\s/.test(next) && !isHangul(next) && !/[A-Z"“‘「『(]/.test(next)) {
      continue;
    }
    push(end);
    i = end - 1;
  }
  push(s.length);
  return out;
}

/** 원문을 문장 단위로 쪼갠다 (문단 → 문장). 문장이 줄바꿈을 넘지 않는다 */
export function splitSentences(text: string): Span[] {
  return splitParagraphs(text).flatMap(splitParagraph);
}
