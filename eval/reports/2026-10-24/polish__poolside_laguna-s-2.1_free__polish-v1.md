# polish · poolside/laguna-s-2.1:free · polish@v1

- 날짜: 2026-10-24T12:32:58.296Z  |  평가셋: eval/datasets/polish.en.jsonl (6문장), eval/datasets/polish.ko.jsonl (20문장)  |  모델 호출: 6회, 43초
- 모델 정책: tier=free, dataPolicy=unknown

| 지표 | 값 |
|---|---|
| 정답 제안 재현율 | 72.2% (13/18) |
| 정밀도 | 72.2% (13/18) |
| 금지 변경 위반 | 2 |
| JSON 파싱 실패율 | 0.0% |
| 호출 실패율 | 33.3% |
| 지연 평균 / p95 | 13495ms / 14835ms |

검증기가 버린 제안: no_change=5, protected_changed=1

메모:
- 금지 변경 위반: "We will meet at 3pm in the Berlin office." → "We will meet at 3 p.m. in the Berlin office." (We will meet at 3pm in the Ber)
- 놓친 수정: 과반수 이상의→과반수의 / 제안: 없음
- 놓친 수정: 매우 아주→매우 / 제안: 매우 아주→아주
- 놓친 수정: 새로운 신제품을→신제품을 / 제안: 없음
- 놓친 수정: 불가능하다고 할 수 있다→불가능하다 / 제안: 그것은 불가능하다고 할 수 있다.→그것은 불가능할 수 있다.
- 놓친 수정: 직접 스스로→직접 / 제안: 사용자가 직접 스스로 선택할 수 있다.→사용자가 스스로 선택할 수 있다.
- 금지 변경 위반: "접수 마감은 2024년 12월 31일이며 문의는 02-123-4567로 하면 된다." → "접수 마감은 2024년 12월 31일이며, 문의은 02-123-4567로 하면 된다." (접수 마감은 2024년 12월 31일이며 문의는 02-)
- 모델 호출 실패 rate_limit: 1회
- 모델 호출 실패 empty: 1회
