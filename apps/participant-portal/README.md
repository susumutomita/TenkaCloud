# @TenkaCloud/participant-portal

TenkaCloud の競技者 (participant) 向け Web ポータル。チーム単位で発行される短命ログインキーで認証し、自チームに deploy された問題への click-through、scoreboard、score events、運営からの notification などを表示する。

参加者は AWS console を中心に作業するため、本ポータルは hosting cost を最小化する方針で **Lambda Function URL + S3 静的ホスティング** を採用する (実装は別 PR)。

## ローカル開発

```sh
make install
make dev
# → http://localhost:5175
```

`make help` で利用可能なターゲット一覧を表示。

## 認証

- **per-team ログインキー** (deploy backend が問題 deploy 時に発行) を入力 → backend が DDB と照合 → セッショントークンが発行される
- 個別ユーザーアカウントは作成しない (運営側が個人情報の管理義務を負わないため)
- 現状は backend 未実装のため、frontend は mock validator (任意の non-empty key を受け入れる) で動く

## ページ構成 (AWS GameDay 参考画面準拠)

- `/login` ログイン (team login key 入力)
- `/` Home (Welcome + Event Information)
- `/scoreboard` Scoreboard (rank / team / trend / score)
- `/score-events` Score events (得点履歴)
- `/notifications` 運営からの通知
- `/problems/:problemId` 問題ごとの状態 + 操作画面 (battle UI)
- `/tools/sso` SSO Credentials (チーム発行 SSO 情報)

現状 Login と Home 以外は placeholder。実装は順次別 PR。

## 関連

- [`/docs/architecture/`](../../docs/architecture/) — アーキテクチャ全体
- [`/apps/application-admin-console/`](../application-admin-console/) — TenantAdmin 向け管理画面 (姉妹 app)
- [`/problems/`](../../problems/) — 問題カタログ
