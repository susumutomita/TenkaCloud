# マルチクラウド問題プロバイダ (Sakura / Azure / GCP)

> English: [multi-cloud-providers.md](./multi-cloud-providers.md)

| 項目 | 内容 |
|---|---|
| 対象者 | 非 AWS 問題をチームに対して有効化するオペレータ (Tenant Admin) |
| 使うタイミング | Sakura / Azure / GCP 問題を動かすチームごとに 1 回、その問題を deploy する前 |
| 所要時間 | チーム × プロバイダごとに 20 分 (大半は一度きりのクラウド側 trust bootstrap) |
| 成果物 | チームの provider 別認証情報が登録され、問題の `runtime` が live な adapter に解決し、非 AWS deploy が `ready` に到達してきれいに撤去できる |

TenkaCloud の control plane は常に AWS 上で動く。個々の **問題** は `aws/cloudformation` 以外の `runtime` を宣言することで別クラウドを対象にできる。deploy worker はその provider 用の `ProblemRuntimeAdapter` を解決し、短命の認証情報を交換して、provider ネイティブの deploy API を駆動する。この runbook は「チームが存在する」状態から「そのチームに非 AWS 問題を deploy できる」状態までのオペレータ手順を示す。

各 provider の設計判断は ADR にある。背景は一度目を通しておくとよい。

| Provider / engine | Adapter | 認証モデル | ADR |
|---|---|---|---|
| `sakura/apprun` | Sakura AppRun | API キー (access token + secret) を SSM SecureString に保管 | [ADR-026](../architecture/adr-026-sakura-cloud-problem-provider.html) |
| `azure/bicep` | Azure Deployment Stacks | app registration の client secret を SSM SecureString に保管 → `client_credentials` で ARM token | [ADR-027](../architecture/adr-027-azure-gcp-federated-providers.html) / [ADR-032](../architecture/adr-032-cross-cloud-federation-subject-token.html) |
| `gcp/infra-manager` | GCP Infrastructure Manager | **鍵レス** Workload Identity Federation: 署名済 `sts:GetCallerIdentity` → GCP STS → service account impersonation | [ADR-027](../architecture/adr-027-azure-gcp-federated-providers.html) / [ADR-032](../architecture/adr-032-cross-cloud-federation-subject-token.html) |

## Step 1: クラウド側 trust bootstrap (一度きり、チームのクラウドアカウント側)

ここだけが TenkaCloud の外にある作業で、**チーム自身の** Sakura / Azure / GCP アカウント側で設定する。チームごとに 1 回行う。最小権限を徹底し、各認証情報は問題のリソースを deploy / delete できるだけにする。

### Sakura

