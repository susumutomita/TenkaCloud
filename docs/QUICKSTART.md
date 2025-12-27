# TenkaCloud Quick Start Guide

TenkaCloud をローカル環境で起動するクイックスタートガイドです。

## 前提条件

- **Docker Desktop** がインストールされていること
- **Bun** (または Node.js) がインストールされていること
- **Git** がインストールされていること
- **Terraform** がインストールされていること（Auth0 セットアップ用）

## 🚀 クイックスタート（5分で起動）

### ステップ 1: リポジトリのクローン

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
```

### ステップ 2: 依存関係のインストール

```bash
# ni は lock ファイルから自動でパッケージマネージャを選択
ni
# または
bun install
```

### ステップ 3: 認証の設定

TenkaCloud は認証に Auth0 を使用します。開発目的であれば、認証スキップモードを使用して Auth0 のセットアップをスキップできます。

#### オプション A: 認証スキップモード（開発用・推奨）

Auth0 のセットアップをせずにすぐに開発を開始したい場合は、認証スキップモードを使用できます。

**Control Plane (`apps/control-plane/.env.local`)**:

```env
AUTH_SKIP=1
AUTH_SECRET=dev-secret-for-local-development
AUTH_URL=http://localhost:3000
```

**Application Plane (`apps/application-plane/.env.local`)**:

```env
AUTH_SKIP=1
AUTH_SECRET=dev-secret-for-local-development
AUTH_URL=http://localhost:3001
```

認証スキップモードでは、自動的に以下のモックユーザーでログイン状態になります。

- **Control Plane**: Dev User (dev@example.com) / admin ロール
- **Application Plane**: Dev User (dev@example.com) / participant ロール

このモードは開発専用です。本番環境では必ず Auth0 を設定してください。

認証スキップモードを使用する場合は、**ステップ 4** に進んでください。

#### オプション B: Auth0 のセットアップ（本番同等環境）

TenkaCloud は認証に Auth0 を使用します。以下の手順で Auth0 を設定してください。

##### B.1 Auth0 Management API 認証情報の取得

1. [Auth0 Dashboard](https://manage.auth0.com) にログイン
2. 左サイドバーから **Applications** → **APIs** を選択
3. **Auth0 Management API** をクリック
4. **Machine to Machine Applications** タブを開く
5. **Create & Authorize** をクリックして新しい M2M アプリを作成
6. 以下の権限（Permissions）を付与:
   - `read:clients`
   - `create:clients`
   - `update:clients`
   - `delete:clients`
   - `read:resource_servers`
   - `create:resource_servers`
   - `update:resource_servers`
   - `read:client_credentials`
   - `create:client_credentials`
7. **Authorize** をクリック
8. 作成したアプリの **Settings** タブから以下を取得:
   - **Domain** (例: `your-tenant.auth0.com`)
   - **Client ID**
   - **Client Secret**

##### B.2 Terraform 変数ファイルの作成

```bash
# terraform.tfvars を作成
cp infrastructure/terraform/environments/dev/terraform.tfvars.example \
   infrastructure/terraform/environments/dev/terraform.tfvars
```

`infrastructure/terraform/environments/dev/terraform.tfvars` を編集して、取得した認証情報を設定してください。

```hcl
auth0_domain        = "your-tenant.auth0.com"
auth0_client_id     = "取得した Client ID"
auth0_client_secret = "取得した Client Secret"
```

`terraform.tfvars` はシークレット情報を含むため、Git にコミットしないでください（`.gitignore` で除外済み）。

##### B.3 Auth0 リソースのプロビジョニング

```bash
# Auth0 をセットアップ（init + apply + 認証情報表示）
make auth0-setup
```

このコマンドにより、Control Plane 用 Auth0 Application、Application Plane 用 Auth0 Application、TenkaCloud API (Resource Server) が作成されます。

##### B.4 環境変数の設定

`make auth0-setup` の実行後に表示される認証情報を、各アプリの `.env.local` にコピーします。

**Control Plane (`apps/control-plane/.env.local`)**:

```env
# NextAuth.js Configuration
AUTH_SECRET=<openssl rand -base64 32 で生成>
AUTH_URL=http://localhost:3000

# Auth0 Configuration
AUTH0_CLIENT_ID=<表示された control_plane_client_id>
AUTH0_CLIENT_SECRET=<表示された control_plane_client_secret>
AUTH0_ISSUER=https://your-tenant.auth0.com
```

**Application Plane (`apps/application-plane/.env.local`)**:

```env
# NextAuth.js Configuration
AUTH_SECRET=<openssl rand -base64 32 で生成>
AUTH_URL=http://localhost:3001

