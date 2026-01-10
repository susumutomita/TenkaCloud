# Auth0 セットアップガイド

TenkaCloud の認証基盤として Auth0 を使用します。このガイドでは、Terraform を使用した自動セットアップと、手動セットアップの両方を説明します。

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────────────────────┐
│                        Auth0 Tenant                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐   │
│  │  Control Plane   │  │ Application Plane│  │ TenkaCloud   │   │
│  │  Application     │  │  Application     │  │    API       │   │
│  │  (Regular Web)   │  │  (Regular Web)   │  │ (Resource    │   │
│  │                  │  │                  │  │   Server)    │   │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────────┘   │
│           │                     │                               │
│           │    OIDC / OAuth 2.0 │                               │
│           │                     │                               │
└───────────┼─────────────────────┼───────────────────────────────┘
            │                     │
            ▼                     ▼
┌──────────────────┐  ┌──────────────────────┐
│  Control Plane   │  │  Application Plane   │
│  (管理者ポータル)│  │  (テナントアプリ)    │
│  localhost:13000 │  │  localhost:13001     │
└──────────────────┘  └──────────────────────┘
```

### アプリケーション構成

| アプリケーション | 用途 | ポート |
|------------------|------|--------|
| Control Plane | プラットフォーム管理（テナント管理、システム設定） | 13000 |
| Application Plane | テナント向けアプリケーション（バトル、問題管理） | 13001 |
| TenkaCloud API | バックエンド API（Resource Server） | - |

## 前提条件

- [Auth0 アカウント](https://auth0.com/signup)（無料プランで開始可能）
- Terraform >= 1.0
- AWS CLI（LocalStack 用）

## 方法 1: Terraform による自動セットアップ（推奨）

### Step 1: Auth0 Management API 認証情報を取得

Terraform が Auth0 リソースを管理するために、Machine-to-Machine アプリケーションを作成します。

1. [Auth0 Dashboard](https://manage.auth0.com) にログイン

2. **Applications** → **Applications** → **Create Application**
   - Name: `Terraform`
   - Application Type: **Machine to Machine Applications**
   - **Create** をクリック

3. **APIs** タブで **Auth0 Management API** を選択し **Authorize**

4. 以下の権限にチェックを入れて **Update**:

   **必須権限:**
   ```
   read:clients
   create:clients
   update:clients
   delete:clients
   read:resource_servers
   create:resource_servers
   update:resource_servers
   read:client_credentials
   create:client_credentials
   ```

5. **Settings** タブで以下の値をメモ:
   - **Domain**: `dev-xxxxx.auth0.com`
   - **Client ID**: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
   - **Client Secret**: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### Step 2: Terraform 変数を設定

```bash
# terraform.tfvars を作成
cp infrastructure/terraform/environments/dev/terraform.tfvars.example \
   infrastructure/terraform/environments/dev/terraform.tfvars
```

`terraform.tfvars` を以下のように編集します。

```hcl
# Auth0 Configuration
auth0_domain        = "dev-xxxxx.auth0.com"      # Step 1 で取得した Domain
auth0_client_id     = "your-m2m-client-id"       # Step 1 で取得した Client ID
auth0_client_secret = "your-m2m-client-secret"   # Step 1 で取得した Client Secret

# AWS Configuration (optional)
aws_region = "ap-northeast-1"
```

> **セキュリティ注意**: `terraform.tfvars` は `.gitignore` に含まれており、コミットされません。

### Step 3: Terraform を実行

```bash
# 初期化
cd infrastructure/terraform/environments/dev
terraform init

# 変更内容を確認
terraform plan

# 適用
terraform apply
```

### Step 4: 出力された認証情報を設定

```bash
# Control Plane 用の認証情報を取得
terraform output auth0_control_plane_client_id
terraform output -raw auth0_control_plane_client_secret

# Application Plane 用の認証情報を取得
terraform output auth0_application_plane_client_id
terraform output -raw auth0_application_plane_client_secret
```

取得した認証情報を `.env.local` に設定します。

```bash
# apps/control-plane/.env.local
AUTH0_CLIENT_ID=<control_plane_client_id>
AUTH0_CLIENT_SECRET=<control_plane_client_secret>
AUTH0_ISSUER=https://dev-xxxxx.auth0.com
AUTH_SECRET=$(openssl rand -base64 32)
AUTH_URL=http://localhost:13000
TENANT_API_BASE_URL=http://localhost:13004/api

# apps/application-plane/.env.local
AUTH0_CLIENT_ID=<application_plane_client_id>
AUTH0_CLIENT_SECRET=<application_plane_client_secret>
AUTH0_ISSUER=https://dev-xxxxx.auth0.com
AUTH_SECRET=$(openssl rand -base64 32)
AUTH_URL=http://localhost:13001
```

## 方法 2: 手動セットアップ

Terraform を使用せず、Auth0 Dashboard から直接設定する場合の手順です。

### Step 1: Control Plane アプリケーションを作成

1. **Applications** → **Create Application**
   - Name: `TenkaCloud Control Plane`
   - Application Type: **Regular Web Applications**

2. **Settings** タブで以下を設定:

   | 設定項目 | 値 |
   |----------|-----|
   | Allowed Callback URLs | `http://localhost:13000/api/auth/callback/auth0` |
   | Allowed Logout URLs | `http://localhost:13000` |
   | Allowed Web Origins | `http://localhost:13000` |

