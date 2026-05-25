# Lite mode prerequisites

> 30-minute first-run checklist for `make deploy` (Lite mode). Read this before
> opening a fresh AWS account or copying `.env.example`. Issue [#1345](https://github.com/susumutomita/TenkaCloud/issues/1345).

Lite mode (= `make deploy`, the new default since #955) is the fastest path to a
running TenkaCloud event: one organizer, one AWS account, two CFn stacks
(AppPlaneCore + ProblemDeployBackend). This page lists everything you need
**before** that first `make deploy` so the deploy never trips on environment
preconditions.

If you prefer Japanese, jump to [日本語版](#日本語版).

---

## 1. AWS account assumptions

| Topic | Lite mode policy |
| --- | --- |
| Account type | A regular AWS account is fine. **Free Tier accounts are explicitly supported** — DynamoDB is provisioned 1 RCU / 1 WCU per table (CDK Aspect `DynamoDbLowCapacity`) so the platform fits inside the 25 RCU/WCU Free Tier budget. |
| Cost expectation | Idle: cents/day (DDB provisioned + S3 + CloudFront). Active event: dominated by competitor-account problem stacks (your account only hosts the platform). You are responsible for AWS charges. |
| Region | `ap-northeast-1` (Tokyo) is the recommended default. Other commercial regions also work; GovCloud / China regions are out of scope. |
| Account isolation | Lite mode deploys into the AWS account that the local AWS CLI is currently authenticated to. Competitor accounts are **separate** and are accessed via cross-account `AssumeRole` + `ExternalId`. |

## 2. Required IAM permissions

The IAM principal that runs `make deploy` needs:

- **CDK bootstrap** (one-time, per account+region): the AWS managed policy
  `AdministratorAccess` is sufficient. `make bootstrap` invokes `cdk bootstrap`
  which provisions `CDKToolkit` IAM roles.
- **CDK deploy** (every run): permissions to create / update / delete the AWS
  services used by the two Lite stacks. The minimum required service set:
  - `iam:*Role`, `iam:*Policy`, `iam:PassRole` (CDK creates execution roles)
  - `lambda:*Function`, `lambda:*Layer`, `lambda:*Permission`
  - `apigateway:*` (HTTP APIs)
  - `cognito-idp:*UserPool*`, `cognito-idp:*UserPoolClient*`, `cognito-idp:*UserPoolDomain*`
  - `dynamodb:CreateTable`, `dynamodb:UpdateTable`, `dynamodb:DeleteTable`, `dynamodb:DescribeTable`
  - `s3:*Bucket*`, `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`
  - `cloudfront:*Distribution*`, `cloudfront:*OriginAccessIdentity*`
  - `codebuild:*Project*` (the deploy worker builds CFn artifacts)
  - `events:*Rule*`, `events:*Bus*` (EventBridge for DeployRequested / DeployCompleted)
  - `states:*StateMachine*` (Step Functions orchestrator)
  - `ssm:GetParameter`, `ssm:PutParameter` (runtime config)
  - `cloudformation:*` (CDK uses CFn underneath)
  - `logs:*LogGroup*` (CloudWatch Logs)
- **Tenant Admin invite** (post-deploy step, runs via `cognito-idp admin-create-user`):
  - `cognito-idp:DescribeUserPoolDomain`
  - `cognito-idp:AdminGetUser`
  - `cognito-idp:AdminCreateUser`

For day-1 onboarding, attaching `AdministratorAccess` to the deployer principal
is the simplest path. Tighten to the list above for production-style operation.

## 3. Local tools

| Tool | Required version | Why |
| --- | --- | --- |
| Bun | 1.3.11+ | Package manager / runner (`make install`, `bun run`). |
| AWS CLI v2 | 2.13+ | `aws sts get-caller-identity`, Cognito user invite, CFn outputs. |
| Node.js | Bundled by Bun — not required separately. | — |
| Git | Any modern version | Submodule fetch (`git submodule update --init --recursive problems`). |

## 4. The first-run flow

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
make env-init               # interactive wizard for .env (Issue #1345)
make deploy                 # ~10 minutes for the 2 stacks
make lite-console-url       # prints Application Admin Console URL
make lite-portal-url        # prints Participant Portal URL
```

`make env-init` will prompt for three values:

- `TENANT_ADMIN_EMAIL` — inbox that receives the Cognito invitation email.
- `AWS_REGION` — defaults to `ap-northeast-1`.
- `CDK_PARAM_DEPLOY_EXTERNAL_ID` — opaque string used as the `ExternalId` when
  the platform AssumeRoles into competitor accounts. Any 2+ character value
  works; treat it as a shared secret with competitors.

If `.env` already exists, `env-init` skips so it stays idempotent. Delete the
file by hand if you want to regenerate.

## 5. Common failure modes and the recovery path

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `cdk deploy` fails with `is not authorized to perform` | IAM principal missing the permissions above | Attach `AdministratorAccess` for day 1, then trim. |
| `cdk deploy` fails with `has not been bootstrapped` | First-time CDK in this account+region | `make bootstrap` |
| `cdk deploy` fails with `Token has expired` | AWS SSO セッション expired | `aws sso login` (or re-export creds), then re-run. |
| `make destroy` shows `does not exist` on one stack | Partial deploy, one stack rolled back / missing | Safe to ignore. The other stack will still be cleaned up. |
| Tenant Admin email never arrives | Wrong inbox / SES sandbox / Cognito email queue | `aws cognito-idp admin-resend-invitation` or recreate via `make deploy` (idempotent). |
| `Application Admin Console` shows a blank page | CloudFront cache | Wait 2–5 min after deploy, then hard reload. |
| Region mismatch between `.env` and local AWS CLI | `.env` says `ap-northeast-1` but CLI セッション is `us-east-1` | Set `AWS_REGION` in both, or `export AWS_REGION=...` in shell. |

If anything goes wrong, the safe rollback is always:

```bash
make destroy        # answers y to the confirmation prompt
make deploy
```

The two Lite stacks have `RemovalPolicy=DESTROY` and the destroy is idempotent
from any partial state.

## 6. What to do after `make deploy` succeeds

The `make deploy` exit banner prints the next steps. In short:

1. Sign in to the Application Admin Console using the temp password from the
   Cognito invite email.
2. Create an event called `Demo` (any name works).
3. From the Problems tab, deploy `hello-world` to your local team.
4. Open the Participant Portal URL and watch the flag submission flow.

For deeper context, see:

- [README.md](../README.md) — overall Quickstart and problem catalog.
- [`docs/architecture/OVERVIEW.md`](./architecture/OVERVIEW.md) — the 4 planes.
- [`infrastructure/templates/README.md`](../infrastructure/templates/README.md) — competitor-side IAM setup.

---

## 日本語版

`make deploy` (Lite mode) を初めて叩く前に確認すべき前提条件まとめ。 30 分以内の
first-run 体験 (= [Issue #1345](https://github.com/susumutomita/TenkaCloud/issues/1345)) を実現するための checklist。

### 1. AWS アカウント前提

| 項目 | Lite mode の方針 |
| --- | --- |
| アカウント種別 | 通常の AWS アカウントで OK。 **Free Tier アカウントは明示サポート対象** (CDK Aspect `DynamoDbLowCapacity` が DDB を 1 RCU / 1 WCU に強制するため、 25 RCU/WCU Free Tier 枠に収まる)。 |
| 想定コスト | 待機中: 1 日数セント (DDB provisioned + S3 + CloudFront)。 イベント中: 競技者アカウント側の問題 stack が支配的 (プラットフォーム本体は組織者アカウントのみ)。 AWS 課金は user 責任。 |
| リージョン | `ap-northeast-1` (東京) が推奨。 他の商用 region でも動作。 GovCloud / China region は対象外。 |
| アカウント境界 | Lite mode は手元の AWS CLI が認証している account に deploy される。 競技者アカウントは **別アカウント** で、 cross-account `AssumeRole` + `ExternalId` でアクセスする。 |

### 2. 必要 IAM 権限

`make deploy` を叩く principal が必要とする権限は次のとおりです。

- **CDK bootstrap** (account+region 単位で 1 回): `AdministratorAccess` で十分。 `make bootstrap` が `cdk bootstrap` を呼んで `CDKToolkit` の IAM role を作る。
- **CDK deploy** (毎回): Lite 2 stack で使う AWS サービスの create / update / delete 権限。 最小サービスセットは英語版を参照。
- **Tenant Admin 招待** (deploy 後 `cognito-idp admin-create-user` で実行):
  - `cognito-idp:DescribeUserPoolDomain`
  - `cognito-idp:AdminGetUser`
  - `cognito-idp:AdminCreateUser`

初日は `AdministratorAccess` を deployer に付与するのが最短。 本番運用に近づく段階で
英語版のリストにまで絞り込む。

### 3. ローカルツール

| ツール | 必要バージョン | 用途 |
| --- | --- | --- |
| Bun | 1.3.11+ | パッケージマネージャ / runner |
| AWS CLI v2 | 2.13+ | `sts get-caller-identity` / Cognito 招待 / CFn outputs |
| Git | 任意の modern 版 | Submodule fetch |

### 4. 初回フロー

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
make env-init               # .env 対話 wizard (Issue #1345)
make deploy                 # 約 10 分で 2 stack 立ち上げ
make lite-console-url       # Application Admin Console URL を表示
make lite-portal-url        # Participant Portal URL を表示
```

`make env-init` は次の 3 つの値を対話で聞きます。

- `TENANT_ADMIN_EMAIL` — Cognito 招待メールの宛先。
- `AWS_REGION` — default は `ap-northeast-1`。
- `CDK_PARAM_DEPLOY_EXTERNAL_ID` — 競技者アカウントへの AssumeRole で使う ExternalId。 任意の 2 文字以上の文字列。

`.env` が既にあれば skip (idempotent)。 再生成したいときは手動で削除する。

### 5. よくある失敗パターンと回避

| 症状 | 原因の可能性 | 対処 |
| --- | --- | --- |
| `cdk deploy` が `is not authorized to perform` で失敗 | IAM 権限不足 | 初日は `AdministratorAccess` を付与、 本番化で絞る。 |
| `cdk deploy` が `has not been bootstrapped` で失敗 | この account+region で CDK 初回 | `make bootstrap` |
| `cdk deploy` が `Token has expired` で失敗 | AWS SSO セッション切れ | `aws sso login` / credential 再取得 |
| `make destroy` で「stack does not exist」 | 中途半端な deploy で片方の stack が rollback | 無視可。 もう片方は削除される。 |
| Tenant Admin にメールが届かない | inbox 違い / SES sandbox / Cognito キュー | `aws cognito-idp admin-resend-invitation` で再送、 または `make deploy` 再実行 (idempotent)。 |
| Console が空白 | CloudFront cache | deploy 後 2-5 分待ってハードリロード。 |
| `.env` の region と CLI region が一致しない | 別 region で deploy されている | `AWS_REGION` を両方で揃える、 または shell で `export AWS_REGION=...`。 |

失敗時の safe な復旧は常に次の手順で行います。

```bash
make destroy        # y/N 確認に y で答える
make deploy
```

Lite 2 stack は `RemovalPolicy=DESTROY`、 partial state からでも idempotent に teardown できる。

### 6. `make deploy` 成功後の next step

deploy 完了時に terminal に出る banner が一次情報になります。要約は次のとおりです。

1. Cognito 招待メールの一時パスワードで Application Admin Console にサインイン。
2. 「Demo」という名前で event を作成。
3. Problems タブから `hello-world` を deploy。
4. Participant Portal の URL を team に共有 (login key は event 作成時に発行)。

詳細は [README.md](../README.md) の Quickstart 章、 アーキ全体像は
[`docs/architecture/OVERVIEW.md`](./architecture/OVERVIEW.md) を参照。
