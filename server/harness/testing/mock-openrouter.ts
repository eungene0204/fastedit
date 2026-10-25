import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// 테스트용 OpenRouter 목 서버: /chat/completions(스트리밍·비스트리밍)와 /models

export interface MockReply {
  /** 모델이 돌려줄 content */
  content?: string;
  /** HTTP 상태(기본 200). 200이 아니면 error 본문을 돌려준다 */
  status?: number;
  /** 응답 전 지연 */
  delayMs?: number;
  /** 스트림에서 첫 델타 전 지연 (첫 토큰 시간 초과 테스트) */
  firstTokenDelayMs?: number;
  /** 200 OK 본문 안에 error를 담는다 (OpenRouter가 종종 이렇게 돌려준다) */
  bodyError?: { code: number; message: string };
}

export interface MockRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  response_format?: unknown;
  provider?: { data_collection?: string };
  [k: string]: unknown;
}

export type MockHandler = (body: MockRequest, index: number) => MockReply | Promise<MockReply>;

export class MockOpenRouter {
  server: Server;
  requests: MockRequest[] = [];
  models: string[] = [];
  handler: MockHandler = () => ({ content: '{"suggestions":[]}' });

  constructor() {
    this.server = createServer((req, res) => void this.route(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    if (req.url === '/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: this.models.map((id) => ({ id })) }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as MockRequest;
    const index = this.requests.push(body) - 1;
    const reply = await this.handler(body, index);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if (reply.delayMs) await sleep(reply.delayMs);

    const status = reply.status ?? 200;
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: status, message: `mock ${status}` } }));
      return;
    }
    if (reply.bodyError) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: reply.bodyError }));
      return;
    }
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: reply.content ?? '' } }], usage }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': OPENROUTER PROCESSING\n\n');
    if (reply.firstTokenDelayMs) await sleep(reply.firstTokenDelayMs);
    const content = reply.content ?? '';
    // 일부러 토막 내서 보낸다
    for (let i = 0; i < content.length; i += 17) {
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: content.slice(i, i + 17) } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: {} }], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
}

/** 프롬프트에 들어간 [n] 문장 목록을 꺼낸다 */
export function sentencesOf(body: MockRequest): string[] {
  const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
  return [...user.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => m[2]);
}