# Auth0 Configuration
AUTH0_CLIENT_ID=<表示された application_plane_client_id>
AUTH0_CLIENT_SECRET=<表示された application_plane_client_secret>
AUTH0_ISSUER=https://your-tenant.auth0.com
```

### ステップ 4: ローカル環境の起動

```bash
# Docker Desktop を起動してから実行
make start
```

これにより、LocalStack（AWS ローカルエミュレーター）、DynamoDB（テナント・設定データ）、Tenant Management API（バックエンド）、Control Plane UI、Application Plane UI が自動的に起動します。

### ステップ 5: アプリケーションにアクセス

ブラウザで Control Plane（<http://localhost:3000>）と Application Plane（<http://localhost:3001>）にアクセスしてください。

## 📦 主な Makefile コマンド

```bash
# ローカル環境管理
make start            # ローカル環境を一括起動（推奨）
make stop             # ローカル環境を一括停止
make restart          # ローカル環境を再起動

# Auth0 セットアップ
make auth0-setup      # Auth0 を Terraform でセットアップ（init + apply + output）
make auth0-init       # Terraform 初期化
make auth0-plan       # 変更プレビュー
make auth0-apply      # 設定適用
make auth0-output     # 認証情報を表示

# コード品質
make lint             # Linter を実行
make format           # コードを自動整形
make typecheck        # TypeScript 型チェック
make before-commit    # コミット前チェック（lint, format, typecheck, test, build）

# テスト
make test             # テストを実行
make test-coverage    # カバレッジレポート付きテスト（99% 以上必須）

# インフラ
make localstack-up    # LocalStack を起動
make localstack-down  # LocalStack を停止
```

詳細は `make help` を実行してください。

## 🛠 トラブルシューティング

### Docker が起動しない

```bash
# Docker Desktop が起動しているか確認
docker ps

# エラーが出る場合は Docker Desktop を再起動
```

### Auth0 ログインでエラーが発生

**エラー: "Invalid redirect URI"**
- Auth0 Dashboard で Application の **Allowed Callback URLs** を確認
- `http://localhost:3000/api/auth/callback/auth0` が設定されているか確認

**エラー: "Invalid client or Invalid client credentials"**
- `.env.local` の `AUTH0_CLIENT_SECRET` が正しいか確認
- `make auth0-output` で再度認証情報を確認

**エラー: "Configuration error"**
- `.env.local` の `AUTH_SECRET` が設定されているか確認
- `openssl rand -base64 32` で再生成して設定

### ポートが既に使用されている

```bash
# 使用中のポートを確認
lsof -i :3000
lsof -i :3001
lsof -i :4566

# プロセスを終了（PID を指定）
kill -9 <PID>
```

### LocalStack が起動しない

```bash
# LocalStack のログを確認
docker compose logs localstack

# LocalStack を再起動
make localstack-down
make localstack-up
```

### Terraform エラー

**エラー: "terraform.tfvars が見つかりません"**
```bash
# terraform.tfvars を作成
cp infrastructure/terraform/environments/dev/terraform.tfvars.example \
   infrastructure/terraform/environments/dev/terraform.tfvars
# ファイルを編集して認証情報を入力
```

**エラー: "Auth0 API error"**
- Auth0 Management API の権限が正しく付与されているか確認
- M2M アプリが Auth0 Management API に対して Authorized されているか確認

## 🧹 環境のクリーンアップ

```bash
# すべて停止
make stop

# LocalStack のデータも削除
docker compose down -v
```

## 📚 次のステップ

- [README.md](../README.md) - プロジェクト概要
- [CLAUDE.md](../CLAUDE.md) - 開発ガイド（Claude Code/AI エージェント向け）
- [アーキテクチャ設計](./architecture.md)（予定）

## 🔐 セキュリティ注意事項

ローカル開発環境の設定です。本番環境では以下の点に注意してください。

- `.env.local` は Git にコミットしないこと（`.gitignore` で除外済み）
- `terraform.tfvars` も Git にコミットしないこと
- 本番環境では強力なシークレットを使用すること
- Auth0 の本番テナントでは厳格なアクセス制御を設定すること

---

**所要時間**: 約 10〜15 分
**難易度**: ⭐⭐☆☆☆（中級）

質問や問題があれば、[GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues) で報告してください。
