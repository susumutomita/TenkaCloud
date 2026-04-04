# TenkaCloud

TenkaCloud は、クラウド技術者向けの OSS 競技プラットフォームです。AWS GameDay をルーツにしつつ、常設運用できるマルチテナント SaaS として再構成しています。

## システム構成

- `apps/control-plane`: プラットフォーム管理 UI。テナント管理、設定、運用導線を担当
- `apps/application-plane`: テナント向け UI。GameDay / Battle / ランキング / プロフィールを担当
- `backend/services/control-plane/*`: テナント管理、登録、プロビジョニングなどの共有サービス
- `backend/services/application-plane/*`: problem / gameday / battle / scoring / leaderboard などの競技サービス
- `problems/`: 問題データとドキュメント

ローカル開発は `Auth0` と `AUTH_SKIP=1` の両方を前提にできます。`Keycloak` / `Cognito` / `frontend/` 構成を前提にした記述は正本から外します。

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

起動後の主要 URL は以下のとおりです。

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

## ローカル DynamoDB 開発

LocalStack を使って DynamoDB のローカル開発環境を構築できます。

```bash
# 1. LocalStack を起動
make start-localstack

# 2. DynamoDB テーブルを作成（start-localstack で自動実行済みだが、手動でも可）
make init-db

# 3. 開発用シードデータを投入（テナント・イベント・問題・チーム・攻撃）
make seed-data

# 4. GameDay デモデータを投入（GameDay サービス起動後）
make gameday-seed
```

バックエンドサービスは `DYNAMODB_ENDPOINT` 環境変数でエンドポイントを切り替えます。`make start` で起動すると自動的に `http://localhost:4566` が設定されます。

Kumo（軽量 Go ベース）や Floci（JVM ベース）も代替エミュレータとして使用できます。

```bash
make start-kumo    # Kumo で起動
make start-floci   # Floci で起動
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
- 一時的な調査メモや運用メモは正本に昇格させない
- 仕様がコードと食い違う場合は、責務と公開契約を `docs/` に反映する
