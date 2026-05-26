# Teardown

> English: [teardown.md](./teardown.md)

| 属性 | 値 |
|---|---|
| Audience | オペレータ (= イベントを clean に閉じる責任者) |
| 使うタイミング | 公表終了時刻から 24 時間以内。 Teardown を先送りしない。 Orphan リソースは課金され続ける。 |
| 所要時間 | Lite mode の典型イベントで 60 分。 複数チームに orphan があれば延長。 |
| 出力 | 全イベントスタックが `DELETE_COMPLETE` または明示的に archive 済み / 監査ログ export 完了 / 競技者 IAM Role の deprovision 状態を記録 |

Teardown runbook は [事前チェックリスト](./pre-event-checklist.ja.md) が開いたループを閉じます。 もっとも高くつく失敗は、 イベント終了後 1 年間 Lambda と DDB が課金され続けるパターンです。

## 必須の 3 出力

| # | 出力 | 重要性 |
|---|---|---|
| 1 | イベントスコープの CFn スタックがすべて `DELETE_COMPLETE`、 または書面の理由付きで 「Force ARCHIVED」 状態に移動済み | コスト制御。 Orphan は課金される。 |
| 2 | 監査ログ export を取得済み (CloudTrail / scoring 履歴 / 通知ログ) | SOC2 evidence と事後レビュー。 監査ログはプラットフォームそのものより長生きさせる必要がある。 |
| 3 | 競技者 IAM Role の deprovision (または期限失効) を記録済み | セキュリティ。 進行中イベントを伴わないクロスアカウント信頼は不要な attack surface。 |

## Step-by-step

### Step 0: イベントが本当に終わっているか確認 (5 分)

- [ ] Scoring loop が停止 (オペレータダッシュボードに active scoring job が無い)。
- [ ] 参加者が提出途中ではないこと。 最後の `info` 通知を 1 件:「イベントは HH:MM に終了しました。 以降の提出は scoring されません」。
- [ ] 進行中の deploy を完了させる (`make ops-health` で IN_PROGRESS ゼロを確認)。 Deploy 中に teardown を始めると orphan を作る。

### Step 1: 監査 evidence を先に回収 (10 分)

破壊を始める **前** に必ず実施。 スタック削除後はログ取得が難しくなる項目があります。

- [ ] イベント時間範囲の CloudTrail を S3 に export (本番 AWS 環境は通常 CloudTrail 配信済み。 未設定なら手動キャプチャ)。 SOC2 主 evidence。
- [ ] Scoring 履歴の export。 Scoring 用 DDB テーブルは TTL 失効まで履歴を保持するが、 関係チーム / イベントレコードを別建てでコピーしておく。
- [ ] Events テーブルから通知ログを export。 通知は edit / delete 不可 ([ADR-006](../architecture/adr-006-notifications.html)) のため、 当該テーブルが authoritative。
- [ ] [live monitoring](./live-monitoring.ja.md) のイベントタイムラインを同じアーカイブフォルダへ保存。

### Step 2: チーム別問題スタックを teardown (15 分)

各チーム × 各 deploy 問題の組について、 次を順に実施する。

- [ ] Application Admin Console の teardown action、 または Lite mode ローカル経路では `make destroy-battles BATTLES="problems/<category>/<id>" TEAM_SLUG=<slug>` で teardown を発行。
- [ ] Deploy trace に `deploy.cfn.delete.succeeded` が出ることを確認。
- [ ] チームの AWS アカウントで stack が `DELETE_COMPLETE` であることを確認 (= オペレータからのクロスアカウント DescribeStack、 またはチームに確認依頼)。

> **Force ARCHIVED 手順**。 スタックが `DELETE_FAILED` / `UPDATE_ROLLBACK_FAILED` に詰まった場合は、 次の手動シーケンスに従う。
>
> 1. 失敗を解析。 チームの AWS アカウントで CFn スタックを開き、 失敗 event を読む。
> 2. ブロッカーになるリソースを手動削除 (= 内容物のある S3 バケット / 使用中の EIP / 削除済み SG に紐づく ENI が頻出)。 各手動削除を teardown レポートに記録。
> 3. ブロッカー解除後にオペレータから `delete-stack` を再実行。
> 4. それでも削除できなければ、 運営シートに `ARCHIVED` と日付 / 残置リソース一覧を明記。 チームアカウントオーナーがフォローアップ責任を負う。 **「後で確認する」 で放置しない**。 文書化する。

