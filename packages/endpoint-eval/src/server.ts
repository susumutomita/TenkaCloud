import { createLocalEvalApp } from "./local.js";

/**
 * Issue #1973: ローカルバックエンドの起動エントリ。 `bun run packages/endpoint-eval/src/server.ts`
 * で起動する (Bun は default export の `{ port, fetch }` を自動で serve する)。 AWS ゼロで
 * 「Cloudflare に実デプロイ → URL 提出 → 本物の評価 → クリアコード」の一周がローカルで回る。
 *
 * env:
 *   PORT                          待受ポート (既定 8787)
 *   ENDPOINT_EVAL_SIGNING_SECRET  クリアコード署名鍵 (未指定なら dev 鍵 + 警告)
 *
 * I/O エントリのためカバレッジ計測からは除外している (package.json の test:coverage)。
 */
const app = createLocalEvalApp({ signingSecret: process.env.ENDPOINT_EVAL_SIGNING_SECRET });

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch,
};
