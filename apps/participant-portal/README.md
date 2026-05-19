# @TenkaCloud/participant-portal

TenkaCloud の competitor (= 競技者) 向け Web ポータル。 チーム単位で発行される短命ログインキーで認証し、 自チームに deploy された問題への click-through を提供する。 主要 view は scoreboard / score events / 運営 notification。

参加者は AWS Console で問題を解くので、 本ポータルは hosting cost を最小化する方針で **S3 + CloudFront 静的ホスティング** + **Lambda backend** を採用 (= `ProblemDeployBackendStack` 配下、 ADR-016)。

## 機能 / ページ構成

- `/login` チームログインキーで認証
- `/` Home (Welcome + Event 情報 + 累計スコア + 問題 quick link)
- `/problems` 問題一覧 (Quests) — Battle / Challenge カテゴリ filter、 解答状況 filter
- `/problems/:jobId` 問題詳細 (= `metadata.json` の narrative + flag 提出 + endpoint override + portal plugin slot)
- `/scoreboard` Scoreboard — リアルタイム順位 (5 秒 polling)、 終了 30 分前から freeze (#1038)
- `/score-events` Score events — 自チームのスコア変動履歴 + 累計 score 折れ線
- `/notifications` 運営からの通知 (info / warning)
- `/sso` SSO Credentials — AWS Console への federated 1-click サインイン (= ConsoleViewerRole)

i18n は ja + en (#1078 で zh / es を廃止、 #1079 で 4 ページの言語切替対応を追加)。

## 認証

- per-team **ログインキー** (deploy backend が Event 作成時に発行) を入力 → backend が DDB と照合 → セッショントークンが発行される
- 個別ユーザーアカウントは作成しない (= 運営が個人情報の管理義務を負わない設計)
- dev モードは backend を叩かず mock validator で動作 (`mode=dev-mock` の `runtime-config.json`)

## ローカル開発

```sh
make install
make dev
# → http://localhost:5175
```

`make help` で利用可能なターゲット一覧を表示。

## コマンド

```sh
make dev      # 開発サーバ
make build    # 型チェック + 本番ビルド
make preview  # dist/ を serve
make test     # vitest
```

## 関連

- [`docs/architecture/adr-005-battle-portal-ui.html`](../../docs/architecture/adr-005-battle-portal-ui.html) — Portal UI の Cloudscape 採択
- [`docs/architecture/adr-012-problem-plugin-architecture.html`](../../docs/architecture/adr-012-problem-plugin-architecture.html) — 問題 plugin の dashboard.slots
- [`docs/architecture/adr-016-tenkacloud-lite-app-plane-core.html`](../../docs/architecture/adr-016-tenkacloud-lite-app-plane-core.html) — Lite mode の AppPlaneCore
- [`/problems/`](../../problems/) — 問題カタログ
