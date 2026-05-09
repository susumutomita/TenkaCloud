# ADR-002: 競技者 AWS アカウント への federation を tenant 単位 ExternalId + 専用 DDB + SSM SecureString で管理する

- **Status**: Accepted (2026-05-09) — Issue 459 の A/B/C/D 設計判断はこの ADR で確定。
  実装は Phase 2.1 / 2.2 / 3 で段階的に進める (= 後述「Implementation ownership」)。
- **Related issues**: Issue 459 (cross-account federation 設計)、Issue 458 (publish 経路統一 ✅ 完了)
- **Related ADR**: [ADR-001](./adr-001-problem-deploy-crud.md) (本 ADR は ADR-001 の Decision 6「cross-account 越境」をさらに具体化する)

## Context

ADR-001 で「問題 deploy 系の publish 経路は tenant API + EventBridge + Step Functions」「CFn API は cross-account AssumeRole 経由」を確定した。本 ADR は **AssumeRole する先を「どの ExternalId で / どこに保存された」値で決めるか** を確定する。

要件文書 [`docs/requirements/problem-deploy.md`](../requirements/problem-deploy.md) の制約のうち、本 ADR を駆動するものは次のとおり。

- **NFR-2**: operator は TenkaCloud 自社 AWS account を触らない (operator は tenant 内のみ)
- **NFR-3**: 競技者アカウントは AWS Organizations 共有が使えない野良 account を含む (= per-account の federation が必要)
- **CLAUDE.md `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER`**: テナント分離はインフラ層で実現
- **CLAUDE.md `INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER`**: 認証はインフラ層で注入
- **CLAUDE.md `secrets-manager-forbidden`**: SSM Parameter Store SecureString を使う (Secrets Manager 禁止)
- **`DynamoDbLowCapacity` Aspect**: 全テーブル 1 RCU / 1 WCU 強制

### 現状 (Phase 1) の federation 仕組み

| 項目 | 現状 | 問題点 |
|---|---|---|
| ExternalId | TenkaCloud 全体で 1 個の env (`CDK_PARAM_DEPLOY_EXTERNAL_ID`、default `tenkacloud-dev-external-id`) | 1 個漏れたら全 competitor account に影響。Confused Deputy 対策として実質不足 |
| Competitor Role 名 | 単一 default `TenkaCloud-CompetitorDeploy-Role` | 競技者側で名前を変えると即崩壊。tenant ごとに違う名前を許す余地なし |
| Tenant ↔ 競技者アカウントの紐付け | **存在しない**。DeployForm で operator が `awsAccountId` を毎回手入力 | typo した別 account を入れれば 401/403 で落ちるだけで誤 deploy 防御弱い |
| 競技者 Bootstrap | `infrastructure/templates/competitor-bootstrap.yaml` を 1 回 deploy | 全 tenant 共通の ExternalId を競技者が知る必要がある |
| 鍵ローテーション | 仕組み無し | ExternalId 変えるなら全 competitor / 全 worker に手作業伝搬 |

## Decision

### 1. ExternalId は tenant 単位で発行する (= A2)

- 1 tenant 配下の複数 competitor account は **同じ ExternalId** を共有する
- 別 tenant とは ExternalId が必ず異なる
- 漏洩時の blast RADIUS は当該 tenant の全 competitor account で打ち止め

(tenant, account) ペアごと (= A3) は管理が複雑化する割に Confused Deputy 防御は A2 でも十分強い (= AWS 推奨もコンテキスト単位、すべての顧客単位の弱者運用は推奨されていない)。Phase 3 以降に必要性が出たら edge 単位に縮められる構造を残す (= A2 → A3 への移行は新 ExternalId を発行して per-edge に migrate するだけで、A1 → A2 のような全 reset は要らない)。

### 2. メタデータは新 DDB `CompetitorAccounts`、ExternalId は SSM SecureString (= B2 + B3)

#### 2.1 `CompetitorAccounts` DDB schema

