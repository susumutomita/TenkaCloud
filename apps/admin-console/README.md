# @TenkaCloud/admin-console

TenkaCloud の SaaS mode で System Admin が Control Plane (`@cdklabs/sbt-aws` 0.3.9 の ControlPlane Stack) を操作する SPA。 Vite + React + Cloudscape Design System、 認証は Cognito Hosted UI への OAuth Code + PKCE。

> Lite mode (= `make deploy`) では本 SPA は使わない (= SaaS mode 専用)。 主催者 1 人 1 大会の最短経路は `make deploy` で `apps/application-admin-console` を直接使う。

## 機能

- サインイン (Cognito Hosted UI 経由、 TOTP MFA 必須)
- テナント一覧 / 作成 / deprovision
- プロビジョニング Jobs (CodePipeline 実行履歴)
- 監査ログ
- 運用ダッシュボード (CloudWatch Dashboard / AWS Budgets / Alarms への deep link)

i18n は ja + en の 2 言語。

## ローカル開発

`.env.local` を配置してから起動する。

```env
VITE_COGNITO_DOMAIN=https://tenkacloud-xxxx.auth.ap-northeast-1.amazoncognito.com
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_API_BASE_URL=https://xxxxx.execute-api.ap-northeast-1.amazonaws.com/prod
```

```sh
make install
make dev
# → http://localhost:5173
```

Cognito UserPoolClient 側で `http://localhost:5173/callback` を許可コールバック URL に追加する (`make deploy-saas` 後は CDK が自動で追加済)。 production deploy では runtime-config.json 経由で URL が注入されるため `.env.local` 不要。

## コマンド

```sh
make dev      # 開発サーバ
make build    # 型チェック + 本番ビルド
make preview  # dist/ を serve
make test     # vitest
```
