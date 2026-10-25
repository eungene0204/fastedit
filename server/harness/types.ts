import type { HarnessLanguage, HarnessPriority, HarnessStrength, HarnessTone } from '../../shared/harness.ts';

export type {
  AlternativesRequest,
  AlternativesResponse,
  DegradedReason,
  FeedbackEvent,
  HarnessCategory,
  HarnessMeta,
  HarnessPriority,
  HarnessSuggestion,
  HarnessSuggestionType,
  HarnessTask,
  HarnessLanguage,
  HarnessStrength,
  HarnessTone,
  SuggestEvent,
  SuggestRequest,
  SuggestResponse,
} from '../../shared/harness.ts';

export type Task = 'spell' | 'polish' | 'tone';
export type Tier = 'free' | 'paid';
export type DataPolicy = 'no-train' | 'retain' | 'may-train' | 'unknown';

export interface ModelSpec {
  id: string;
  tier: Tier;
  tasks: Task[];
  supportsJsonMode: boolean;
  supportsStreaming: boolean;
  contextLength: number;
  maxOutputTokens: number;
  dataPolicy: DataPolicy;
  priority: number;
  enabled: boolean;
  /** 요청 본문에 그대로 합칠 모델별 추가 파라미터 */
  extraBody?: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 모델에 보내는 한 문장 (원문 좌표계) */
export interface SentenceRef {
  index: number;
  start: number;
  end: number;
  text: string;
  lang: HarnessLanguage;
}

export interface RequestOptions {
  strength: HarnessStrength;
  priority: HarnessPriority;
  tone?: HarnessTone;
}
