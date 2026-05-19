# @TenkaCloud/application-admin-console

TenkaCloud の Tenant Admin (= 主催者) が使う Application Plane の管理コンソール。 Battle / Challenge 問題を競技者 AWS account に deploy + Event 管理 + 競技中の運営支援を担う。 Lite mode (= `make deploy` のデフォルト) でも SaaS mode (= `make deploy-saas`) でも同じ SPA が動く。

## 機能

- **Event 管理** — 作成 / 一覧 / 詳細 (deploy 進捗、 team ranking)
- **Problem catalog** — 問題一覧 / 詳細 / event への割り当て
- **Deploy 進捗** — Step Functions + CodeBuild の進行可視化
- **Competitor accounts** — 競技者 AWS account の登録 / ExternalId rotate
- **チーム / SSO credential** — Event ごとの team 単位 login key 発行

i18n は ja + en。

## ローカル開発

```sh
make install
make dev
# → http://localhost:5174
```

runtime-config.json は dev 環境では fetch せず `import.meta.env.VITE_*` から読む (production は CloudFront 配下の `/runtime-config.json` が正本)。

## コマンド

```sh
make dev      # 開発サーバ
make build    # 型チェック + 本番ビルド
make preview  # dist/ を serve
make test     # vitest
make clean    # dist と node_modules を削除
```

モノレポ全体から実行する場合。

```sh
bun run --filter @TenkaCloud/application-admin-console dev
bun run --filter @TenkaCloud/application-admin-console test
```

## 関連

- [`docs/architecture/adr-012-problem-plugin-architecture.html`](../../docs/architecture/adr-012-problem-plugin-architecture.html) — 問題 = plugin、 platform = host
- [`docs/architecture/adr-016-tenkacloud-lite-app-plane-core.html`](../../docs/architecture/adr-016-tenkacloud-lite-app-plane-core.html) — Lite mode で AppPlaneCore を抽出
- [`docs/operations/deploy-trace.html`](../../docs/operations/deploy-trace.html) — Deploy 進捗 trace
- [`docs/operations/notifications.html`](../../docs/operations/notifications.html) — 運営 → 競技者通知の運用手引
