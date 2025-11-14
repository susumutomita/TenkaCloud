# Keycloak 認証基盤セットアップ

TenkaCloud のマルチテナント認証基盤として Keycloak を使用します。

## 🎯 概要

- **Keycloak**: OSS Identity Provider (OIDC/SAML サポート)
- **PostgreSQL**: Keycloak のデータベースバックエンド
- **Docker Compose**: ローカル開発環境

## 🚀 クイックスタート

### 方法 1: 自動セットアップ（推奨）

```bash
cd infrastructure/docker/keycloak

# Keycloak を起動
docker compose up -d

# 自動セットアップスクリプトを実行
./scripts/setup-keycloak.sh
```

スクリプトが自動的に次の処理を実行する。
- TenkaCloud Realm の作成
- `control-plane-ui` Client の作成
- Client Secret の生成と表示

出力された環境変数を `.env.local` に設定してください。

### 方法 2: 手動セットアップ

詳細な手順は [Quick Start Guide](../../../docs/QUICKSTART.md) を参照してください。

### サービスの停止

```bash
docker compose down
```

データを保持したまま停止する場合は次を実行する。
```bash
docker compose stop
```

データを削除して停止する場合は次を実行する。

```bash
docker compose down -v
```

## 🏗 Realm 設計

### Master Realm

- Keycloak 管理用のデフォルト Realm
- **使用禁止**: アプリケーションユーザーは登録しない

### TenkaCloud Realm

- TenkaCloud アプリケーション用の Realm
- すべてのテナント・ユーザーを管理

## 👥 ロール設計

### platform-admin

- TenkaCloud 全体の管理者
- すべてのテナントを管理可能
- **権限**: テナント作成・削除、グローバル設定

### tenant-admin

- テナント管理者
- 自テナント内のユーザー・バトルを管理
- **権限**: ユーザー管理、バトル作成・管理

### user

- 一般ユーザー
- バトルに参加可能
- **権限**: バトル参加、自分のプロフィール編集

## 🔧 初期設定手順

### 1. TenkaCloud Realm の作成

1. Admin Console にログイン
2. 左上のドロップダウンから「Create Realm」をクリック
3. Realm name: `TenkaCloud`
4. 「Create」をクリック

### 2. Client の作成

#### Control Plane UI Client

1. TenkaCloud Realm に切り替え
2. 「Clients」→「Create client」
3. 設定:
   - **Client ID**: `control-plane-ui`
   - **Client type**: `OpenID Connect`
   - **Client authentication**: `ON`
   - **Valid redirect URIs**: `http://localhost:3000/api/auth/callback/keycloak`
   - **Web origins**: `http://localhost:3000`
4. 「Credentials」タブで Client Secret をコピー → `.env` の `KEYCLOAK_CLIENT_SECRET` に設定

#### Application UI Client

1. 同様に `application-ui` クライアントを作成
2. Redirect URI: `http://localhost:3001/api/auth/callback/keycloak`

### 3. Roles の作成

1. 「Realm roles」→「Create role」
2. 以下のロールを作成:
   - `platform-admin`
   - `tenant-admin`
   - `user`

### 4. テストユーザーの作成

1. 「Users」→「Create new user」
2. Username: `test-admin`
3. 「Credentials」タブでパスワード設定
4. 「Role mapping」タブで `platform-admin` ロールを割り当て

## 🔐 NextAuth.js 統合

Control Plane UI の `.env.local` に以下を追加。

```bash
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<generate-random-secret>

KEYCLOAK_CLIENT_ID=control-plane-ui
KEYCLOAK_CLIENT_SECRET=<from-keycloak-client-credentials>
KEYCLOAK_ISSUER=http://localhost:8080/realms/TenkaCloud
```

## 📊 ヘルスチェック

```bash
# Keycloak
curl http://localhost:8080/health/ready

# PostgreSQL
docker exec tenkacloud-keycloak-db pg_isready -U keycloak
```

## 🐛 トラブルシューティング

### Keycloak が起動しない

```bash
# ログを確認
docker compose logs keycloak

# PostgreSQL の接続確認
docker compose logs postgres
```

### データベースをリセットしたい

```bash
# ボリュームを削除して再起動
docker compose down -v
docker compose up -d
```

## 📚 参考リンク

- [Keycloak Official Documentation](https://www.keycloak.org/documentation)
- [Keycloak Docker Image](https://quay.io/repository/keycloak/keycloak)
- [NextAuth.js Keycloak Provider](https://next-auth.js.org/providers/keycloak)
