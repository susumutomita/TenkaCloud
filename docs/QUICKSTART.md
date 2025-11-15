# TenkaCloud Quick Start Guide

TenkaCloud Control Plane UI をローカル環境で起動するクイックスタートガイドです。

## 前提条件

- **Docker Desktop** がインストールされていること
- **Bun** (または Node.js) がインストールされていること
- **Git** がインストールされていること

## 🚀 クイックスタート（5分で起動）

### 方法 1: Makefile で一括起動（推奨）

```bash
# Docker Desktop を起動してから実行
make start-all
```

これで以下が自動的に実行されます：
- Keycloak の起動
- Keycloak の Realm と Client の自動作成
- `.env.local` の作成（存在しない場合）

出力された環境変数を `.env.local` に設定してください。

### 方法 2: 手動セットアップ

#### 1. Docker Desktop を起動

macOS の場合は次を実行する。
```bash
# アプリケーションフォルダから Docker.app を起動
# メニューバーに Docker アイコンが緑色になるまで待つ
```

Docker が起動しているか確認する。
```bash
docker --version
```

#### 2. Keycloak を起動

```bash
cd infrastructure/docker/keycloak
docker compose up -d
```

起動状態を確認する。
```bash
docker compose ps
```

以下のように表示されれば成功と判断できる。
```
NAME                  STATUS          PORTS
keycloak-keycloak-1   Up 30 seconds   0.0.0.0:8080->8080/tcp
keycloak-postgres-1   Up 30 seconds   5432/tcp
```

#### 3. Keycloak の初期設定

##### 3.1 管理コンソールにアクセス

ブラウザで http://localhost:8080 を開く。

##### 3.2 ログイン

- **Username**: `admin`
- **Password**: `admin`

##### 3.3 TenkaCloud Realm を作成

1. 左上のドロップダウン（"Keycloak" と表示）をクリック
2. "Create Realm" をクリック
3. **Realm name**: `tenkacloud` と入力
4. "Create" をクリック

##### 3.4 Client を作成

1. 左メニューから **Clients** をクリック
2. "Create client" ボタンをクリック

**General Settings**:
- **Client type**: `OpenID Connect`
- **Client ID**: `control-plane-ui`
- "Next" をクリック

**Capability config**:
- **Client authentication**: `ON` に変更（トグルをクリック）
- **Authentication flow**:
  - ✅ Standard flow
  - ✅ Direct access grants
- "Next" をクリック

**Login settings**:
- **Valid redirect URIs**: `http://localhost:3000/*`
- **Valid post logout redirect URIs**: `http://localhost:3000/*`
- **Web origins**: `http://localhost:3000`
- "Save" をクリック

##### 3.5 Client Secret を取得

1. 作成した `control-plane-ui` Client の **Credentials** タブを開く
2. **Client secret** の値をコピーし、後で使用する。

#### 4. 環境変数ファイルを作成

```bash
cd ../../frontend/control-plane
cp .env.example .env.local
```

##### 4.1 AUTH_SECRET を生成

```bash
openssl rand -base64 32
```

出力された値をコピーする。

##### 4.2 .env.local を編集

`.env.local` ファイルを開いて、以下を設定する。

```env
# NextAuth.js Configuration
AUTH_SECRET=<先ほど生成したランダム文字列>
AUTH_URL=http://localhost:3000

# Keycloak Configuration
AUTH_KEYCLOAK_ID=control-plane-ui
AUTH_KEYCLOAK_SECRET=<Keycloak で取得した Client Secret>
AUTH_KEYCLOAK_ISSUER=http://localhost:8080/realms/tenkacloud
```

#### 5. 依存関係をインストール

```bash
bun install
```

#### 6. Control Plane UI を起動

```bash
bun run dev
```

以下のように表示されれば成功と判断できる。
```
  ▲ Next.js 16.0.1
  - Local:        http://localhost:3000
  - Environments: .env.local

 ✓ Starting...
 ✓ Ready in 1.2s
```

