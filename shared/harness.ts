// 모델 하네스 v1 API 타입 (클라이언트·서버 공용)

export type HarnessTask = 'spell' | 'polish';
export type HarnessStrength = 'light' | 'normal' | 'strong';
export type HarnessLanguage = 'ko' | 'en';
export type HarnessTone = 'polite' | 'concise' | 'simple' | 'formal';
/** user = 사용자가 직접 누른 요청, auto = 자동 윤문 등 백그라운드 요청 */
export type HarnessPriority = 'user' | 'auto';

export type HarnessSuggestionType = 'error' | 'clarity' | 'tone';
export type HarnessCategory =
  | 'spelling'
  | 'spacing'
  | 'grammar'
  | 'punctuation'
  | 'concision'
  | 'readability'
  | 'word_choice'
  | 'formality'
  | 'politeness';

export interface HarnessSuggestion {
  id: string;
  type: HarnessSuggestionType;
  category: HarnessCategory;
  /** 요청 text 기준 문자 오프셋. 모델이 아니라 하네스가 계산한다 */
  start: number;
  end: number;
  original: string;
  replacement: string;
  reason: string;
  confidence: number;
  model: string;
  promptVersion: string;
}

export type DegradedReason = 'llm_disabled' | 'throttled' | 'quota_exhausted' | 'no_model' | 'all_failed';

export interface HarnessMeta {
  cached: number;
  modelCalls: number;
  latencyMs: number;
  degraded: boolean;
  reason?: DegradedReason;
}

export interface SuggestRequest {
  requestId?: string;
  docVersion: number;
  text: string;
  task: HarnessTask;
  strength?: HarnessStrength;
  /** auto = 문장별 감지 */
  language?: HarnessLanguage | 'auto';
  priority?: HarnessPriority;
  /** 사용자 사전: 바꾸면 안 되는 고유명사 */
  dictionary?: string[];
  stream?: boolean;
}

export interface SuggestResponse {
  requestId: string;
  docVersion: number;
  suggestions: HarnessSuggestion[];
  meta: HarnessMeta;
}

/** stream=true일 때 NDJSON으로 흐르는 이벤트 */
export type SuggestEvent =
  | { kind: 'suggestions'; requestId: string; docVersion: number; suggestions: HarnessSuggestion[]; cached: boolean }
  | { kind: 'done'; response: SuggestResponse };

export interface AlternativesRequest {
  requestId?: string;
  text: string;
  tone: HarnessTone;
  n?: number;
  language?: HarnessLanguage | 'auto';
  priority?: HarnessPriority;
  dictionary?: string[];
}

export interface AlternativesResponse {
  requestId: string;
  alternatives: { text: string; note: string }[];
  model?: string;
  promptVersion: string;
  meta: HarnessMeta;
}

export interface FeedbackEvent {
  suggestionId: string;
  action: 'accept' | 'reject';
  model: string;
  promptVersion: string;
}
