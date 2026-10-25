// 모델 출력에서 JSON을 꺼낸다. 코드 블록·앞뒤 설명문·후행 쉼표·잘린 출력을 복구한다.

/** `start`에서 시작하는 첫 번째 완결된 {...} 또는 [...] 구간의 끝 위치(포함). 문자열 안의 괄호는 무시한다 */
function balancedEnd(s: string, start: number): number {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/** 문자열 밖의 후행 쉼표를 지우고, 문자열 안의 제어 문자를 공백으로 바꾼다 */
function repair(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') {
        out += ch + (s[++i] ?? '');
        continue;
      }
      if (ch === '"') inStr = false;
      out += /[\u0000-\u001f]/.test(ch) ? ' ' : ch;
      continue;
    }
    if (ch === '"') inStr = true;
    if (ch === ',') {
      const rest = s.slice(i + 1).trimStart();
      if (rest[0] === '}' || rest[0] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function tryParse(body: string): { ok: true; value: unknown } | { ok: false } {
  for (const candidate of [body, repair(body)]) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // 다음 후보
    }
  }
  return { ok: false };
}

/** 본문에서 가장 먼저 파싱되는 JSON 객체/배열. 없으면 null */
export function extractJson(content: string): unknown | null {
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{' && content[i] !== '[') continue;
    const end = balancedEnd(content, i);
    if (end === -1) continue;
    const r = tryParse(content.slice(i, end + 1));
    if (r.ok && typeof r.value === 'object' && r.value !== null) return r.value;
  }
  return null;
}

/**
 * 제안 배열을 꺼낸다. 전체 JSON이 깨졌어도(예: 출력이 중간에 잘림) 완결된 개별 객체는 살린다.
 * 복구할 수 없으면 null — 호출한 쪽에서 이 배치를 실패로 처리한다.
 */
export function extractItems(content: string, key: 'suggestions' | 'alternatives'): unknown[] | null {
  const whole = extractJson(content);
  if (Array.isArray(whole)) return whole;
  if (whole && typeof whole === 'object') {
    const list = (whole as Record<string, unknown>)[key];
    if (Array.isArray(list)) return list;
    if (list === undefined && Object.keys(whole).length === 0) return [];
  }

  const at = content.indexOf(`"${key}"`);
  if (at === -1) return null;
  const arr = content.indexOf('[', at);
  if (arr === -1) return null;
  const items: unknown[] = [];
  for (let i = arr + 1; i < content.length; i++) {
    if (content[i] !== '{') continue;
    const end = balancedEnd(content, i);
    if (end === -1) break;
    const r = tryParse(content.slice(i, end + 1));
    if (r.ok) items.push(r.value);
    i = end;
  }
  // 배열이 열려 있기만 하고 객체가 없으면, 비어 있는 것인지 깨진 것인지 알 수 없으므로 실패
  return items.length ? items : /\[\s*\]/.test(content.slice(arr, arr + 8)) ? [] : null;
}
