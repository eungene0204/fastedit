import type { CheckEvent, CheckRequest, RewriteRequest, RewriteResponse, StatusResponse } from '../../shared/types.ts';

export async function getStatus(): Promise<StatusResponse> {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error('서버에 연결할 수 없습니다');
  return res.json();
}

/** NDJSON 스트림을 읽어 이벤트가 도착하는 대로 콜백한다 */
export async function streamCheck(req: CheckRequest, onEvent: (ev: CheckEvent) => void, signal?: AbortSignal) {
  const res = await fetch('/api/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`검사 요청 실패 (${res.status})`);
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
      if (line) onEvent(JSON.parse(line) as CheckEvent);
    }
  }
}

export async function rewrite(req: RewriteRequest, signal?: AbortSignal): Promise<RewriteResponse> {
  const res = await fetch('/api/rewrite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `다듬기 요청 실패 (${res.status})`);
  return body;
}
