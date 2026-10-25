# fastedit

쓰는 흐름을 끊지 않는 한국어·영어 실시간 교정·윤문 에디터.

## 실행

```bash
cp .env.example .env   # OPENROUTER_API_KEY 입력 (없으면 규칙 기반 교정만 동작)
npm install
npm run dev            # 서버 :8787 + 웹 :5173
```

| 명령 | 설명 |
|---|---|
| `npm test` | 단위·통합(목 서버) 테스트. 지연 목표 측정(`perf.test.ts`)도 포함 |
| `INTEGRATION=1 npm test` | 실제 Redis(`REDIS_URL`)·OpenRouter를 쓰는 테스트도 실행 |
| `npm run eval -- --task polish --model <id>` | 평가셋으로 모델·프롬프트 평가, 보고서 생성 |
| `npm run build && npm start` | 빌드 후 단일 서버(:8787)로 서비스 |

## 구조

```
config/models.yaml        모델 레지스트리·대체 체인·한도·타임아웃 (모델 ID는 여기에만 있다)
prompts/{ko,en}/*.v1.md   런타임 프롬프트 템플릿 (spell@v1, polish@v1, tone@v1)
shared/harness.ts         v1 API 타입
server/
  index.ts                HTTP 서버
  check.ts                편집기용 어댑터 (규칙 즉시 결과 + 하네스 결과)
  rules.ts                규칙 기반 즉시 교정
  harness/
    harness.ts            오케스트레이터: 캐시 → 마스킹 → 배치 → 모델 → 검증 → 조립
    registry/             모델 레지스트리, 하루 1회 /models 대조
    client/               OpenRouter 클라이언트 (SSE·비스트리밍, 오류 종류 구분, 타임아웃)
    governor/             요청 한도 관리자 (분·일 카운터, 80% 우선순위 컷)
    router/               대체 체인 실행 + 서킷 브레이커
    preprocess/           문장 분할, 민감정보 마스킹, 언어 감지, 배치 묶기
    prompts/              템플릿 로더·빌더 (버전, 인젝션 방어)
    validator/            JSON 복구, 제안별 검증, 위치 계산, 겹침 해소
    assembler/            최종 응답 조립
    cache/                AES-256-GCM 암호화 캐시
    telemetry/            요청 로그(원문 없음), 지표, 수락률 집계
    store/                Redis / 인메모리 저장소
eval/                     평가 하네스 (datasets/*.jsonl, reports/)
src/                      에디터 프런트엔드
```

## 모델 하네스

요청 하나의 흐름:

1. 문단 → 문장 분할 (따옴표 짝·약어·소수점 고려), 문장마다 언어 감지(ko/en)
2. 문장 해시로 **캐시 조회** — 적중한 문장은 모델을 부르지 않는다 (제안이 없다는 결과도 캐시)
3. 캐시에 없는 문장만 **민감정보 마스킹**(`⟦PII_n⟧`) 후 최대 8문장·1,500자 배치로 묶음
4. 배치마다 **한도 관리자 → 라우터**가 체인에서 사용 가능한 모델을 골라 호출, 실패하면 다음 모델 (최대 3개)
5. 출력에서 JSON을 복구하고 **제안별로 검증**, 통과한 것만 문서 좌표(`start`/`end`)로 변환
6. 배치가 끝나는 대로 흘려 보내고(스트리밍), 마지막에 `meta`와 함께 전체를 조립

모델은 `original` 문자열과 `occurrence`만 주고, **위치는 하네스가 계산**한다. 하네스는 원문을 직접 고치지 않는다.

### API

- `POST /api/v1/suggest` — `{ docVersion, text, task: "spell"|"polish", strength?: "light"|"normal"|"strong", language?: "ko"|"en"|"auto", priority?: "user"|"auto", dictionary?: string[], stream?: boolean }`
  응답: `{ requestId, docVersion, suggestions[], meta: { cached, modelCalls, latencyMs, degraded, reason? } }`.
  `stream: true`면 NDJSON(`{kind:"suggestions"}` … `{kind:"done"}`). `meta.cached`는 캐시에서 가져온 **문장 수**.
  클라이언트는 응답의 `docVersion`이 현재 문서 버전과 다르면 제안을 버려야 한다.
