import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessLanguage, HarnessStrength, HarnessTone } from '../../../shared/harness.ts';
import type { ChatMessage, Task } from '../types.ts';

export interface PromptInput {
  task: Task;
  lang: HarnessLanguage;
  strength?: HarnessStrength;
  tone?: HarnessTone;
  n?: number;
  /** spell·polish: 모델에 보낼 문장들 (번호는 1부터 자동으로 붙는다) */
  sentences?: string[];
  /** tone: 사용자가 선택한 구간 */
  selectedText?: string;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  /** 예: polish@v1 */
  version: string;
}

interface Template {
  version: string;
  system: string;
  user: string;
}

const LANGUAGE_LABEL: Record<HarnessLanguage, string> = { ko: '한국어', en: 'English' };
const TEXT_MARK = '<text>';

/** 입력 안의 <text>·</text>가 구분자를 닫지 못하게 한다 (프롬프트 인젝션 방어) */
export function sanitizeInput(s: string): string {
  return s.replace(/<(\s*\/?\s*text\s*)>/gi, '‹$1›');
}

export function numberSentences(sentences: string[]): string {
  return sentences.map((s, i) => `[${i + 1}] ${sanitizeInput(s)}`).join('\n');
}

export class PromptBuilder {
  private templates = new Map<string, Template>();

  /** dir/<lang>/<task>.<version>.md 파일을 모두 읽는다. 같은 작업에서 가장 높은 버전을 쓴다 */
  constructor(dir = process.env.FASTEDIT_PROMPTS_DIR ?? 'prompts') {
    for (const lang of readdirSync(dir)) {
      for (const file of readdirSync(join(dir, lang))) {
        const m = /^(\w+)\.(v\d+)\.md$/.exec(file);
        if (!m) continue;
        const body = readFileSync(join(dir, lang, file), 'utf8').trim();
        // 규칙 설명에도 <text>가 나오므로, 입력 블록을 여는 마지막 줄 머리의 구분자를 찾는다
        const at = body.lastIndexOf(`\n${TEXT_MARK}`) + 1;
        if (at === 0) throw new Error(`${lang}/${file}: ${TEXT_MARK} 구분자가 없습니다`);
        const key = `${m[1]}:${lang}`;
        const prev = this.templates.get(key);
        if (prev && Number(prev.version.split('@v')[1]) > Number(m[2].slice(1))) continue;
        this.templates.set(key, { version: `${m[1]}@${m[2]}`, system: body.slice(0, at).trim(), user: body.slice(at) });
      }
    }
  }

  /** 프롬프트 버전 문자열 (캐시 키와 응답에 쓴다) */
  version(task: Task, lang: HarnessLanguage): string {
    return this.get(task, lang).version;
  }

  private get(task: Task, lang: HarnessLanguage): Template {
    const t = this.templates.get(`${task}:${lang}`);
    if (!t) throw new Error(`프롬프트 템플릿이 없습니다: ${task}/${lang}`);
    return t;
  }

  build(input: PromptInput): BuiltPrompt {
    const t = this.get(input.task, input.lang);
    const vars: Record<string, string> = {
      strength: input.strength ?? 'normal',
      language: LANGUAGE_LABEL[input.lang],
      tone: input.tone ?? '',
      n: String(input.n ?? 3),
      numbered_sentences: numberSentences(input.sentences ?? []),
      selected_text: sanitizeInput(input.selectedText ?? ''),
    };
    const fill = (s: string, user: boolean) =>
      s.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
        if (!(name in vars)) throw new Error(`${t.version}: 알 수 없는 템플릿 변수 {{${name}}}`);
        // 사용자 입력이 들어가는 변수는 user 메시지에서만 채운다
        if (!user && (name === 'numbered_sentences' || name === 'selected_text')) return '';
        return vars[name];
      });
    return {
      version: t.version,
      messages: [
        { role: 'system', content: fill(t.system, false) },
        { role: 'user', content: fill(t.user, true) },
      ],
    };
  }
}
