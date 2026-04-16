# TenkaCloud Application Plane

TenkaCloud のテナント向け UI です。管理者向け画面と参加者向け画面を同じ Next.js アプリにまとめています。

## 役割

- GameDay イベント表示
- Battle 参加と進行確認
- 問題閲覧と挑戦
- ランキング、スコア、プロフィール表示

## 技術スタック

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS v4
- NextAuth.js v5
- Biome
- Vitest

## 開発

```bash
bun install
bun run dev
```

デフォルトポートは `13001` です。

### 主なスクリプト

- `bun run dev`
- `bun run build`
- `bun run start`
- `bun run typecheck`
- `bun run lint`
- `bun run format`
- `bun run test`
- `bun run test:coverage`

## 認証

- 本番相当: Auth0
- ローカル確認: `AUTH_SKIP=1`

環境変数の雛形は [`.env.example`](/Users/susumu/product/TenkaCloud/apps/application-plane/.env.example) を参照してください。

## 関連 API

- Problem API: `http://localhost:3100/api`
- GameDay API: `http://localhost:3020/api/gameday`

## 関連文書

- [README.md](/Users/susumu/product/TenkaCloud/README.md)
- [docs/QUICKSTART.md](/Users/susumu/product/TenkaCloud/docs/QUICKSTART.md)
- [docs/architecture/architecture.md](/Users/susumu/product/TenkaCloud/docs/architecture/architecture.md)
