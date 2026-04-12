# TenkaCloud Architecture Harness

この文書は、セッションが変わっても壊してはいけない原則を機械可読な ID つきで固定する正本です。

## Invariants

- `INVARIANT_SERVERLESS_ONLY`
  Control Plane と tenant ごとの Application Plane は serverless-only で構成する。常駐 compute を前提にしない。
- `INVARIANT_TENANT_IS_COMPANY`
  tenant は company 単位である。
- `INVARIANT_DEPARTMENT_IS_NOT_TENANT`
  department は tenant にしない。部署分割は tenant 境界ではない。
- `INVARIANT_ONE_APPLICATION_PLANE_PER_TENANT`
  1 tenant につき 1 Application Plane を配備する。
- `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME`
  Control Plane は tenant manager であり、tenant runtime host ではない。
- `INVARIANT_PROBLEM_RUNTIME_IN_COMPETITOR_AWS_ACCOUNTS`
  問題の runtime と課金対象リソースは competitor AWS accounts にのみ作る。

## One-Pass Acceptance

- `ONE_PASS_LOCAL`
  `make start-one-pass-local` 後に `make test_one_pass_local` が成功する。local は `Kumo` 等の cloud emulator を `http://localhost:4566`、`DynamoDB Local` を `http://localhost:8000` で使い分ける。対象は tenant 作成、provisioning、Application Plane 到達、local provider での problem deploy、event 作成、competitor account 登録、participant join、`attack / defense / vote`、`aws-console` の fail-closed 確認である。
- `ONE_PASS_AWS`
  [`docs/guides/one-pass-aws.md`](../guides/one-pass-aws.md) の runbook に従い、tenant 作成から participant 競技開始、STS federation による `aws-console` URL 取得まで local fallback なしで一気通貫する。

## Banned Assumptions

- platform account が tenant runtime を直接 host する前提
- Control Plane が competitor account へ直接 CloudFormation を流す前提
- tenant runtime を `ECS`, `EKS`, `Fargate`, `RDS`, `NAT Gateway` に依存させる前提
- 「見た目が出る」「一部 API が通る」を one-pass completion と見なす運用

## Enforcement

- `bun scripts/architecture-harness.ts --staged --fail-on=error`
- `bun scripts/ai-improvement-loop.ts --staged --fail-on=high`
- `make before-commit`

## Harness Commands

- Local strict run: `make test_one_pass_local`
- Local start with one-pass prerequisites: `make start-one-pass-local`
- AWS strict run: `make test_one_pass_aws`

`make test_one_pass_local` は未実装を `BLOCKED` として可視化し、non-zero で終了する。これにより `ONE_PASS_LOCAL` を partial success で完了扱いにしない。
local one-pass は `AUTH_SKIP_ROLES` のグローバル昇格ではなく、dev identity header で admin / participant を切り替える。

Git hook と AI エージェント向けガイドは、この文書を参照して同じ判定に従う。
