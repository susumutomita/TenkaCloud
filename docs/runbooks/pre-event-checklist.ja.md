# 事前チェックリスト

> English: [pre-event-checklist.md](./pre-event-checklist.md)

| 属性 | 値 |
|---|---|
| Audience | Facilitator (= イベント運営の end-to-end オーナー) |
| 使うタイミング | T-7 日 / T-1 日 / T-0 朝の 3 セッションで段階的に実施 |
| 所要時間 | 各セッション 30 分 (合計 90 分) |
| 出力 | イベントを予定どおり開始できる green チェックリスト |

3 セッションに分割する理由は、 予算アラームや IdP 連携にはリードタイムが要るのに対し、 URL 配布は当日朝にしか意味を持たないからです。

> **ハードゲート**: 本番運用前に [Dry run](./dry-run.ja.md) を 7 日以内に必ず完了させてください。 T-7 のチェック「Dry run のスケジュール確保」がこれを担保します。

## T-7 日: 土台

### AWS 環境の準備

- [ ] イベントに使う AWS アカウントに、 オペレータがオンコール中に呼べる IAM Admin ユーザーが少なくとも 1 名いること。
- [ ] `infrastructure/environments/<env>/.env` が存在し、 `make env-check-lite` (Lite mode) または `make env-check` (SaaS mode) がエラーを返さないこと。
- [ ] 想定 problem catalog に応じた閾値の billing alarm をイベント AWS アカウントに設定済み。 Lite mode の単発イベントは `DynamoDbLowCapacity` aspect が強制する AWS Free Tier 25 RCU/WCU 枠に概ね収まるが、 チーム別 CFn スタックは別途コストが発生する。
- [ ] Source bundle 用 S3 バケットが存在すること (= 未作成なら `make prepare-source-bundle` を 1 度実行)。

### Deploy モードの決定

- [ ] Lite と SaaS のどちらで運用するかを決める。 複数テナント運用が必須でなければ Lite をデフォルトとする。 比較は [`docs/architecture/OVERVIEW.md`](../architecture/OVERVIEW.md) を参照。
- [ ] 選択結果を運営シートに明記する。 深夜のオンコールに推測させない。

### Problem catalog 選定

- [ ] [`problems/CATALOG.md`](../../problems/CATALOG.md) から 1 〜 5 問を選び、 `bun run scripts/tenkacloud-problem.ts validate <id>` で各問題を validate。
- [ ] Scoring kind の比率を確認する (= `flag` 1 つ、 `uptime-multi` 1 つ、 など)。 初回イベントで `phased-polling` を 3 問同時に走らせない。
- [ ] Problem catalog のバージョン (= `problems/` submodule SHA) を運営シートに pin する。

### チーム / 参加者リスト

- [ ] チーム名 / 想定参加人数 / 連絡先メールを含む最終チームリストを収集 / レビュー済み。
- [ ] 各チームが自前の AWS アカウントを持参するか、 主催者から払い出すかを決める。 持参の場合、 各チームは事前に `infrastructure/templates/competitor-bootstrap.yaml` を展開しておく必要がある。
- [ ] 参加者リストを運営シートに記録。

### 認証 / アクセス

- [ ] Application Admin Console で federated SSO を使う場合、 IdP 連携が完了済み。 [`docs/operations/application-plane-saml-setup.md`](../operations/application-plane-saml-setup.md) を参照。
- [ ] Cognito 単独運用の場合、 participant login key の配布チャネル (メール / Slack DM / 紙カード) を決定済み。

### コミュニケーションチャネル

- [ ] 参加者サポート用のプライマリチャネル (Slack workspace / Discord / 会場 MC) を整備済み。
- [ ] エスカレーション用セカンダリチャネル (オペレータ電話 / オンコールローテーション) を文書化済み。
- [ ] [ADR-006: Notifications](../architecture/adr-006-notifications.html) の `info` / `warning` 用テンプレートをドラフト済み (= 1 イベント `warning` 5 件以下、 ADR の rationale を参照)。

### Dry run の予定確保 (ハードゲート)

- [ ] [Dry run](./dry-run.ja.md) の実施日が直近 7 日以内のカレンダーに入っており、 本番と同じ problem catalog で実施することが確定している。

## T-1 日: 最終配線

### Deploy 検証

