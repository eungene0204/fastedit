// 클라이언트와 서버가 함께 쓰는 API 타입

export type SuggestionType = 'error' | 'clarity' | 'tone';
export type Strength = 'spell' | 'basic' | 'aggressive';
export type Tone = 'none' | 'polite' | 'concise' | 'easy' | 'formal';
export type RewriteStyle = Exclude<Tone, 'none'>;

/** 블록(문단) 텍스트 기준 문자 오프셋 */
export interface Suggestion {
  from: number;
  to: number;
  original: string;
  replacement: string;
  reason: string;
  type: SuggestionType;
  source: 'rule' | 'llm';
}

export interface CheckBlock {
  id: string;
  text: string;
  /** 앞 문단 (문맥 참고용, 수정 대상 아님) */
  context?: string;
}

export interface CheckRequest {
  strength: Strength;
  tone: Tone;
  blocks: CheckBlock[];
}

/** /api/check 응답은 이 이벤트들의 NDJSON 스트림 */
export type CheckEvent =
  | { kind: 'result'; id: string; phase: 'fast' | 'llm'; suggestions: Suggestion[]; model?: string }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'done' };

export interface RewriteRequest {
  text: string;
  style: RewriteStyle | 'all';
  context?: string;
  /** 최종본 다듬기에 쓸 현재 교정 설정 */
  strength?: Strength;
  tone?: Tone;
}

export interface RewriteResponse {
  alternatives: { style: RewriteStyle; text: string; reason: string }[];
  model?: string;
}

export interface StatusResponse {
  llm: boolean;
  models: string[];
}
