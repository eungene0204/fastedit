import type { ChatMessage, ModelSpec } from '../types.ts';

export type LlmErrorKind = 'rate_limit' | 'server' | 'timeout' | 'empty' | 'client' | 'network' | 'aborted' | 'parse';

export class LlmError extends Error {
  kind: LlmErrorKind;
  status?: number;
  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
  }
}

export interface LlmRequest {
  model: ModelSpec;
  messages: ChatMessage[];
  temperature?: number;
  dataCollection: 'allow' | 'deny';
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResult {
  content: string;
  /** 응답에 적힌 실제 모델 ID */
  model: string;
  usage: TokenUsage;
  latencyMs: number;
  firstTokenMs?: number;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResult>;
  /** SSE 스트림. 델타를 흘려보내고 끝나면 전체 결과를 돌려준다 */
  stream(req: LlmRequest): AsyncGenerator<string, LlmResult>;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
  fetch?: typeof fetch;
}

const ZERO: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function statusKind(status: number): LlmErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  return 'client';
}

interface ApiError {
  code?: number | string;
  message?: string;
}

function usageOf(u?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): TokenUsage {
  if (!u) return ZERO;
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: u.total_tokens ?? promptTokens + completionTokens };
}

export class OpenRouterClient implements LlmClient {
  private opts: ClientOptions;
  private fetchFn: typeof fetch;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private body(req: LlmRequest, stream: boolean) {
    const m = req.model;
    return JSON.stringify({
      ...m.extraBody,
      model: m.id,
      messages: req.messages,
      temperature: req.temperature ?? 0,
      max_tokens: m.maxOutputTokens,
      ...(m.supportsJsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(stream ? { stream: true } : {}),
      provider: { data_collection: req.dataCollection },
    });
  }

  /** 총 시간 제한과 호출자 취소를 하나의 신호로 묶는다. 어느 쪽이 원인인지 구분할 수 있다 */
  private guard(req: LlmRequest, withFirstToken: boolean) {
    const ctrl = new AbortController();
    let timedOut = false;
    const fire = () => {
      timedOut = true;
      ctrl.abort();
    };
    const total = setTimeout(fire, this.opts.totalTimeoutMs);
    let first = withFirstToken ? setTimeout(fire, this.opts.firstTokenTimeoutMs) : undefined;
    const onAbort = () => ctrl.abort();
    if (req.signal?.aborted) ctrl.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    return {
      signal: ctrl.signal,
      gotFirstToken: () => {
        clearTimeout(first);
        first = undefined;
      },
      done: () => {
        clearTimeout(total);
        clearTimeout(first);
        req.signal?.removeEventListener('abort', onAbort);
      },
      toError: (err: unknown): LlmError => {
        if (err instanceof LlmError) return err;
        if (timedOut) return new LlmError('timeout', '모델 응답 시간 초과');
        if (req.signal?.aborted || ctrl.signal.aborted) return new LlmError('aborted', '요청이 취소되었습니다');
        return new LlmError('network', `네트워크 오류: ${(err as Error).message}`);
      },
    };
  }

  private async post(req: LlmRequest, stream: boolean, signal: AbortSignal): Promise<Response> {
    return this.fetchFn(`${this.opts.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'fastedit' },
      body: this.body(req, stream),
      signal,
    });
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const g = this.guard(req, false);
    const started = Date.now();
    try {
      const res = await this.post(req, false, g.signal);
      const body = (await res.json().catch(() => ({}))) as {
        error?: ApiError;
        model?: string;
        usage?: Parameters<typeof usageOf>[0];
        choices?: { message?: { content?: string | null } }[];
      };
      if (!res.ok || body.error) {
        const status = Number(body.error?.code) || res.status;
        throw new LlmError(statusKind(status), `${req.model.id}: ${status} ${body.error?.message ?? res.statusText}`, status);
      }
      const content = body.choices?.[0]?.message?.content;
      if (!content?.trim()) throw new LlmError('empty', `${req.model.id}: 빈 응답`);
      return { content, model: body.model ?? req.model.id, usage: usageOf(body.usage), latencyMs: Date.now() - started };
    } catch (err) {
      throw g.toError(err);
    } finally {
      g.done();
    }
  }

  async *stream(req: LlmRequest): AsyncGenerator<string, LlmResult> {
    const g = this.guard(req, true);
    const started = Date.now();
    try {
      const res = await this.post(req, true, g.signal);
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: ApiError };
        const status = Number(body.error?.code) || res.status;
        throw new LlmError(statusKind(status), `${req.model.id}: ${status} ${body.error?.message ?? res.statusText}`, status);
      }
      let content = '';
      let model = req.model.id;
      let usage = ZERO;
      let firstTokenMs: number | undefined;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          // ": OPENROUTER PROCESSING" 같은 주석 줄과 빈 줄은 무시한다
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let chunk: {
            error?: ApiError;
            model?: string;
            usage?: Parameters<typeof usageOf>[0];
            choices?: { delta?: { content?: string | null } }[];
          };
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.error) {
            const status = Number(chunk.error.code) || 502;
            throw new LlmError(statusKind(status), `${req.model.id}: ${status} ${chunk.error.message ?? '스트림 오류'}`, status);
          }
          if (chunk.model) model = chunk.model;
          if (chunk.usage) usage = usageOf(chunk.usage);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            if (firstTokenMs === undefined) {
              firstTokenMs = Date.now() - started;
              g.gotFirstToken();
            }
            content += delta;
            yield delta;
          }
        }
      }
      if (!content.trim()) throw new LlmError('empty', `${req.model.id}: 빈 응답`);
      return { content, model, usage, latencyMs: Date.now() - started, firstTokenMs };
    } catch (err) {
      throw g.toError(err);
    } finally {
      g.done();
    }
  }
}

/** stream()을 끝까지 읽어 전체 결과만 받는다 */
export async function collectStream(gen: AsyncGenerator<string, LlmResult>): Promise<LlmResult> {
  for (;;) {
    const r = await gen.next();
    if (r.done) return r.value;
  }
}
