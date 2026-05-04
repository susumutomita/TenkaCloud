# @TenkaCloud/admin-console

TenkaCloud の Control Plane（sbt-aws の ControlPlane Stack）をシステム管理者が操作する SPA。Vite + React + Cloudscape Design System、認証は Cognito Hosted UI への OAuth Code + PKCE。

## Phase 1 スコープ

- サインイン（Cognito Hosted UI へリダイレクト）
- テナント一覧
- テナント作成
- テナント deprovision

後続フェーズで追加予定はユーザー管理、設定、App 管理、監視ビュー。

## ローカル開発

`.env.local` を配置してから起動する。

```
VITE_COGNITO_DOMAIN=https://TenkaCloud-xxxx.auth.ap-northeast-1.amazoncognito.com
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_API_BASE_URL=https://xxxxx.execute-api.ap-northeast-1.amazonaws.com/prod
VITE_REDIRECT_URI=http://localhost:5173/callback
```

```sh
make install
make dev
```

Cognito User Pool の App Client 側で `http://localhost:5173/callback` を許可コールバック URL に追加する。

## コマンド

```sh
make dev      # 開発サーバ
make build    # 型チェック + 本番ビルド
make preview  # dist/ を serve
make test     # vitest
```