- `POST /api/v1/alternatives` — `{ text, tone: "polite"|"concise"|"simple"|"formal", n? }` → `{ alternatives: [{ text, note }], … }`
- `POST /api/v1/feedback` — `{ suggestionId, action: "accept"|"reject", model, promptVersion }` 수락·거절 집계
- `GET /api/v1/metrics` — 카운터, 지연 분포, 모델·프롬프트 버전별 수락률, 한도 사용률
- 편집기용 `/api/check`, `/api/rewrite`는 같은 하네스 위의 어댑터다.

### 검증기가 막는 것

제안 하나라도 아래에 걸리면 **그 제안만** 버린다 (나머지는 정상 반환): 스키마 오류, 원문에 없는 `original`, 변경 없음, 숫자·날짜·금액·URL·이메일·자리표시자 변경, 인용문 변경, 고유명사(사용자 사전 + 문장 중간의 영문 대문자 단어) 변경, 교정 강도별 길이 상한 초과, 낮은 신뢰도, 허용되지 않은 카테고리. 겹치는 제안은 오류 > 명확성 > 어조, 신뢰도 순으로 하나만 남긴다. 사유별 개수는 요청 로그의 `dropped`에 남는다.

## 설정

`config/models.yaml`이 유일한 모델 설정이다. 주요 항목:

- `models[]`: `id`, `tier`(free/paid), `tasks`, `supportsJsonMode`, `supportsStreaming`, `contextLength`, `maxOutputTokens`, `dataPolicy`(no-train/retain/may-train/unknown), `priority`, `enabled`, `extraBody`
- `chains`: 작업(spell/polish/tone)별 대체 체인
- `dataCollection` / `onNoEligible`: `deny`일 때 `no-train` 모델만 쓰고 요청에 `provider.data_collection: deny`를 보낸다. 쓸 수 있는 모델이 없으면 `degrade`(degraded 응답) 또는 `relax`(allow로 낮춰 계속)
- `allowPaidFallback`, `limits`, `client`(타임아웃), `router`, `batch`, `cache`, `validator`

환경 변수: `OPENROUTER_API_KEY`, `FASTEDIT_DATA_COLLECTION`, `FASTEDIT_ALLOW_PAID`, `REDIS_URL`, `CACHE_ENCRYPTION_KEY`, `FASTEDIT_MODELS_FILE`(설정 파일 경로), `PORT`.

### 무료 모델 교체 절차

무료 모델은 예고 없이 사라지거나 429/404를 낸다. 코드는 건드리지 않는다.

1. 후보 확인: `curl -s https://openrouter.ai/api/v1/models` 에서 `:free` 모델의 `context_length`, `supported_parameters`(`response_format` 여부) 확인
2. `config/models.yaml`의 `models`에 항목을 추가하고, `chains`에 원하는 순서로 넣는다. 사라진 모델은 `enabled: false`
3. 평가: `npm run eval -- --task spell --model <새 모델 ID>` (config에 없는 ID도 평가할 수 있다)
4. 보고서(`eval/reports/`)에서 재현율·정밀도·파싱 실패율·지연이 이전 모델 이상이면 체인에 반영하고 서버를 재시작

서버는 시작할 때와 하루 한 번 `/models`를 조회해, 목록에서 사라진 모델을 자동으로 비활성화하고 경고 로그를 남긴다.
**스트리밍 주의**: 일부 무료 호스트는 SSE를 열고도 응답 전체를 한 번에 보낸다(첫 토큰 시각 = 완료 시각). 이런 모델에 3초 첫 토큰 제한을 걸면 정상 응답이 끊기므로 `supportsStreaming: false`로 둔다.

### 요청 한도 초과 시 동작

OpenRouter 무료 모델 한도는 **계정 전체** 분당 20회, 일일 50회(10달러 이상 크레딧이면 1,000회)이고 키를 늘려도 늘지 않는다. 한도 관리자가 Redis(없으면 인메모리) 카운터로 이를 추적한다. 서버는 한도 때문에 오류를 내지 않는다.

| 사용률 | `priority: auto` (자동 윤문) | `priority: user` (사용자가 누름) |
|---|---|---|
| < 80% | 처리 | 처리 |
| ≥ 80% | **거절** → `degraded: true, reason: "throttled"` | 처리 |
| 100% | 무료 모델 건너뜀 | 무료 모델 건너뜀 |

