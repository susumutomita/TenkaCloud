# TenkaCloud Quick Start Guide

TenkaCloud をローカル環境で起動するクイックスタートガイドです。

## 前提条件

以下がインストールされている必要があります。

| ツール | 用途 | インストール |
|--------|------|--------------|
| Docker Desktop | コンテナ実行 | [公式サイト](https://www.docker.com/products/docker-desktop/) |
| Bun | パッケージ管理・ランタイム | `brew install oven-sh/bun/bun` |
| AWS CLI | LocalStack 操作 | `brew install awscli` |
| Terraform | インフラ構築 | `brew install terraform` |

## 🚀 クイックスタート（3 ステップで起動）

### 1. クローンと依存関係インストール

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
bun install
```

### 2. 環境変数を設定

以下のファイルを作成するだけで、Auth0 なしですぐに開発できます。

```bash
# Control Plane
cat > apps/control-plane/.env.local << 'EOF'
AUTH_SKIP=1
AUTH_SECRET=dev-secret-for-local-development
AUTH_URL=http://localhost:13000
TENANT_API_BASE_URL=http://localhost:3004/api
EOF

# Application Plane
cat > apps/application-plane/.env.local << 'EOF'
AUTH_SKIP=1
AUTH_SECRET=dev-secret-for-local-development
AUTH_URL=http://localhost:13001
EOF
```

`AUTH_SKIP=1` で認証スキップモードが有効になり、モックユーザーで自動ログインします。

### 3. 起動

```bash
# Docker Desktop を起動してから実行
make start
```

起動後、以下の URL にアクセスできます。

- **Control Plane**: http://localhost:13000
- **Application Plane**: http://localhost:13001
- **Tenant Management API**: http://localhost:3004
- **LocalStack**: http://localhost:4566

## 🔧 Tenant Management サービス

テナント管理機能を使用するには、tenant-management サービスを起動します。

```bash
# 別ターミナルで実行
cd backend/services/control-plane/tenant-management
DYNAMODB_TABLE_NAME=TenkaCloud-dev \
DYNAMODB_ENDPOINT=http://localhost:4566 \
AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
bun run dev
```

以下のコマンドで動作を確認します。

```bash
curl http://localhost:3004/health
# {"status":"ok","service":"tenant-management"}
```

詳細は [tenant-management-integration.md](./architecture/tenant-management-integration.md) を参照してください。

## ☁️ LocalStack（AWS ローカルエミュレーション）

LocalStack 起動時に以下の AWS リソースが自動作成されます。

| サービス | リソース | 用途 |
|----------|----------|------|
| DynamoDB | `TenkaCloud-dev` | メインテーブル（Single-Table Design） |
| Cognito | `tenkacloud-users` | ユーザープール |
| S3 | `tenkacloud-assets` | 静的アセット |
| S3 | `tenkacloud-uploads` | ユーザーアップロード |
| S3 | `tenkacloud-logs` | ログ保存 |
| SQS | `battle-events` | バトルイベントキュー |
| SQS | `scoring-tasks` | 採点タスクキュー |

DynamoDB は Single-Table Design を採用しています。GSI1（スラッグ検索用）と GSI2（エンティティタイプ検索用）を持ちます。

```bash
# リソース確認コマンド
awslocal dynamodb list-tables
awslocal dynamodb describe-table --table-name TenkaCloud-dev
awslocal cognito-idp list-user-pools --max-results 10
awslocal s3 ls
awslocal sqs list-queues
```

## 📦 主な Makefile コマンド

| コマンド | 説明 |
|----------|------|
| `make start` | LocalStack + フロントエンドを起動 |
| `make stop` | LocalStack を停止 |
| `make restart` | 再起動 |
| `make status` | サービス状態を表示 |
| `make dev` | Control Plane のみ起動（フロントエンド開発用） |
| `make test` | テスト実行（カバレッジ付き） |
| `make before-commit` | コミット前チェック（lint, format, typecheck, test, build） |
| `make help` | すべてのコマンドを表示 |

## 🔐 Auth0 セットアップ（本番同等環境を構築する場合）

開発時は認証スキップモードで十分ですが、本番同等の環境を構築したい場合は Auth0 を設定します。

<details>
<summary>詳細手順を表示</summary>

### Auth0 Management API 認証情報の取得

1. [Auth0 Dashboard](https://manage.auth0.com) にログイン
2. **Applications** → **APIs** → **Auth0 Management API** を選択
3. **Machine to Machine Applications** タブで新しい M2M アプリを作成
4. 以下の権限を付与して **Authorize**:
   - `read:clients`, `create:clients`, `update:clients`, `delete:clients`
   - `read:resource_servers`, `create:resource_servers`, `update:resource_servers`
   - `read:client_credentials`, `create:client_credentials`
5. **Settings** タブから Domain, Client ID, Client Secret を取得

### Terraform でセットアップ

```bash
# 変数ファイルを作成
cp infrastructure/terraform/environments/dev/terraform.tfvars.example \
   infrastructure/terraform/environments/dev/terraform.tfvars

# 取得した認証情報を terraform.tfvars に設定してから実行
make auth0-setup
```

表示された認証情報を各アプリの `.env.local` に設定してください。

</details>

## 🛠 トラブルシューティング

### Docker が起動しない

```bash
# Docker Desktop が起動しているか確認
docker ps

# エラーが出る場合は Docker Desktop を再起動
```

### ポートが既に使用されている

```bash
# 使用中のポートを確認
lsof -i :3000 -i :3001 -i :4566

# プロセスを終了（PID を指定）
kill -9 <PID>
```

### LocalStack が起動しない

```bash
# LocalStack のログを確認
docker compose logs localstack

# 再起動
make stop && make start
```

### `ENOTFOUND tenant-management` エラー

テナント管理画面で `fetch failed` エラーが出る場合は、以下を確認します。

1. `.env.local` に `TENANT_API_BASE_URL=http://localhost:3004/api` が設定されているか確認する。
2. tenant-management サービスが起動しているか確認する。`curl http://localhost:3004/health` でヘルスチェックを行う。
3. Control Plane を再起動する。

### Auth0 関連のエラー（Auth0 を使用する場合のみ）

| エラー | 対処 |
|--------|------|
| Invalid redirect URI | Auth0 Dashboard で Allowed Callback URLs に `http://localhost:13000/api/auth/callback/auth0` を設定 |
| Invalid client credentials | `.env.local` の `AUTH0_CLIENT_SECRET` を確認、`make auth0-output` で再取得 |
| Configuration error | `AUTH_SECRET` が設定されているか確認（`openssl rand -base64 32` で生成） |

## 🧹 環境のクリーンアップ

```bash
make stop                  # サービス停止
docker compose down -v     # データも含めて完全削除
```

## 📚 次のステップ

- [README.md](../README.md) - プロジェクト概要
- [CLAUDE.md](../CLAUDE.md) - 開発ガイド

---

質問や問題があれば [GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues) で報告してください。