- [ ] イベント当日構成を pin したブランチで `make harness` と `make before-commit` が green。
- [ ] 直近 24 時間以内に `make deploy` (Lite) または `make deploy-saas` (SaaS) を当該環境で再実行済み。 `make lite-status` または SaaS install ログで全 stack が `CREATE_COMPLETE` / `UPDATE_COMPLETE` になっている。
- [ ] `make ops-health` で警告ゼロ (= orphan Lambda なし、 DDB に stuck deployment なし)。

### チーム別セットアップ

- [ ] チームごとの AWS Account ID と ExternalId が tenant metadata に登録済み。 ExternalId が無いとチーム AWS アカウントへの AssumeRole は拒否される (= soft check ではなくハード不変)。
- [ ] Participant portal URL (`make lite-portal-url` または SaaS CloudFront URL) が実際に開いてログイン画面を表示する。

### Notification dry run

- [ ] Application Admin Console から `info` を 1 件、 `warning` を 1 件送り、 participant portal が 1 polling tick 以内 (= 現状 5 秒、 [`docs/operations/notifications.md`](../operations/notifications.md) を参照) でレンダリングすることを確認。

### デモデータ / フォールバック

- [ ] 選定した各問題について、 ライブ AWS が不安定になった際の事前録画 / スクリーンショットを準備済み。
- [ ] サンプル participant login key で end-to-end ログインが成功することを確認済み。

### Sign off

- [ ] Facilitator が T-1 チェックリストに署名。 赤い行があれば、「今夜直す」か「明文化したリスクを受容する」かを必ず決定する。

## T-0 朝: 当日 kickoff

公表開始時刻の 60 〜 90 分前に着手します。

### 最終プラットフォーム確認

- [ ] `make ops-health` を再実行して 0 件異常を確認。
- [ ] Participant portal URL が依然ロードできる (= 稀な DNS / CloudFront 伝播の見落としをここで拾う)。
- [ ] 当該環境の CloudWatch ダッシュボードを開き、 オンコールオペレータが視認できる状態にする。

### 参加者への配布

- [ ] T-7 で決めたチャネルで participant login key (または SSO リンク) を配布。 トークポイントは [participant onboarding](./participant-onboarding.ja.md) を参照。
- [ ] Kickoff アナウンスのテンプレートをサポートチャネルへ投稿。
- [ ] 公表開始時刻の前に各チーム少なくとも 1 名がログイン済みであることを確認。

### オペレータ引継ぎ

- [ ] オンコールオペレータがオンラインで、 [live monitoring](./live-monitoring.ja.md) と [インシデント対応](./incident-response.ja.md) を読了している。
- [ ] 上記 2 ページをオペレータ用ブラウザにブックマーク済み。
- [ ] 電話の通知を ON。 エスカレーションチャネルを開いておく。

### Go / no-go

- [ ] 3 チーム以上がログインできない場合、 開始を保留して [インシデント対応](./incident-response.ja.md) で triage してから開始を宣言。
- [ ] 上記でなければ開始を宣言し、 [live monitoring](./live-monitoring.ja.md) に移行。

## うまくいかなかったら

| 症状 | 1st response | エスカレーション |
|---|---|---|
| Dry run を時間切れでスキップした | イベント自体を中止または延期する。 本番で dry run 漏れから安全に回復する経路は無い。 | 商業ステークホルダーに早期に連絡。 有料参加者の前で失敗するより、 再スケジュールが優先。 |
| T-1 で `make ops-health` が異常を返す | [インシデント対応](./incident-response.ja.md) を開いて分類し、 根本原因を直す。 既知異常を抱えたまま走らない。 | Stuck deployment であれば [インシデント対応](./incident-response.ja.md) の deploy stuck 分岐を参照。 |
| T-0 で参加者がログインできない | Login key / participant portal URL / Cognito 状態を確認。 大半は login key の末尾に空白が混入したケース。 | [インシデント対応](./incident-response.ja.md) の「Cognito sign in failure」を参照。 |
| イベント開始前に AWS budget alarm が発火 | 原因を理解するまで開始しない。 大半は前回 dry run の Lambda が走り続けているケース。 | 30 分以内に特定できなければ、 clean なイベント環境に切り替えるか再スケジュール。 |

## 関連 runbook / ADR

- 次: [Dry run](./dry-run.ja.md) — イベントの 7 日以内に実施。
- イベント中: [live monitoring](./live-monitoring.ja.md) / [インシデント対応](./incident-response.ja.md)。
- イベント後: [Teardown](./teardown.ja.md)。
- 背景: [ADR-006: Notifications](../architecture/adr-006-notifications.html) / [ADR-014: EventBridge 駆動 state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html)。
