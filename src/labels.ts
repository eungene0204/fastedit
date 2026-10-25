import type { RewriteStyle, Strength, SuggestionType, Tone } from '../shared/types.ts';

export const TYPE_LABEL: Record<SuggestionType, string> = { error: '오류', clarity: '명확성', tone: '어조' };

export const STRENGTHS: { value: Strength; label: string; hint: string }[] = [
  { value: 'spell', label: '맞춤법만', hint: '맞춤법·띄어쓰기·문법 오류만 고칩니다' },
  { value: 'basic', label: '기본', hint: '오류와 명백히 어색한 표현을 고칩니다' },
  { value: 'aggressive', label: '적극 윤문', hint: '간결성·가독성·어조까지 적극 제안합니다' },
];

export const TONES: { value: Tone; label: string }[] = [
  { value: 'none', label: '어조 유지' },
  { value: 'polite', label: '공손하게' },
  { value: 'concise', label: '간결하게' },
  { value: 'easy', label: '쉽게' },
  { value: 'formal', label: '격식 있게' },
];

export const REWRITE_STYLES: { value: RewriteStyle; label: string }[] = [
  { value: 'concise', label: '더 간결하게' },
  { value: 'polite', label: '더 공손하게' },
  { value: 'easy', label: '더 쉽게' },
  { value: 'formal', label: '격식 있게' },
];

export const SAMPLE = `안녕하세요, 팀장님. 다음주 회의 일정 관련해서 말씀드립니다.

내일 회의는 몇일에 하는지 알려주시면 감사하겠읍니다. 그리고 자료에 대한 준비는 제가 준비를 할께요.

이번 프로젝트는 일정이 너무 촉박해서 사실상 기한 내에 완료하는것이 어려울 것으로 보여지는 상황입니다. 그래서 일정 조정이 필요할수있다고 생각됩니다.

검토 부탁드리고, 궁금하신 점은 언제든 연락 주세요.`;