- [ ] チームの Sakura アカウントで、AppRun にスコープした **API キー** (access token + access token secret) を発行する。
- [ ] 2 つの値を控える。long-lived なので rotation の頻度を決めておく ([Rotation と revocation](#rotation-と-revocation) 参照)。

### Azure

- [ ] チームの Entra ID directory に **チーム専用の app registration** を作り、**client secret** を発行する。
- [ ] その service principal に、**対象 subscription / resource group** へ最小ロール (問題テンプレートが触る action だけのカスタムロール等) を付与する。Owner は付けない。
- [ ] 控える値: `azureTenantId` (directory GUID)、`clientId`、`clientSecret`、`subscriptionId`、`resourceGroup`、任意の `location`。

> Azure には AWS-native な federation 経路がない (Entra の federated credential は OIDC issuer しか受け付けない)。ADR-032 は platform-as-OIDC-issuer サブシステムを意図的に後回しにしており、v1 は stored client secret を使う。Sakura キーと同等に扱うこと。

### GCP (鍵レス)

- [ ] チームの GCP プロジェクトに **Workload Identity Pool** と、platform の AWS deploy-worker identity を信頼する **AWS provider** を作る。
- [ ] 対象プロジェクトへ最小ロールを持つ **service account** を用意し、WIF principal に `roles/iam.serviceAccountTokenCreator` を付与する (impersonation binding)。
- [ ] 控える値: `wifAudience` (例 `//iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/tenkacloud/providers/aws`)、`serviceAccountEmail`、`projectId`、`location`。

> GCP は唯一の鍵レス provider で、secret を一切保管しない。deploy worker は `GetCallerIdentity` リクエストに署名し、GCP STS で交換し、1 時間有効な token で service account を impersonate する。

## Step 2: チーム別の認証情報を登録する

登録は **Application Admin console → Competitor Accounts → "Team cloud credentials"** パネルから行う。パネルは認証情報を `admin/team-cloud-credentials/:provider/:teamSlug` に `PUT` し、backend が provider 別の形を検証して SSM SecureString に書く。secret は write-only で、status 確認は boolean だけを返し secret は返さない。

| Provider | 貼り付ける認証情報 JSON | SSM SecureString path |
|---|---|---|
| `sakura` | `{ "accessToken": "...", "accessTokenSecret": "..." }` | `/<env>/tenants/<tenantId>/teams/<teamSlug>/sakura-api-key` |
| `azure` | `{ "azureTenantId": "...", "clientId": "...", "clientSecret": "...", "subscriptionId": "...", "resourceGroup": "...", "location": "japaneast" }` | `/<env>/tenants/<tenantId>/teams/<teamSlug>/azure-credential` |
| `gcp` | `{ "wifAudience": "...", "serviceAccountEmail": "...", "projectId": "...", "location": "asia-northeast1" }` | `/<env>/tenants/<tenantId>/teams/<teamSlug>/gcp-credential` |

- [ ] provider を選び、team slug (`^[a-z0-9-]+$`) を入力し、JSON を貼り付けて **Register** を押す。
- [ ] **Status** を押すと registered と表示されるはず。
- [ ] `<env>` は deploy 環境 (`development` / `staging` / `production`)。deploy worker の IAM はこれらの path にスコープした `ssm:GetParameter` + `kms:Decrypt` を既に付与済 (`deploy-api-lambda.ts`) なので、チームごとの IAM 変更は不要。

## Step 3: 問題の runtime を宣言する

問題の `metadata.json` は `runtime` ブロックで対象を宣言する。無ければ legacy の `aws/cloudformation` として扱われる。

```jsonc
{ "runtime": { "provider": "gcp", "engine": "infra-manager", "entry": "main.tf" } }
```

- [ ] `provider` / `engine` は上表の 3 行のいずれか。
- [ ] `make validate-problems` が runtime ブロックを `problems/SCHEMA.json` に対して検証する。
- [ ] provider の認証情報がチームに登録されていない場合、`selectAdapter` は **クラウド変更の前に** `RuntimeNotSupportedError` (reserved) を投げる。AWS への暗黙フォールバックはせず loud に落ちる。

## Step 4: deploy・reconcile・撤去

流れは AWS 問題と同一で、adapter 抽象が provider 差を隠す。

1. **Deploy** — オペレータが問題をチームに deploy する。deploy worker は adapter 依存を組み (`buildAdapterDependencies`)、認証情報を交換し、`adapter.deploy` を呼ぶ。status は `deploying` から始まる。
2. **Reconcile** — generic-scoring の tick が `adapter.getStatus` / `adapter.collectOutputs` (runtime-status reconciler) を呼び、deployment 行を `ready` に進め、participant portal が見せる endpoint outputs を永続化する。
3. **撤去** — teardown は `adapter.destroy` を呼び、status は `destroying` を経て `destroyed` になる。イベント全体は通常の [teardown runbook](./teardown.md) に従う。

## Provider 別の検証チェックリスト

provider の実アカウントを入手したら一度実施する。これがマルチクラウド tracker ([#1408](https://github.com/susumutomita/TenkaCloud/issues/1408)) と provider 別 issue (Sakura #1412 / Azure #1410 / GCP #1411 / federation onboarding #1413) の受け入れ証跡になる。機構と unit + contract test は既に出荷済で、このチェックリストは live での確認にあたる。

- [ ] チームのクラウドアカウント側で trust bootstrap (Step 1) 済、最小権限を適用。
- [ ] 認証情報を登録し **Status** が registered (Step 2)。
- [ ] その `runtime` を宣言した問題が `make validate-problems` を通る。
- [ ] deploy が `ready` に到達し、portal に endpoint output が出る。
- [ ] 未登録チームは `RuntimeNotSupportedError` で loud に落ち、リソースは作られない。
- [ ] teardown が `destroyed` に到達し、チームのクラウドアカウントに orphan が残らない (provider console で突き合わせ)。
- [ ] (GCP) SSM に secret が一切書かれていないことを確認 (非秘密の WIF config のみ)。

## Rotation と revocation

- **Rotate** — 同じパネルから再登録する (`PUT` が SSM SecureString を上書きする)。Sakura キーと Azure client secret は long-lived なので、チームの通常頻度と漏洩疑いの後に rotate する。
- **Revoke** — パネルの **Revoke** (`DELETE`) を使う。以降そのチームの deploy は再登録まで loud に落ちる (`no <provider> credential registered ...`)。provider console 側の secret も失効させる。
- GCP は rotate すべき stored secret が無い。impersonation binding を外すか、チームの GCP プロジェクトで WIF provider を無効化して revoke する。

## トラブルシュート

| 症状 | 原因の可能性 | 対応 |
|---|---|---|
| deploy が `RuntimeNotSupportedError` (reserved) で拒否される | チームに認証情報が未登録 | 登録 (Step 2) してから再 deploy |
| `no <provider> credential registered for tenant ... team ...` | SecureString が無い、または team slug 誤り | slug を見直して再登録 |
| deploy 時に Azure token エラー | app registration の secret 失効、またはロールが狭すぎる | secret を rotate / ロールをテンプレートの action に合わせて広げる |
| GCP STS 交換が失敗 | WIF provider が worker identity を信頼していない、または impersonation binding が無い | pool の AWS provider 条件と `serviceAccountTokenCreator` binding を見直す |
| Sakura 401 | API キー失効または scope 誤り | AppRun スコープのキーを再発行して再登録 |

## 関連

- [Teardown](./teardown.md) — provider 別 `destroy` が集約されるイベントレベルの撤去。
- [Incident response](./incident-response.md) — イベント中に非 AWS deploy が停滞した場合。
- [ADR-026](../architecture/adr-026-sakura-cloud-problem-provider.html) / [ADR-027](../architecture/adr-027-azure-gcp-federated-providers.html) / [ADR-032](../architecture/adr-032-cross-cloud-federation-subject-token.html) — provider と federation の設計。