| 属性 | 型 | 説明 |
|---|---|---|
| `PK` | String | `TENANT#{tenantId}` |
| `SK` | String | `ACCOUNT#{awsAccountId}` |
| `tenantId` | String | tenant 内表示用 |
| `awsAccountId` | String | 12 桁の AWS Account ID |
| `region` | String | 主たる deploy region (デフォルト `ap-northeast-1`) |
| `competitorRoleName` | String | 競技者 bootstrap で deploy された IAM Role 名 |
| `alias` | String? | operator 表示用ラベル (例 "Team Acme prod") |
| `verified` | Boolean | STS AssumeRole sanity check が通ったか |
| `verifiedAt` | String? | ISO 8601、verified=true 化したときの時刻 |
| `createdAt` | String | ISO 8601 |
| `updatedAt` | String | ISO 8601 |

- `BillingMode = PROVISIONED 1/1` (`DynamoDbLowCapacity` Aspect で強制)
- ExternalId は **本テーブルに保存しない** (= 2.2 SSM 側に置く)
- GSI: 不要 (PK 単一で tenant 内一覧、Get で SK 直接 lookup)

#### 2.2 SSM Parameter Store SecureString path 規約

```
/{env}/tenants/{tenantId}/external-id
```

- 1 tenant 1 値 (Decision 1 = A2 と整合)
- KMS は AWS managed (`alias/aws/ssm`、コスト 0)
- Worker Lambda の IAM policy は `ssm:GetParameter` を path prefix で許可:
  - resource: `arn:aws:ssm:{region}:{account}:parameter/{env}/tenants/${aws:PrincipalTag/tenantId}/external-id` ← セッション tag が無いケース用に **fallback で `parameter/{env}/tenants/*/external-id` も書く** (Phase 1.5 暫定。Phase 2 でセッション tag injection を Cognito identity propagation で実装済んだら絞る)
- Lambda は cold start で読み込まず、deployment 行の `tenantId` から都度 GetParameter (warm cache 5 分 TTL は SDK の middleware で十分)

#### 2.3 なぜ DDB と SSM の二段か

- DDB は人間が見る tenant 管理メタデータ (alias / verified / region)
- SSM は machine-only な秘密 (ExternalId)
- 同じ DDB 行に ExternalId を入れると、誤って `Scan` 結果や CloudWatch log に流出する経路が生える (`secrets-manager-forbidden` 原則)
- `secrets-manager-forbidden` は Secrets Manager の高コスト (= $0.40/secret/月 + API call) を避けるためで、SSM SecureString は無料

### 3. Onboarding は 5-step で完結する (= C)

```text
[1] operator が application-admin-console / Competitor Accounts 画面で「Add account」
[2] frontend → tenant API → 新 endpoint POST /tenants/{me}/accounts
       backend が下記を 1 transaction で実行:
         - SSM SecureString に random 32 文字 ExternalId を Put (`/{env}/tenants/{tenantId}/external-id` 既存なら no-op)
         - DDB CompetitorAccounts に row 追加 (verified=false)
         - 戻り値: { externalId, tenkaCloudAccountId, bootstrapTemplateUrl }
[3] operator が画面に表示された 3 値を競技者にコピペ送信
       (or "Open in CloudFormation 1-click" link を競技者に送る)
[4] 競技者が `competitor-bootstrap.yaml` を自分のアカウントで deploy
       Parameter: ExternalId, TrustedAccountId (= TenkaCloud account ID)
[5] operator が画面で「Verify」ボタン
       backend が STS AssumeRole で sanity check → DDB.verified = true
```

#### 3.1 「Add account」が冪等

- 同じ tenant で 2 度目の Add は ExternalId を **回さない** (SSM Put で `Overwrite=false` 相当のロジック)
- DDB row は account ごとに 1 つなので、同じ awsAccountId を再 Add すると 409 Conflict

#### 3.2 「Verify」失敗時の表示

