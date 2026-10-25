import type { Suggestion } from '../shared/types.ts';
import { jongseong, JONG_L, JONG_N } from './hangul.ts';

// 자체 경량 교정 모델 자리를 대신하는 규칙 기반 검사기.
// 정답이 분명한 오류만 다뤄 오탐을 줄인다.

interface Rule {
  pattern: RegExp;
  replace: (m: RegExpExecArray) => string | null;
  reason: string;
}

const word = (map: Record<string, string>, reason: string): Rule => ({
  pattern: new RegExp(Object.keys(map).join('|'), 'g'),
  replace: (m) => map[m[0]],
  reason,
});

const RULES: Rule[] = [
  word({ '몇일': '며칠', '몇 일': '며칠' }, "'며칠'이 표준어입니다 (표준어 규정)."),
  word(
    {
      '어떻해': '어떡해',
      '왠만': '웬만',
      '웬지': '왠지',
      '금새': '금세',
      '설겆이': '설거지',
      '희안': '희한',
      '어의없': '어이없',
      '일일히': '일일이',
      '깨끗히': '깨끗이',
      '오랫만': '오랜만',
      '역활': '역할',
      '문안하': '무난하',
      '됬': '됐',
      '되요': '돼요',
      '되서': '돼서',
      '안되요': '안 돼요',
      '할려고': '하려고',
      '갈려고': '가려고',
      '볼려고': '보려고',
      '될려고': '되려고',
      '먹을려고': '먹으려고',
    },
    '자주 틀리는 표기입니다 (한글 맞춤법).',
  ),
  {
    pattern: /([가-힣]+)읍니다/g,
    replace: (m) => `${m[1]}습니다`,
    reason: "'-읍니다'는 '-습니다'로 적습니다 (1988년 맞춤법 개정).",
  },
  {
    // 할께, 갈께요 → 할게, 갈게요
    pattern: /([가-힣])께(요)?(?=[\s.,!?~]|$)/g,
    replace: (m) => (jongseong(m[1]) === JONG_L ? `${m[1]}게${m[2] ?? ''}` : null),
    reason: "어미 '-ㄹ게'는 [께]로 소리 나도 '게'로 적습니다 (한글 맞춤법 제53항).",
  },
  {
    pattern: /않(하|해|했|돼|되)/g,
    replace: (m) => `안 ${m[1]}`,
    reason: "부정 부사는 '안'이며 뒷말과 띄어 씁니다. '않'은 '아니하'의 준말입니다.",
  },
  {
    // 할수있다 → 할 수 있다 (관형형 + 의존 명사)
    pattern: /([가-힣])(수|줄|것)(있|없)/g,
    replace: (m) => {
      const j = jongseong(m[1]);
      return j === JONG_L || j === JONG_N ? `${m[1]} ${m[2]} ${m[3]}` : null;
    },
    reason: '의존 명사는 앞말과 띄어 씁니다 (한글 맞춤법 제42항).',
  },
  {
    pattern: /([^\s]) {2,}(?=[^\s])/g,
    replace: (m) => `${m[1]} `,
    reason: '띄어쓰기는 한 칸이면 충분합니다.',
  },
  {
    // 말줄임표(...)는 건드리지 않는다
    pattern: /([^\s.])\.\.(?=\s|$)/g,
    replace: (m) => `${m[1]}.`,
    reason: '마침표가 겹쳤습니다.',
  },
  {
    pattern: /([가-힣a-zA-Z0-9]) +([,.!?])(?=\s|$)/g,
    replace: (m) => `${m[1]}${m[2]}`,
    reason: '문장 부호는 앞말에 붙여 씁니다.',
  },
];

export function runRules(text: string): Suggestion[] {
  const found: Suggestion[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text))) {
      const replacement = rule.replace(m);
      if (replacement === null || replacement === m[0]) continue;
      found.push({
        from: m.index,
        to: m.index + m[0].length,
        original: m[0],
        replacement,
        reason: rule.reason,
        type: 'error',
        source: 'rule',
      });
    }
  }
  return dropOverlaps(found);
}

/** 겹치는 제안은 먼저 온 것(우선순위가 높은 것)만 남긴다. 결과는 위치순 */
export function dropOverlaps<T extends { from: number; to: number }>(items: T[], taken: T[] = []): T[] {
  const kept: T[] = [];
  for (const s of items) {
    const clash = [...taken, ...kept].some((k) => s.from < k.to && k.from < s.to);
    if (!clash) kept.push(s);
  }
  return kept.sort((a, b) => a.from - b.from);
}
