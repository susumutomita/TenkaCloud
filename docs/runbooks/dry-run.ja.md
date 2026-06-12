# Dry run

> English: [dry-run.md](./dry-run.md)

| 属性 | 値 |
|---|---|
| Audience | オペレータ (= 本番でオンコールに入る人) |
| 使うタイミング | 本番 7 日以内。 必須前提であって任意ではない。 |
| 所要時間 | 90 分 (= 着手から終了まで) |
| 出力 | 発見した gap をすべて記録し、 修正済みまたは明示的に許容したかを sign off した dry run レポート |

Dry run が必要な理由は、 本番で問題になる失敗は誰も予期していないものだけだからです。 本番と同一設定で 1 度フローを通すのが、 そうした失敗をもっとも安価に発掘する手段です。

> **Dry run をスキップしない**。 スケジュール上不可能なら、 イベント自体を再調整する。 [事前チェックリスト T-7](./pre-event-checklist.ja.md#dry-run-%E3%81%AE%E4%BA%88%E5%AE%9A%E7%A2%BA%E4%BF%9D-%E3%83%8F%E3%83%BC%E3%83%89%E3%82%B2%E3%83%BC%E3%83%88) はこれをハードゲートとして扱う。

## Dry run のスコープ

参加者と同じ経路を必ず通すこと。

| レイヤ | 何を deploy / invoke するか | 何が拾えるか |
|---|---|---|
| Platform | Lite mode (`make deploy`) または SaaS mode (`make deploy-saas`) で当該環境 | IAM / Cognito / DNS の platform 層障害 |
| Problem catalog | 本番で出す全問題を 1 リハーサルチームに deploy | CFn template drift / region 制約 / アカウント quota |
| 参加者フロー | Participant portal にログイン / 問題を受領 / flag 提出か scoring 観測 | Scoring kind 誤設定 / portal slot 欠落 / endpoint 不通 |
| オペレータフロー | `info` / `warning` 通知の送信、 [`docs/operations/notifications.md`](../operations/notifications.md) で確認 | 通知配信失敗、 ADR-006 polling 遅延の体感 |
| Teardown | リハーサルチームのスタックを participant portal teardown UI で破棄 | 本番後にもっとも復旧しづらい teardown 失敗パターン |

End-to-end で通せない問題は「未準備」とみなし、 本番カタログから外すこと。

## Step-by-step

### Step 0: pre-flight (10 分)

- [ ] Dry run 用 AWS 環境が本番イベント環境と一致 (= 同 region / 同 Lite vs SaaS / 同 catalog pin) であることを確認。
- [ ] 検証対象ブランチで `make harness && make before-commit` が green。
- [ ] `infrastructure/templates/competitor-bootstrap.yaml` が展開済みのリハーサル AWS アカウントを 1 つ確保 (= または主催者払い出しフローを使う)。

### Step 1: Platform deploy (15 分)

- [ ] `make deploy` (Lite) または `make deploy-saas` (SaaS) を実行。
- [ ] すべての stack が `CREATE_COMPLETE` / `UPDATE_COMPLETE` に到達するまで待機。
- [ ] 出力 URL (`make lite-portal-url` / `make lite-console-url` / SaaS の Admin Console URL) を控える。

**うまくいかなかったら**: スタック失敗は本番でもっとも高くつく発見。 ここで失敗したら根本原因をデバッグし、 Step 0 から dry run をやり直す。「本番の deploy には存在しない手作業 fix」でごまかさない。

### Step 2: 各問題を deploy (20 分)

- [ ] 本番で出す各問題について `DeployCreateRequested` event を発行する (= Application Admin Console UI が正規入口)。
- [ ] [`docs/operations/deploy-trace.md`](../operations/deploy-trace.md) で deploy chain trace を観測。 想定 window 内に `deploy.cfn.deploy.succeeded` が出ることを確認。
- [ ] リハーサルチームの AWS アカウントで stack 名 / region / リソース一覧がテンプレート意図と一致することを確認。

**うまくいかなかったら**: 失敗 stack の CFn event を dry run レポートにキャプチャする。 region 固有の失敗なら、 本番までに「問題を落とす」か「region を変える」かを決める。

### Step 3: Participant portal フロー (15 分)

- [ ] ダミーのチームアカウントで participant portal にログイン。
- [ ] Deploy 済みの各問題が想定どおりの dashboard slot を描画していることを確認。
- [ ] Flag 提出 (`flag` scoring) / 1 polling tick 待機 (uptime / phased-polling) / 攻撃の trigger (`attack-detection`) を行い、 scoreboard に反映されることを確認。

**うまくいかなかったら**: Scoring の描画ずれは `metadata.json` の scoring kind が template 挙動と噛み合っていない signal。 platform ではなく metadata 側を直す。

### Step 4: オペレータフロー (10 分)

- [ ] 主催者として Application Admin Console を開く。
- [ ] `info` を 1 件、 `warning` を 1 件送る。
- [ ] Participant portal に 1 polling tick (= 5 秒、 [`docs/operations/notifications.md`](../operations/notifications.md)) 以内に両方表示されることを確認。
- [ ] ダッシュボード (CloudWatch / scoreboard) が期待どおり更新することを確認。

### Step 5: Teardown (15 分)

- [ ] Deploy した各問題について teardown を発行する。
- [ ] 各 stack が `DELETE_COMPLETE` に到達し、 deploy trace に `deploy.cfn.delete.succeeded` が出ることを確認。
- [ ] リハーサルチームアカウントに残存リソース (S3 バケット / ENI / EBS volume) が無いことを確認。 監査手順は [teardown runbook](./teardown.ja.md) を参照。

### Step 6: レポート (5 分)

- [ ] 発見した gap (= 問題不具合 / scoring 遅延 / portal 表記の混乱 / 通知欠落) を dry run レポートに記録する。
- [ ] 各 gap について「本番前に直す」か「リスクを受容する」かを明示する。

## うまくいかなかったら (全体)

| 症状 | 1st response | エスカレーション |
|---|---|---|
| 複数の問題が deploy 失敗 | Dry run が 「本番でも失敗する」 と告げている signal。 ここで止めて [インシデント対応](./incident-response.ja.md) で triage する。 | T-1 までに全失敗問題を解消できなければイベント再スケジュール。 |
| Scoring kind と portal 描画が噛み合わない | 当該 `metadata.json` を直し、 その問題だけ dry run を再実行。 | T-1 までに直せなければカタログから外す。 |
| Teardown でリソースが残る | 種別と手動 cleanup 経路を [teardown runbook](./teardown.ja.md) に書き残す。 | 残存リソースがコストを生むなら、 チームアカウントオーナーに即時エスカレーション。 |
| 通知配信が壊れている | EventBridge bus ARN 配線を [ADR-014](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) と突き合わせる。 | T-1 までに直らなければ、 通知無しで運用する旨を facilitator に共有。 |

## 関連 runbook / ADR

- 前: [事前チェックリスト](./pre-event-checklist.ja.md) (T-7 ゲート)。
- 次: [participant onboarding](./participant-onboarding.ja.md) / [live monitoring](./live-monitoring.ja.md)。
- イベント中: [インシデント対応](./incident-response.ja.md)。
- イベント後: [Teardown](./teardown.ja.md)。
- 背景: [ADR-006: Notifications](../architecture/adr-006-notifications.html) / [ADR-014: EventBridge 駆動 state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) / [`docs/operations/deploy-trace.md`](../operations/deploy-trace.md)。
