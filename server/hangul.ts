const BASE = 0xac00;
const LAST = 0xd7a3;

/** 한글 음절의 받침 인덱스 (0 = 받침 없음, 8 = ㄹ, 4 = ㄴ). 한글이 아니면 -1 */
export function jongseong(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code < BASE || code > LAST) return -1;
  return (code - BASE) % 28;
}

export const JONG_N = 4;
export const JONG_L = 8;