- 失敗理由は STS の `ErrorCode` (AccessDenied / ExternalIdMismatch / AssumeRoleFailed) を operator に表示
- 失敗 row は DDB に残し `verified=false` のまま (削除はしない、operator が原因解決後に再 Verify できる)

### 4. DeployForm は drop-down で verified account から選ぶ (自由入力廃止)

- frontend `DeployForm.tsx` の `awsAccountId` 自由入力 input を **撤廃**
- 代わりに `useCompetitorAccounts()` hook で `verified=true` の row を引き、`<Select>` で表示
- verified=false の row は選択肢に出ない (UI 側 + backend 側両方で防御)
- alias 列があれば `${alias} (${awsAccountId})`、無ければ `${awsAccountId}` を表示

### 5. legacy `CDK_PARAM_DEPLOY_EXTERNAL_ID` env は dev fallback として残す (= D)

- env 名を `CDK_PARAM_DEPLOY_EXTERNAL_ID_DEV_FALLBACK` に rename
- 本番経路 (Worker Lambda の AssumeRole) は **必ず SSM から読む**
- dev fallback env は CDK synth 時の bootstrap-stack 作成で 1 度だけ使う (ローカル開発で SSM が無い状態でも synth が通るように)
- `bin/infrastructure.ts` から「単一 env を全 worker に注入する」ロジックを削除

## Implementation ownership

`AGENTS.md` の役割分担に従い、CDK / IAM / CFn template / `bin/infrastructure.ts` 関連は
**user 担当**、apps / Lambda handler ロジック / docs は **Claude 担当** とする。

| 領域 | Owner | 備考 |
| ---- | ----- | ---- |
| `CompetitorAccountsTable` CDK construct (新規) | **user** | DDB schema、`DynamoDbLowCapacity` Aspect 整合の確認込み |
| SSM SecureString helper construct + IAM policy | **user** | `ssm:GetParameter` の resource 絞り込み、KMS managed key の参照 |
| tenant API Gateway 新 routes (`/tenants/{me}/accounts*`) の `addResource/addMethod` 配線 | **user** | 既存 `api-gateway.ts` の延長 |
| `bin/infrastructure.ts` の env 整理 (`CDK_PARAM_DEPLOY_EXTERNAL_ID` → `..._DEV_FALLBACK` rename) | **user** | env 注入経路の見直し |
| `competitor-bootstrap.yaml` の Parameter 説明文改訂 | **user** | CFn template (= IAM Role 定義) は user 領域 |
| 新 Lambda handler (`/tenants/{me}/accounts*` の Hono route 実装) | **Claude** | DDB CRUD + SSM Put/Delete のロジック、テスト込み |
| Worker Lambda の AssumeRole 経路書き換え (`externalId` を deployment 行 / SSM から読む) | **Claude** | env 廃止に合わせて handler 側の書き換えとテスト |
| application-admin-console「Competitor Accounts」画面 (一覧 / 追加 / verify / 削除) | **Claude** | Cloudscape Cards / Modal / Form |
| `DeployForm.tsx` の AWS Account ID 自由入力 → verified Select 置換 | **Claude** | `useCompetitorAccounts()` hook + UI |
| Lambda + frontend のテスト | **Claude** | infra の test (`Template.fromStack`) は user |
| `infrastructure/templates/README.md` 改訂 | **Claude** | docs |

着手順は次のとおり。

1. **user** が Phase 2.1 の CDK 部分 (DDB / SSM helper / API GW route 配線) を 1 PR で出す。
2. **Claude** が直後に Lambda handler + frontend を 1〜2 PR で続ける。同 PR 内で legacy
   env を読むコードを同 commit で撤去する (CLAUDE.md「fallback 禁止」原則と整合)。
3. Phase 2.2 の migration script (旧 deployment 行の `externalId` 補填) は **Claude** が書き、
   ただし script を回す deploy は **user** が手動で実施する。

## Migration

### Phase 2.1 (本 ADR を実装する PR)

