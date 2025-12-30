# TenkaCloud Control Plane UI

TenkaCloud Control Plane UI は、クラウドバトル用のテナントとキーを安全に管理する Next.js 製ダッシュボードです。Keycloak と連携してチームごとの認証フローを提供し、フロントエンド開発者が迅速に UI を改善できるようシンプルな構成にまとめています。

## 特徴

- **フレームワーク**: Next.js 16 (App Router)
- **言語**: TypeScript (strict mode)
- **スタイル**: Tailwind CSS v4
- **認証**: NextAuth.js v5 + Keycloak (OIDC)
- **Linter / Formatter**: Biome

## セットアップ

### 1. 依存関係をインストール

```bash
bun install
```

### 2. 環境変数を設定

`.env.example` を `.env.local` にコピーし、Keycloak の発行情報に合わせて値を更新します。

```bash
cp .env.example .env.local
```

`.env.local` の必須項目は以下の通りです。

```env
# NextAuth.js Configuration
AUTH_SECRET=<openssl rand -base64 32 の結果>
AUTH_URL=http://localhost:13000

# Keycloak Configuration
AUTH_KEYCLOAK_ID=control-plane-ui
AUTH_KEYCLOAK_SECRET=<Keycloak Client Secret>
AUTH_KEYCLOAK_ISSUER=http://localhost:8080/realms/tenkacloud
```

### 3. Keycloak を起動

リポジトリのインフラディレクトリから Keycloak の docker compose を立ち上げる。

```bash
cd ../../infrastructure/docker/keycloak
docker compose up -d
```

### 4. Keycloak を初期設定

1. `http://localhost:8080` にアクセスして管理コンソールを開く。
2. デフォルト資格情報 `admin / admin` でログインする。
3. `tenkacloud` Realm を作成し、デフォルトのクライアントを削除する。
4. 新しい Client を作成して以下を設定する。
   - Client ID: `control-plane-ui`
   - Client Type: `OpenID Connect`
   - Standard Flow Enabled: `ON`
   - Valid Redirect URIs: `http://localhost:13000/api/auth/callback/keycloak`
   - Web Origins: `http://localhost:13000`
5. Credentials タブで発行された Client Secret を `.env.local` に反映する。

### 5. 開発サーバーを起動

```bash
bun run dev
```

`http://localhost:13000` にアクセスして画面を確認する。

## 利用できるスクリプト

### 開発用

- `bun run dev` - 開発サーバーを起動する
- `bun run build` - 本番ビルドを生成する
- `bun run start` - 本番ビルドをローカル起動する
- `bun run lint` - Biome で静的解析する
- `bun run format` - Biome で自動整形する

### Docker ビルド

- `docker build -t tenkacloud/control-plane-ui:latest .` - Docker イメージをビルド
- `docker compose up -d` - Docker Compose で起動
- `docker compose down` - Docker Compose を停止

または、リポジトリルートで以下を実行する。

- `make docker-build` - Docker イメージをビルド
- `make docker-run` - Docker Compose で起動
- `make docker-stop` - Docker Compose を停止

## 認証フロー

1. `/login` にアクセスすると Keycloak へのリダイレクトが発生する。
2. Keycloak でチームアカウントを入力すると NextAuth.js がセッションを確立する。
3. 認証後は `/dashboard` に遷移し、チームのテナント状態を確認できる。
4. ログアウトすると Keycloak と NextAuth.js のセッションが両方クリアされる。

## ディレクトリ構成

```text
frontend/control-plane/
├─ app/
│  ├─ api/
│  │  └─ auth/
│  │     └─ [...nextauth]/  # NextAuth.js のルート
│  ├─ dashboard/            # 認証後のダッシュボード
│  ├─ login/                # ログインページ
│  ├─ globals.css           # グローバルスタイル
│  ├─ layout.tsx            # 共有レイアウト
│  └─ page.tsx              # エントリーポイント
├─ types/
│  └─ next-auth.d.ts        # NextAuth.js の型定義
├─ auth.ts                  # NextAuth.js 設定
├─ middleware.ts            # 認証ミドルウェア
├─ .env.example             # サンプル環境変数
└─ README.md                # このドキュメント
```

## トラブルシューティング

- Keycloak の稼働確認: `docker ps` で `keycloak` コンテナが `Up` になっているか確認する。
- Keycloak のログ: `docker compose logs keycloak` で起動エラーを確認する。
- リダイレクトエラー: `.env.local` の `AUTH_KEYCLOAK_ISSUER` と Keycloak 側の Redirect URI が一致しているか確認する。
- 認証失敗: `.env.local` の `AUTH_SECRET` を `openssl rand -base64 32` で再生成して再起動する。

## 作業チェックリスト

- [ ] bun install 済み
- [ ] `.env.local` の機密情報を最新化
- [ ] Keycloak が起動していることを確認
- [ ] ログインからダッシュボード表示までを手動確認
- [ ] 必要なテストや lint を完了
