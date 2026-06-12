# Deploy chain trace logging 運用ガイド

[Issue #768](https://github.com/susumutomita/TenkaCloud/issues/768) で導入した end-to-end deploy trace log の使い方。 EventBridge → Step Functions → CodeBuild → Lambda → 競技者 account CloudFormation の長い経路を `jobId` 1 つで横断検索できるようにする。

## 設計の要点

| 項目 | 値 |
|---|---|
| log format | JSON 1 行 (= newline-delimited JSON in CloudWatch Logs) |
| 共通 field | `event` / `level` / `component` / `timestamp` / `jobId` / `correlationId` |
| `correlationId` の値 | 現状は `jobId` と同値 (= ULID)。将来 retry / fan-out が増えたら独立可能 |
| Lambda 経路 | `infrastructure/lib/problem-deploy/handlers/shared/trace-log.ts` の `logDeployTrace` / `warnDeployTrace` / `errorDeployTrace` |
| Shell 経路 | `scripts/lib/battles-common.sh` の `trace_log` (= 同じ JSON shape) |
| State Machine 経路 | `TENKACLOUD_CORRELATION_ID` env を CodeBuild に渡して shell から再 emit |

## イベント分類

`event` field は `deploy.<phase>.<outcome>` の dot-separated 形式。 横断 grep / Logs Insights filter で各 phase を抜けるように命名している。

### Lambda 境界 (= problem-deploy stack)

| event | 出所 | level | 主な field |
|---|---|---|---|
| `deploy.create.enqueued` | `deploy-handler/deploy.ts:startDeployment` | info | `tenantId`, `problemId`, `teamSlug`, `region`, `awsAccountId`, `namePrefix` |
| `deploy.delete.enqueued` | `deploy-handler/delete.ts:requestTeardown` | info | `tenantId`, `stackName`, `region`, `awsAccountId` |
| `deploy.eventbridge.publish.succeeded` | `shared/events.ts:publishProblemEvent` | info | `detailType`, `eventBusName`, `resource` |
| `deploy.describe-stack.start` | `describe-stack-handler/index.ts` | info | `tenantId`, `stackName`, `region`, `hasCompetitorRole` |
| `deploy.describe-stack.succeeded` | 同上 | info | `stackName`, `region`, `stackStatus`, `stackId` |
| `deploy.describe-stack.assume-role.grace-fallback` | 同上 | warn | `region`, `externalIdVersion` |

### Shell 境界 (= CodeBuild の deploy-battles.sh / delete-battles.sh)

| event | 出所 | level | 主な field |
|---|---|---|---|
| `deploy.codebuild.start` | `deploy-battles.sh:73` / `delete-battles.sh:33` | info | `operation` (= `create` / `delete`), `region`, `teamSlug` |
| `deploy.codebuild.succeeded` | `deploy-battles.sh:234` / `delete-battles.sh:109` | info | `operation`, `region`, `problemCount` |
| `deploy.codebuild.failed` | `deploy-battles.sh:238` | info | `operation`, `region`, `failureCount` |
| `deploy.cfn.deploy.start` | `deploy-battles.sh:188` | info | `stackName`, `region`, `teamSlug`, `problemDir` |
| `deploy.cfn.deploy.succeeded` | `deploy-battles.sh:210` | info | 同上 |
| `deploy.cfn.deploy.failed` | `deploy-battles.sh:206` | info | 同上 |
| `deploy.cfn.delete.start` | `delete-battles.sh:60` | info | `stackName`, `region` |
| `deploy.cfn.delete.succeeded` | `delete-battles.sh:108` | info | 同上 |
| `deploy.cfn.delete.failed` | `delete-battles.sh:43` / `:84` / `:102` | info | 同上 (`:43` は STS 失敗 = 検証前の credential 異常) |
| `deploy.cfn.delete.already_deleted` | `delete-battles.sh:80` / `:98` | info | 同上 (= 冪等 no-op、 stuck 復旧時に便利) |
| `deploy.cfn.delete.account_mismatch` | `delete-battles.sh:48` | info | `stackName`, `region`, `expectedAccount`, `actualAccount` (= #1797 credentials が stack の account と不一致。 delete-stack 発行前に loud fail し silent leak を防ぐ) |

Shell 経路の `correlationId` / `jobId` field は `TENKACLOUD_CORRELATION_ID` (現状 `PROBLEM_EXTERNAL_ID` と同値) を State Machine から伝搬する。 fallback として両 env のどちらか空でない方を採用する。

### Participant Portal SSO 境界 (= Issue #759)

| event | 出所 | level | 主な field |
|---|---|---|---|
| `portal.sso.not_ready.in_progress` | `participant-handler/sso.ts` (= status IN_PROGRESS / PENDING) | info | `jobId`, `problemId`, `status` |
| `portal.sso.not_ready.namePrefix_missing` | 同上 | info | `jobId`, `problemId`, `status` |
| `portal.sso.not_ready.region_missing` | 同上 | info | `jobId`, `problemId`, `status` |
| `portal.sso.not_ready.tenantId_missing` | 同上 | info | `jobId`, `problemId`, `status` |
| `portal.sso.not_ready.competitorRoleArn_missing` | 同上 | info | `jobId`, `problemId`, `tenantId` |
| `portal.sso.not_ready.participantViewerRole_missing` | 同上 | info | `jobId`, `problemId`, `tenantId`, `outputKeys` (= 世代不一致即特定用に CFn Outputs の他 key 一覧) |

SSO の `not_ready` 6 経路は旧実装ではすべてサイレントで、 operator が DDB item を引いて目視確認するしかなかった。 #759 で各 gate に structured log を 1 件 emit するようにし、 Insights query E (下記) で 1 引きに切り分け可能にした。

## CloudWatch Logs Insights クエリ

### A. jobId 1 つで全 phase を時系列に並べる (= 障害 triage の起点)

```
fields @timestamp, @log, event, level, stackName, region, stackStatus, detailType
| filter jobId = "01KRX..."
| sort @timestamp asc
| limit 200
```

`@log` 列でどの CloudWatch Logs group (= Lambda function / CodeBuild project) かが見える。 Logs Insights は複数 log group を同時 select できるので、 検索対象には次を全部入れる。

- `/aws/lambda/<problem-deploy stack>-DeployApiFunction*` (= startDeployment / requestTeardown)
- `/aws/lambda/<problem-deploy stack>-EventApiFunction*` (= bulk-deploy / bulk-delete)
- `/aws/lambda/<problem-deploy stack>-DescribeStackFunction*` (= cross-account describe)
- `/aws/codebuild/<DeployCodeBuildProject>-*` (= shell trace_log の出力)

### B. 失敗だけ抜き出して根本原因を 1 件 1 行で見る

```
fields @timestamp, jobId, event, stackName, region, level
| filter event like /\.failed$/ or level = "warn" or level = "error"
| sort @timestamp desc
| limit 100
```

`event` の suffix が `.failed` の行と、 `level=warn|error` の行をまとめる。 `correlationId` / `jobId` を後続クエリの起点に使う。

### C. 特定 stack の deploy / delete 状況を時系列で 1 ジョブだけ追う

```
fields @timestamp, event, level, stackStatus
| filter stackName = "tc-<problemId>-<teamSlug>"
| sort @timestamp asc
| limit 200
```

`describe-stack-handler` の出力に `stackStatus` が乗るので、 CFn の状態遷移と Lambda 側ロジックがズレた時間帯が即見える (= #762 / #758 の調査で使った)。

### D. cross-account AssumeRole の grace fallback を監視 (= rotation 直後のリスク監視)

```
fields @timestamp, jobId, region, externalIdVersion
| filter event = "deploy.describe-stack.assume-role.grace-fallback"
| sort @timestamp desc
| limit 50
```

連発しているなら ExternalId rotation 直後の窓に並走している兆候。 増加トレンドは `ExternalIdAudit` Lambda の metric と相関させる。

### E. SSO `not_ready` がどの gate で落ちたかを 1 引きで切り分け (= Issue #759)

```
fields @timestamp, jobId, problemId, event, status, tenantId, outputKeys
| filter event like /^portal\.sso\.not_ready\./
| sort @timestamp desc
| limit 100
```

特定 jobId に絞るときは `filter jobId = "01KRX..."` を AND 結合する。 `portal.sso.not_ready.participantViewerRole_missing` の `outputKeys` field を見ると、 問題 template が古い世代 (= `ParticipantViewerRoleArn` Output 不在) かどうかが他 outputs の有無で即判定できる。

## 実装方針 (= 後続 PR で増やすときの拘束)

1. **新規 trace event を増やすときは `event` field を `deploy.<phase>.<outcome>` 形式で命名する**。 既存名と衝突しないこと。 `phase` は CloudWatch Logs Insights で `like /^deploy\.cfn\./` 等の prefix filter を効かせやすいよう dot-separated に保つ。
2. **必ず `jobId` (or `correlationId`) を field に入れる**。 これが無いと jobId 検索 (= 受入条件) で行が落ちる。
3. **失敗経路は `.failed` suffix で揃える**。 クエリ B (= 失敗だけ抜く) が安定する。
4. **shell 側の `trace_log` 呼び出しは `key value key value ...` 形式**。 key は `[A-Za-z_][A-Za-z0-9_]*` のみ。 値は自動で JSON-escape される。
5. **正規表現 detect されにくい絵文字 / 多言語を field 名に入れない**。 ASCII の camelCase を維持する。

## 関連

- [Issue #768](https://github.com/susumutomita/TenkaCloud/issues/768): 本機能の起票元
- [Issue #733](https://github.com/susumutomita/TenkaCloud/issues/733): CloudWatch Dashboard 整備 (= 本 trace と相補)
- [ADR-014](../architecture/adr-014-eventbridge-driven-state-reconciliation.html): EventBridge 駆動の state reconciliation 設計 (= 本 trace は同 path 上の観測点を増やす)
- [Issue #759](https://github.com/susumutomita/TenkaCloud/issues/759): SSO 経路の observability gap (= 別 path、 別 PR で同じ trace 思想を再利用)
