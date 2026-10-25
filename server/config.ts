// HTTP 서버 설정. 모델·한도·캐시 설정은 config/models.yaml (server/harness/config.ts)
export const config = {
  port: Number(process.env.PORT ?? 8787),
  maxBlockChars: 5_000,
  maxBlocks: 200,
  /** /api/v1 요청 하나의 최대 글자 수 */
  maxTextChars: 20_000,
};