3. **Advanced Settings** → **OAuth** で確認:
   - JSON Web Token (JWT) Signature Algorithm: `RS256`

4. Client ID と Client Secret をメモ

### Step 2: Application Plane アプリケーションを作成

1. **Applications** → **Create Application**
   - Name: `TenkaCloud Application Plane`
   - Application Type: **Regular Web Applications**

2. **Settings** タブで以下を設定:

   | 設定項目 | 値 |
   |----------|-----|
   | Allowed Callback URLs | `http://localhost:13001/api/auth/callback/auth0` |
   | Allowed Logout URLs | `http://localhost:13001` |
   | Allowed Web Origins | `http://localhost:13001` |

3. Client ID と Client Secret をメモ

### Step 3: API Resource Server を作成

1. **Applications** → **APIs** → **Create API**
   - Name: `TenkaCloud API`
   - Identifier: `https://api.dev.tenkacloud.com`
   - Signing Algorithm: `RS256`

2. **Permissions** タブでスコープを追加:

   | Permission | Description |
   |------------|-------------|
   | `read:tenants` | Read tenant information |
   | `write:tenants` | Create and update tenants |
   | `read:events` | Read event information |
   | `write:events` | Create and update events |
   | `admin` | Full administrative access |

## 本番環境への展開

本番環境では、追加の URL を設定します。

### Terraform 変数の拡張

`main.tf` のモジュール呼び出しを以下のように更新します。

```hcl
module "auth0" {
  source = "../../modules/auth0"

  api_identifier = "https://api.tenkacloud.com"

  # Control Plane URLs
  control_plane_callbacks = [
    "http://localhost:13000/api/auth/callback/auth0",
    "https://admin.tenkacloud.com/api/auth/callback/auth0"
  ]
  control_plane_logout_urls = [
    "http://localhost:13000",
    "https://admin.tenkacloud.com"
  ]
  control_plane_web_origins = [
    "http://localhost:13000",
    "https://admin.tenkacloud.com"
  ]

  # Application Plane URLs
  application_plane_callbacks = [
    "http://localhost:13001/api/auth/callback/auth0",
    "https://app.tenkacloud.com/api/auth/callback/auth0"
  ]
  application_plane_logout_urls = [
    "http://localhost:13001",
    "https://app.tenkacloud.com"
  ]
  application_plane_web_origins = [
    "http://localhost:13001",
    "https://app.tenkacloud.com"
  ]
}
```

## マルチテナント考慮事項

TenkaCloud はマルチテナント SaaS です。Auth0 のテナント分離について説明します。

### 現在の実装

- **単一 Auth0 テナント**: すべての TenkaCloud テナントが同一の Auth0 テナントを共有
- **テナント識別**: JWT クレームまたはアプリケーションメタデータでテナント ID を管理
- **アクセス制御**: アプリケーション層でテナント分離を実装

### 将来の拡張オプション

1. **Auth0 Organizations**: Enterprise プランで組織ごとの分離が可能
2. **カスタムドメイン**: テナントごとに `tenant.tenkacloud.com` 形式のログイン URL

## Makefile コマンド

| コマンド | 説明 |
|----------|------|
| `make auth0-setup` | Terraform で Auth0 をセットアップ |
| `make auth0-plan` | 変更内容をプレビュー |
| `make auth0-apply` | 変更を適用 |
| `make auth0-output` | 認証情報を表示 |

## トラブルシューティング

### `invalid_request: Unknown or invalid client_id`

- terraform.tfvars の `auth0_client_id` が正しいか確認
- Machine-to-Machine アプリの Client ID（アプリケーション用ではなく Terraform 管理用）を使用しているか確認

### `Unauthorized: Access denied`

- Machine-to-Machine アプリに必要な権限が付与されているか確認
- Auth0 Management API が Authorize されているか確認

### `Invalid redirect URI`

- Auth0 Dashboard の Allowed Callback URLs に正確な URL が設定されているか確認
- プロトコル（http/https）、ポート番号、パスが正確に一致しているか確認

### `Configuration error: Missing Auth0 client secret`

```bash
# .env.local に AUTH0_CLIENT_SECRET が設定されているか確認
grep AUTH0_CLIENT_SECRET apps/control-plane/.env.local

# 設定されていない場合は terraform output で取得
cd infrastructure/terraform/environments/dev
terraform output -raw auth0_control_plane_client_secret
```

### ログアウト後に再ログインできない

Auth0 セッションのキャッシュが原因の可能性があります。以下を試してください。

- ブラウザのキャッシュと Cookie をクリアする
- シークレットモードでテストする

## 認証スキップモード（開発用）

Auth0 を設定せずに開発する場合は、認証スキップモードを使用します。

```bash
# .env.local
AUTH_SKIP=1
AUTH_SECRET=dev-secret-for-local-development
```

このモードでは、モックユーザー（`dev@example.com`）で自動的にログインした状態になります。

> **警告**: `AUTH_SKIP=1` は開発環境専用です。本番環境では絶対に使用しないでください。

## 関連ドキュメント

- [クイックスタート](/quickstart) - クイックスタートガイド
- [terraform.tfvars.example](https://github.com/susumutomita/TenkaCloud/blob/main/infrastructure/terraform/environments/dev/terraform.tfvars.example) - Terraform 変数のテンプレート
- [Auth0 公式ドキュメント](https://auth0.com/docs)

---

質問や問題があれば [GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues) で報告してください。