#### 7. アプリケーションにアクセス

ブラウザで http://localhost:3000 を開く。

## 🎯 動作確認

### ログインフロー

1. http://localhost:3000 にアクセスする。
2. ログインページが表示されるのを確認する。
3. "Keycloak でログイン" ボタンをクリックする。
4. Keycloak のログイン画面にリダイレクトされる。
5. **Username**: `admin` / **Password**: `admin` でログインする。
6. ダッシュボード (`/dashboard`) にリダイレクトされる。
7. セッション情報が表示されることを確認する。

### ログアウト

1. ダッシュボード右上の "ログアウト" ボタンをクリックする。
2. ログインページにリダイレクトされることを確認する。

## 🛠 トラブルシューティング

### Docker が起動しない

```bash
# Docker Desktop が起動しているか確認
docker ps

# エラーが出る場合は Docker Desktop を再起動
```

### Keycloak に接続できない

```bash
# Keycloak のログを確認
cd infrastructure/docker/keycloak
docker compose logs keycloak

# Keycloak を再起動
docker compose restart keycloak
```

### ログイン時にエラーが発生

**エラー: "Invalid redirect URI"**
- Keycloak の Client 設定で Redirect URI が正しいか確認
- `http://localhost:3000/*` が設定されているか確認

**エラー: "Invalid client or Invalid client credentials"**
- `.env.local` の `AUTH_KEYCLOAK_SECRET` が正しいか確認
- Keycloak の Credentials タブから再度 Secret をコピー

**エラー: "Configuration error"**
- `.env.local` の `AUTH_SECRET` が設定されているか確認
- `openssl rand -base64 32` で再生成して設定

### ポートが既に使用されている

**Keycloak (8080)**:
```bash
# 8080 ポートを使用しているプロセスを確認
lsof -i :8080

# Keycloak のポートを変更する場合
# infrastructure/docker/keycloak/docker-compose.yml を編集
ports:
  - "8081:8080"  # 8081 に変更

# .env.local の AUTH_KEYCLOAK_ISSUER も変更
AUTH_KEYCLOAK_ISSUER=http://localhost:8081/realms/tenkacloud
```

**Next.js (3000)**:
```bash
# 3000 ポートを使用しているプロセスを確認
lsof -i :3000

# 別のポートで起動
PORT=3001 bun run dev
```

## 🧹 環境のクリーンアップ

### Keycloak を停止

```bash
cd infrastructure/docker/keycloak
docker compose down
```

### データも削除する場合

```bash
docker compose down -v
```

### Next.js を停止

ターミナルで `Ctrl + C` を押す。

## 📚 次のステップ

- [Control Plane UI README](../frontend/control-plane/README.md) - 詳細なドキュメント
- [Keycloak セットアップガイド](../infrastructure/docker/keycloak/README.md) - Keycloak の詳細設定
- [Plan.md](../Plan.md) - 開発計画と進捗

## 💡 開発時のヒント

### Keycloak のデータをリセット

```bash
cd infrastructure/docker/keycloak
docker compose down -v
docker compose up -d
# 再度 Realm と Client を作成
```

### Next.js のキャッシュをクリア

```bash
cd frontend/control-plane
rm -rf .next
bun run dev
```

### ログを確認

**Keycloak**:
```bash
cd infrastructure/docker/keycloak
docker compose logs -f keycloak
```

**Next.js**:
ターミナルに表示される。

## 🔐 セキュリティ注意事項

⚠️ 本番環境では絶対に使用しないこと。

- デフォルトパスワード (`admin` / `admin`) を使用している。
- `.env.local` は Git にコミットしてはならない（`.gitignore` で除外済み）。
- 本番環境では強力なパスワードと Secret を使用する。

---

**所要時間**: 約 5〜10 分
**難易度**: ⭐⭐☆☆☆（中級）

質問や問題があれば、[GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues) で報告してください。