1. `CompetitorAccountsTable` (新 DDB) construct を追加 (`infrastructure/lib/competitor-accounts/`)
2. SSM SecureString helper (`infrastructure/lib/utils/external-id-store.ts`) を追加
3. tenant API に `POST /tenants/{me}/accounts` / `GET /tenants/{me}/accounts` / `POST /tenants/{me}/accounts/{accountId}/verify` / `DELETE /tenants/{me}/accounts/{accountId}` を追加
4. application-admin-console に「Competitor Accounts」画面を追加
5. DeployForm の `awsAccountId` 自由入力を Select に置き換え
6. Worker Lambda が deployment 行の `awsAccountId` から `(externalId, competitorRoleName)` を解決するよう書き換え

### Phase 2.2 (legacy env 撤去)

1. 旧 deployment 行 (env-based ExternalId) を migration script で `externalId` フィールドを既存 env 値で埋める (現行運用が `tenkacloud-dev-external-id` の 1 値なので一括 update)
2. `CDK_PARAM_DEPLOY_EXTERNAL_ID` を `CDK_PARAM_DEPLOY_EXTERNAL_ID_DEV_FALLBACK` に rename + 旧名のコード参照を撤去
3. `infrastructure/templates/competitor-bootstrap.yaml` の Parameter 説明文を「tenant 個別の ExternalId を使うこと」に更新
4. `infrastructure/templates/README.md` に新 onboarding フローを記載

### Phase 3 (rotation)

- ExternalId rotation API (`POST /tenants/{me}/accounts/{accountId}/rotate-external-id`) を追加
- rotation 時は新値を SSM に Put (旧値は version として 7 日残す = SSM Parameter version 機能)
- 競技者には新 ExternalId と CFn update 手順を画面で案内

## Consequences

### Positive

- ExternalId 漏洩 blast RADIUS が 1 tenant に閉じる (Decision 1)
- operator の「typo した別 account を入れて 401」事故が消える (Decision 4 = 自由入力廃止)
- 「verified」概念で onboarding 進捗が可視化される (operator が「この account は使えるんだっけ」を画面で判別可能)
- SSM SecureString は KMS managed key + IAM 制御で監査可能、Secrets Manager より安い (`secrets-manager-forbidden` と整合)
- legacy env を escape hatch として残すことで dev / single-tenant ローカル開発が壊れない

### Negative

- 競技者は tenant 切替時に新しい ExternalId で `competitor-bootstrap.yaml` を再 deploy する必要がある
- DDB と SSM の二段管理で「片方だけ存在する」不整合が起きうる (=「Add account」を 1 transaction 化 +「Delete account」で SSM 側も同時削除する責務を backend が持つ必要)

### Unknown

- AWS Organizations を使う tenant ([NFR-3](../requirements/problem-deploy.md) で「野良も許容」となっているため非必須) に対して、Org wide の `aws:PrincipalOrgID` condition で更に絞り込めるかは Phase 3 で検討

## 関連 invariant

- `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER` — tenant 単位 ExternalId + tenant scoped DDB query
- `INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER` — Worker の AssumeRole は infra (Worker Role) 層が注入、Lambda コードに ExternalId を hard-code しない
- CLAUDE.md `secrets-manager-forbidden` — SSM SecureString を使う
- `DynamoDbLowCapacity` Aspect — `CompetitorAccountsTable` も 1/1 PROVISIONED に強制

## 関連リソース

- Issue 459 — 本 ADR の前提となる設計判断ペーパー (現状調査含む)
- [`infrastructure/templates/competitor-bootstrap.yaml`](../../infrastructure/templates/competitor-bootstrap.yaml) — Phase 2.2 で説明文を改訂
- [`infrastructure/lib/problem-deploy/`](../../infrastructure/lib/problem-deploy/) — Worker Lambda の AssumeRole 経路、Phase 2.1 で書き換え
- [ADR-001](./adr-001-problem-deploy-crud.md) — Decision 6 で本 ADR をフォロー
