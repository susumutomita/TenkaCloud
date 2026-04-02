# TenkaCloud Control Plane

TenkaCloud のプラットフォーム管理 UI です。テナント管理、設定、運用導線を提供します。

## 役割

- テナント一覧と詳細表示
- テナント作成、編集、状態変更
- 共通設定と運用導線
- Application Plane への導線

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

デフォルトポートは `13000` です。

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

環境変数の雛形は [`.env.example`](/Users/susumu/product/TenkaCloud/apps/control-plane/.env.example) を参照してください。

## 関連 API

- Tenant API: `http://localhost:13004/api`

## 関連文書

- [README.md](/Users/susumu/product/TenkaCloud/README.md)
- [docs/QUICKSTART.md](/Users/susumu/product/TenkaCloud/docs/QUICKSTART.md)
- [docs/architecture/architecture.md](/Users/susumu/product/TenkaCloud/docs/architecture/architecture.md)