### Step 3: プラットフォーム teardown (15 分)

- [ ] Lite mode: `make destroy` (= `bun run scripts/tenkacloud-lite.ts down`)。 `AppPlaneCore` と `ProblemDeployBackend` が `DELETE_COMPLETE` に到達することを確認。
- [ ] SaaS mode: `make destroy-saas` (= `scripts/cleanup.sh`)。 このスクリプトは意図的に idempotent。 前回失敗の残骸がある場合は再実行。
- [ ] Source bundle S3 バケットが空、 または lifecycle 削除予約済みであることを確認 (バケット自体はイベント間で残してよい。 中身の bundle が課金対象)。

### Step 4: 競技者 IAM Role を deprovision (10 分)

[competitor-bootstrap.yaml](../../infrastructure/templates/competitor-bootstrap.yaml) の IAM Role は各競技者アカウントに 1 度展開済み。 イベント後、 次を確認する。

- [ ] 各チームアカウントについて、 IAM Role スタックの削除を依頼するか、 保管期限を明文化 (例:「4 週間後の次回イベントまで保持」)。
- [ ] 処置 (deleted / retained-until-DATE) を SOC2 evidence として運営シートに記録。
- [ ] Role を保管する場合、 次回イベント前に ExternalId をローテーション。 同 ExternalId を分離イベントで再利用すると AssumeRole の保証が弱まる。

### Step 5: コスト確認 (5 分)

- [ ] イベント AWS アカウントの AWS Cost Explorer を開き、 teardown から 24 時間以内にコスト曲線が flat 化することを確認。
- [ ] コストが上がり続けるなら Step 2 へ戻る。 どこかに orphan がある。

### Step 6: 事後 issue 起票 (5 分)

- [ ] イベント / teardown 中に表面化した gap (= 不具合問題 / 遅延 scoring / Force ARCHIVED 中の手動削除など) ごとに GitHub issue を 1 件起票。
- [ ] 該当する場合は親 commercial-launch epic (#1336) にリンク。

## うまくいかなかったら

| 症状 | 1st response | エスカレーション |
|---|---|---|
| スタックが削除できない (`DELETE_FAILED`) | Step 2 の Force ARCHIVED 手順に従う。 ブロッカーを直さずに `delete-stack` をループしない。 | ブロッカーを特定できなければ、 stuck リソース一覧を添えてチームアカウントオーナーへエスカレーション。 |
| 監査ログ export が不完全 | Evidence 取得が終わるまで teardown を停止。 監査ログはプラットフォームそのものより長生きさせる必要がある。 | CloudTrail 未有効だったなら、 fix-forward issue を即起票。 不完全 evidence を黙認しない。 |
| Teardown 後もコストが累積 | Orphan リソースが存在。 AWS Cost Explorer をサービス単位で歩いて探す。 | 60 分以内に見つからなければ、 AWS アカウントオーナーへエスカレーション。 |
| チームが競技者 IAM Role を削除しない | 保管期限を明文化し、 次回イベント前に ExternalId をローテ。 | チームに連絡が付かない場合、 「open trust path」 を既知リスクとして文書化。 黙認しない。 |
| 複数スタックが同時に DELETE_FAILED | Region 規模の AWS 障害か依存抜けの可能性。 30 分待って再試行。 文脈は [インシデント対応](./incident-response.ja.md) のセクション 4 (CFn ROLLBACK) を参照。 | プラットフォーム全体の事後インシデントとしてエスカレーション。 [ADR-014](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) は状態が最終的に収束する前提なので、 時間を渡す。 |

## ループを閉じる

- 「うまくいったこと / 失敗したこと / 次の [事前チェックリスト](./pre-event-checklist.ja.md) サイクルで変えること」をまとめた事後レビュースレッドを起票 (問題別 follow up とは別建て)。
- 本 runbook がカバーしていない teardown gap を発見したら、 この runbook 自体を更新する。 Runbook は次のオペレータにとっての正本。

## 関連 runbook / ADR

- 前: [事前チェックリスト](./pre-event-checklist.ja.md) / [Dry run](./dry-run.ja.md) / [participant onboarding](./participant-onboarding.ja.md) / [live monitoring](./live-monitoring.ja.md) / [インシデント対応](./incident-response.ja.md)。
- 背景: [ADR-006: Notifications](../architecture/adr-006-notifications.html) (通知ログは teardown 前に必ずキャプチャ) / [ADR-014: EventBridge 駆動 state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) (状態は非同期収束。 焦って force しない)。
