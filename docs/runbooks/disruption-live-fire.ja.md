# Disruption live-fire — クロスアカウントの実障害 + 自動復旧を観測する

> English: [disruption-live-fire.md](./disruption-live-fire.md)

| 項目 | 内容 |
|---|---|
| 対象者 | 実 AWS アカウントでレッドチーム disruption の経路を検証する operator |
| 使う時 | リリースごとに 1 回、クロスアカウント disruption chain ([#1419](https://github.com/susumutomita/TenkaCloud/issues/1419) / [#1666](https://github.com/susumutomita/TenkaCloud/issues/1666)) が**観測可能な障害**を注入し**自動復旧**することを証明する |
| 所要時間 | 約 10 分（team が 1 つ deploy 済みであること） |
| 成果物 | `healthy → FAULTED → recovered` を示す `evidence.json`、executor Lambda のログ、audit 行 |

fire → inject → revert の chain は実装済みで、mock SDK でのユニットテストも通っている（operator fire → EventBridge → executor Lambda → `ExternalId` 付き `AssumeRole` で競技者アカウントへ → SSM `RunCommand` → 予約された revert）。mock では「実 stack に障害が着地し、時間内に復旧する」ことは証明できない。この runbook がそれを実行し、#1419/#1666 を閉じる証拠を取る。

## 前提

| # | 必要なもの |
|---|---|
| 1 | Platform が deploy 済み（`make deploy-saas`、または Lite の `make deploy`）で、disruption executor Lambda + EventBridge rule が live |
| 2 | 1 つの team が **security-battle-royale** を競技者アカウントへ deploy 済み（`competitor-bootstrap.yaml` role 配備、`CDK_PARAM_DEPLOY_EXTERNAL_ID` で `ExternalId` 設定済み） |
| 3 | team の app に到達可能：deployment の stack outputs から `Ec2HostHint` を控える。health URL は `http://<Ec2HostHint>:8080/api/v1/apistatus` |
| 4 | **operator** の bearer token（`TenantAdmin` か `TenantOperator` role の Cognito JWT）。Application Admin Console のセッションから取得（ブラウザの dev-tools → request の `authorization` header） |

デフォルトの対象 disruption は **`availability-flood`**（`ssm-run-command`）。team 自身の EC2 から `localhost` へ向けた制限付き HTTP flood で単一 Flask プロセスを約 30 秒飽和させ、`uptime-multi` scorer が slot の失敗を検知する。予約された revert（`afterSeconds: 90`）が残った負荷を kill する（ADR-029 INV-2 — いかなる disruption も永続しない）。

## Step 1 — 送信する request を確認（AWS も token も不要）

```bash
bun run scripts/disruption-live-fire.ts --dry-run \
  --api https://<event-api-id>.execute-api.<region>.amazonaws.com \
  --event <eventId> --team <teamId> \
  --app-url http://<Ec2HostHint>:8080/api/v1/apistatus
```

実際に送る `POST /events/<eventId>/disruptions/fire` の body をそのまま表示する。live 呼び出し前に意図と照合する（request builder は `DisruptionFireRequestSchema` と同型で、ユニットテスト済み）。

## Step 2 — fire して証拠を取る

```bash
export DISRUPTION_JWT='<operator-bearer-token>'
bun run scripts/disruption-live-fire.ts \
  --api https://<event-api-id>.execute-api.<region>.amazonaws.com \
  --event <eventId> --team <teamId> \
  --app-url http://<Ec2HostHint>:8080/api/v1/apistatus \
  --evidence evidence.json
```

script は baseline を probe（healthy でなければ中断）→ fire → health URL を 5 秒ごとに 180 秒 poll → timeline を判定 → `evidence.json` を書き出す。

次のように手動 `curl` でも fire できます（script はこれを自動化しているだけ）。

```bash
curl -X POST "https://<event-api-id>.execute-api.<region>.amazonaws.com/events/<eventId>/disruptions/fire" \
  -H "authorization: Bearer $DISRUPTION_JWT" -H "content-type: application/json" \
  -d '{"problemId":"security-battle-royale","disruptionId":"availability-flood","scope":"team","targetTeamIds":["<teamId>"],"requestId":"live-fire-0001abcd"}'
```

## Step 3 — verdict を読む

| Verdict | 意味 | 何を示すか |
|---|---|---|
| `PASS` | window 内で `healthy → FAULTED → recovered` | chain が実障害を注入し**かつ**自動復旧した — #1419/#1666 達成 |
| `no-fault` | fire 後も unhealthy にならない | disruption が stack に**届いていない**（executor Lambda ログ / `ExternalId` の trust / `InstanceId` stack output を確認） |
| `no-recovery` | 障害は起きたが復旧しない（または遅い） | inject は成功、revert が失敗 — 予約 revert を調査（ADR-029 INV-2） |
| `no-baseline` | fire 前から unhealthy | 先に deployment を直す。fire に障害を帰属できない |

## 残す証拠

1. `evidence.json` — sample した timeline + verdict。
2. **executor Lambda** の CloudWatch ログ（`disruption-executor`）の fire 前後 — `AssumeRole` + `SendCommand` + 予約 revert が見える。
3. **audit 行**：`GET /events/<eventId>/disruptions/audit` が fire 記録（auditId、scope、対象 team）を返す。

これらが揃えば、技術的 disruption が監査だけの no-op ではなく、実際に自己修復する障害を注入していることの live な証明になる。
