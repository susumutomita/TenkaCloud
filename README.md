# TenkaCloud

TenkaCloud は、クラウド技術者向けの OSS 競技プラットフォームです。AWS GameDay をルーツにしつつ、常設運用できるマルチテナント SaaS として再構成しています。

## 現在の実装スコープ

- `apps/control-plane`: プラットフォーム管理 UI。テナント管理、設定、運用導線を担当
- `apps/application-plane`: テナント向け UI。GameDay / Battle / ランキング / プロフィールを担当
- `backend/services/control-plane/*`: テナント管理、登録、プロビジョニングなどの共有サービス
- `backend/services/application-plane/*`: problem / gameday / battle / scoring / leaderboard などの競技サービス
- `problems/`: 問題データとドキュメント

現時点では、ローカル開発は `Auth0` と `AUTH_SKIP=1` の両方を前提にできます。古い `Keycloak` / `Cognito` / `frontend/` 構成を前提にした記述は現行実装ではありません。

## クイックスタート

### 前提

- Docker Desktop
- Bun
- AWS CLI
- Terraform

### セットアップ

```bash
make install
```

### 起動

```bash
make start
```

起動後の主要 URL:

- Control Plane: `http://localhost:13000/control`
- Application Plane: `http://localhost:13001/`
- Tenant API: `http://localhost:13004/api/tenants`
- Problem API: `http://localhost:3100/api`
- GameDay API: `http://localhost:3020/api/gameday`
- Local emulator: `http://localhost:4566`

### 認証

ローカルでは `make start` が以下を注入するため、UI を確認するだけなら `.env.local` なしでも動かせます。

- `AUTH_SKIP=1`
- `NEXT_PUBLIC_AUTH_SKIP=1`
- `AUTH_SECRET=local-dev-secret-do-not-use-in-production`

Auth0 で本番同等に試す場合は `make auth0-setup` を使い、詳細は [docs/AUTH0_SETUP.md](./docs/AUTH0_SETUP.md) を参照してください。

## よく使うコマンド

```bash
make install          # 依存関係をインストール
make start            # ローカル環境を起動
make stop             # ローカル環境を停止
make status           # サービス状態を表示
make test             # テスト実行
make before-commit    # lint, format, typecheck, test, build
make gameday-seed     # GameDay デモデータ投入
```

## ドキュメントの正本

- 概要: [docs/OVERVIEW.md](./docs/OVERVIEW.md)
- クイックスタート: [docs/QUICKSTART.md](./docs/QUICKSTART.md)
- アーキテクチャ: [docs/architecture/architecture.md](./docs/architecture/architecture.md)
- ADR: [docs/decisions/](./docs/decisions/)
- コントリビューション: [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)
- エージェント向け入口: [AGENTS.md](./AGENTS.md)

## ドキュメント方針

- `README.md` は最短の入口
- `docs/` を内部向け正本
- `docs-site/` は公開向けの要約と導線
- 仕様がコードと食い違う場合は、コードに合わせて `docs/` を先に更新する
