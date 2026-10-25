import type { HarnessLanguage } from '../../../shared/harness.ts';

/** 글자 중 한글 비율로 언어를 고른다 (한국어 우선) */
export function detectLanguage(text: string): HarnessLanguage {
  const hangul = (text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return hangul >= 2 && hangul >= latin * 0.25 ? 'ko' : latin > 0 ? 'en' : 'ko';
}

/** 교정할 글자가 하나도 없는 문장(기호·숫자뿐)인지 */
export const hasLetters = (text: string) => /[\p{L}]/u.test(text);
