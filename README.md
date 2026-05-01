# TenkaCloud

TenkaCloud は、クラウド技術者向けの OSS 競技プラットフォームです。AWS GameDay をルーツにしつつ、常設運用できるマルチテナント SaaS として再構成しています。

## システム構成

- `client/AdminWeb/`: プラットフォーム管理 UI (Control Plane)。テナント管理、設定、運用導線を担当
- `client/Application/`: テナント向け UI (Application Plane)。GameDay / Battle / ランキング / プロフィールを担当
- `server/microservices/*`: Hono ベースのマイクロサービス群 (tenant-management / problem-service / gameday-service / battle-service / scoring-service / leaderboard-service)
- `server/libs/*`: DynamoDB クライアント、イベント型、cloud abstraction などの共有ライブラリ
- `infrastructure/cdk/`: SBT 0.3.9 ベースの CDK スタック群 (詳細は [ADR-014](docs/decisions/014-repository-layout-cdk-out-of-server.md))
- `problems/`: 問題データとドキュメント

クラウドへ deploy 後の認証は **AWS Cognito + browser-side PKCE** です (AdminWeb は Next.js static export)。ローカル開発では `AUTH_SKIP=1` を使えます。

## クイックスタート

### 前提

- Docker Desktop
- Bun
- AWS CLI (cloud deploy 時)

### ローカル開発

```bash
make install     # 依存関係インストール
make start       # 全サービス起動 (Docker emulator + UI 2 + Backend 6)
```

主要 URL は以下のとおりです。

- Control Plane: `http://localhost:13000/control`
- Application Plane: `http://localhost:13001/`
- Tenant API: `http://localhost:13004/api/tenants`
- Problem API: `http://localhost:3100/api`
- GameDay API: `http://localhost:3020/api/gameday`
- Local emulator: `http://localhost:4566`

ローカルでは `make start` が `AUTH_SKIP=1` / `NEXT_PUBLIC_AUTH_SKIP=1` を注入するため、UI 確認だけなら追加設定不要です。

### AWS deploy

```bash
cd infrastructure/cdk
make deploy ENV=development
```

`scripts/install.sh` が呼ばれて 4 phase で deploy します。

| Phase | 役割 |
|---|---|
| 0 | `bun build` で 6 microservice の Lambda bundle (`server/microservices/<svc>/dist/lambda/`) を生成 |
| 1 | ControlPlaneStack / Bootstrap / TenantTemplate / Pipeline / **AdminApiStack** を deploy |
| 2 | AdminWeb を `next build` (static export) → AdminConsoleHostingStack を deploy (CloudFront + S3 + `runtime-config.json`) |
| 3 | ControlPlaneStack + AdminApiStack 再 deploy で CloudFront origin を Cognito callback と CORS に追加 |

詳細は [docs/architecture/architecture.md](./docs/architecture/architecture.md) と [docs/guides/one-pass-aws.md](./docs/guides/one-pass-aws.md)。

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
make start-localstack  # LocalStack を起動 (DynamoDB テーブルも自動作成)
make seed-data         # 開発用シードデータ投入
make gameday-seed      # GameDay デモデータ投入
```

バックエンドサービスは `DYNAMODB_ENDPOINT` 環境変数でエンドポイントを切り替えます。`make start` で起動すると自動的に `http://localhost:4566` が設定されます。Kumo / Floci も代替エミュレータとして `make start-kumo` / `make start-floci` で使えます。

## ドキュメントの正本

- 概要: [docs/OVERVIEW.md](./docs/OVERVIEW.md)
- クイックスタート: [docs/QUICKSTART.md](./docs/QUICKSTART.md)
- アーキテクチャ: [docs/architecture/architecture.md](./docs/architecture/architecture.md)
- アーキテクチャ不変条件: [docs/architecture/harness.md](./docs/architecture/harness.md)
- ADR: [docs/decisions/](./docs/decisions/)
- コントリビューション: [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)
- エージェント向け入口: [AGENTS.md](./AGENTS.md)

## ドキュメント方針

- `README.md` は最短の入口
- `docs/` を内部向け正本
- `docs-site/` は公開向けの要約と導線
- 一時的な調査メモや運用メモは正本に昇格させない
- 仕様がコードと食い違う場合は、責務と公開契約を `docs/` に反映する