무료 한도가 소진되면 `allowPaidFallback`(또는 `FASTEDIT_ALLOW_PAID=1`)이 켜져 있을 때만 체인의 유료 모델로 넘어가고, 아니면 빈 제안과 `degraded: true, reason: "quota_exhausted"`를 돌려준다. 유료 모델 호출은 무료 한도에 세지 않는다. 모델이 429·5xx·시간 초과·빈 응답·파싱 불가를 내면 다음 모델로 넘어가고(최대 3개), 최근 5분 오류율이 50%를 넘는 모델은 1분간 차단된다. 모든 모델이 실패해도 사용자에게 오류를 노출하지 않고 `degraded: true`로 응답한다. 현재 사용률은 `GET /api/v1/metrics`의 `rateLimit`.

## 개인정보

- 모델로 보내기 전에 주민등록번호·카드·전화·이메일·계좌번호를 자리표시자로 바꾸고, 결과에서 자리표시자가 사라지거나 바뀐 제안은 버린다.
- **로그에는 원문을 남기지 않는다.** 요청 로그에는 길이와 SHA-256 앞 12자리만 있다.
- **캐시**의 키는 HMAC, 값은 AES-256-GCM으로 암호화한다. `CACHE_ENCRYPTION_KEY`가 없으면 프로세스마다 임시 키를 만들어(재시작·다중 인스턴스에서는 캐시 미스) 평문이 저장소에 남지 않는다. 기본 TTL 7일.
- `dataPolicy: may-train` 모델(현재 기본 모델)은 호스트가 프롬프트를 학습에 쓸 수 있다. 개인정보 처리방침에 고지해야 하며, 정책을 엄격히 하려면 `dataCollection: deny`.

## 평가

```bash
npm run eval -- --task spell  --model nvidia/nemotron-3.5-super-vl:free
npm run eval -- --task polish --model a:free,b:free,c:free   # 쉼표로 여러 모델 비교
```

- 평가셋: `eval/datasets/<task>.<lang>.jsonl` — `{ "input", "expected": [{ "original", "replacement" }], "mustNotChange": [] }` (tone은 `"tone"` 추가). 한국어 맞춤법 30, 윤문 20, 톤 10 + 영어 맞춤법 10, 윤문 6.
- 출력: 정답 제안 재현율, 정밀도, 금지 변경 위반 수, JSON 파싱 실패율, 호출 실패율, 평균·p95 지연, 검증기가 버린 제안.
- 보고서: `eval/reports/<날짜>/<task>__<모델>__<프롬프트버전>.{json,md}`, 여러 모델이면 `compare-<task>.md`.
- 요청은 분당 15회 이하로 제한(`--rpm`), 호출 실패 시 같은 모델로 1회 재시도(`--retries`).
- 재현율은 정확히 같은 `(original, replacement)`이거나, 위치가 겹치면서 기대 수정을 포함(더 넓게 고침)하거나 그 일부를 고친 제안이면 인정한다. 윤문 정답은 주관적이라 재현율이 낮게 나오는 것이 정상이다.

## 지연 목표 측정

`server/harness/perf.test.ts` — 목 서버가 모델 지연 400ms(`MODEL_LATENCY_MS`로 변경)로 응답할 때, 서로 다른 문서 40개의 **첫 제안까지 시간**과 같은 문서를 다시 보낸 **캐시 적중 응답 시간**의 p95를 잰다 (기준: 첫 제안 ≤ 3초, 캐시 적중 ≤ 100ms). `npm run bench`로 단독 실행.

## 알려진 제약

- 편집기 어댑터(`/api/check`)의 "어조 목표"는 이제 제안 단위로 반영되지 않는다. 어조 변경은 선택 구간 대안(`/api/v1/alternatives`)으로만 한다.
- 자동 윤문이 문단마다 요청을 보내므로 무료 한도(분 20회)에 쉽게 닿는다. 캐시와 80% 컷이 이를 완화하지만 근본 해결은 아니다.
- 자체 경량 맞춤법 모델, 계정·문서 저장, 브라우저 확장은 아직 없다.
