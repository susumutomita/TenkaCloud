# イベント運用監視 Runbook

Issue #2406。採点停止と月次コスト逸脱を運営者が気付けるようにするための監視手順。

## 有効化

`CDK_PARAM_OPS_ALERT_EMAIL` を設定したときだけ、`ProblemDeployBackendStack` が監視 resources を作る。
未設定なら **SNS topic / CloudWatch alarm / AWS Budget は 1 つも作らない**。通知先が未確認のまま半端な監視だけが残る状態を避けるため。

```bash
CDK_PARAM_OPS_ALERT_EMAIL=ops@example.com
CDK_PARAM_OPS_MONTHLY_COST_LIMIT_USD=10
CDK_PARAM_OPS_BUDGET_THRESHOLD_PERCENT=100
```

- `CDK_PARAM_OPS_ALERT_EMAIL`: SNS email subscription の宛先。初回 deploy 後、AWS から届く確認メールを承認する。
- `CDK_PARAM_OPS_MONTHLY_COST_LIMIT_USD`: AWS Budgets の月次上限。未設定なら 10 USD。
- `CDK_PARAM_OPS_BUDGET_THRESHOLD_PERCENT`: budget 通知のしきい値。未設定なら 100％。

## 作られる監視

| 対象 | 実装 | 通知条件 |
| --- | --- | --- |
| 採点エラー | CloudWatch Alarm (`AWS/Lambda Errors`) | GenericScoring Lambda の 5 分合計 Errors が 0 を超えた |
| 採点停止 | CloudWatch Alarm (`AWS/Lambda Invocations`) | GenericScoring Lambda の 1 分 invocations が 5 分連続で 1 未満 |
| 月次コスト逸脱 | `AWS::Budgets::Budget` + SNS | 月次実課金が設定額のしきい値を超えた |

CloudWatch alarms は 2 件だけ。SNS email と AWS Budgets の先頭 2 件無料枠に収まるため、idle 時の有料 resource は増やさない。

## 対応手順

### 採点エラー

1. CloudWatch Logs で `GenericScoring` Lambda の直近エラーを確認する。
2. エラーが catalog metadata / endpoint override / 外部 runtime credential に由来するか切り分ける。
3. イベント中なら application-admin-console の leaderboard と team score events を見て、採点反映が止まっていないか確認する。
4. 一時対応が必要なら対象問題の endpoint override または runtime credential を直し、次の 1 分 tick で復旧するか確認する。

### 採点停止

1. EventBridge rule (`GenericScoring/Schedule`) が有効か確認する。
2. Lambda reserved concurrency / throttles / permission の異常を確認する。
3. 手動で Lambda test invoke し、Invocations metric が戻るか確認する。
4. イベント中に復旧できない場合は、採点結果を freeze し、参加者へ運営通知を出す。

### Budget breach

1. AWS Billing / Cost Explorer で当月の増分 service を確認する。
2. DynamoDB capacity の戻し忘れ、CloudWatch Logs retention、S3 artifact の残りを優先して確認する。
3. イベント後なら `docs/operations/dynamodb-event-capacity.md` の scale-down 手順で event-hot tables を 1/1 に戻す。
4. 監視が正常に届くことは CI では確認できないため、初回有効化時は一度 deploy して SNS confirmation と alarm delivery を live 確認する。
