# Multi-cloud problem providers (Sakura / Azure / GCP)

> Japanese: [multi-cloud-providers.ja.md](./multi-cloud-providers.ja.md)

| Attribute | Value |
|---|---|
| Audience | Operator (Tenant Admin) enabling a non-AWS problem for one or more teams |
| When to use | Once per team that will run a Sakura / Azure / GCP problem, before you deploy that problem |
| Estimated time | 20 minutes per team per provider (most of it is the one-time cloud-side trust bootstrap) |
| Output | The team's per-provider credential is registered, the problem's `runtime` resolves to a live adapter, and a non-AWS deploy reaches `ready` and tears down cleanly |

TenkaCloud's control plane always runs on AWS. Individual **problems** can target another cloud by declaring a `runtime` other than `aws/cloudformation`. The deploy worker resolves a `ProblemRuntimeAdapter` for that provider, exchanges a short-lived credential, and drives the provider's native deploy API. This runbook is the operator path from "a team exists" to "a non-AWS problem deploys for that team."

The design decisions behind each provider live in the ADRs — read them once for context:

| Provider / engine | Adapter | Credential model | ADR |
|---|---|---|---|
| `sakura/apprun` | Sakura AppRun | Stored API key (access token + secret) in SSM SecureString | [ADR-026](../architecture/adr-026-sakura-cloud-problem-provider.html) |
| `azure/bicep` | Azure Deployment Stacks | Stored app-registration client secret in SSM SecureString → `client_credentials` ARM token | [ADR-027](../architecture/adr-027-azure-gcp-federated-providers.html) / [ADR-032](../architecture/adr-032-cross-cloud-federation-subject-token.html) |
| `gcp/infra-manager` | GCP Infrastructure Manager | **Keyless** Workload Identity Federation: signed `sts:GetCallerIdentity` → GCP STS → service-account impersonation | [ADR-027](../architecture/adr-027-azure-gcp-federated-providers.html) / [ADR-032](../architecture/adr-032-cross-cloud-federation-subject-token.html) |

## Step 1: cloud-side trust bootstrap (one-time, in the team's cloud account)

This is the one piece that lives outside TenkaCloud — it is set up in the **team's own** Sakura / Azure / GCP account. Do it once per team. Apply least privilege: each credential should only be able to deploy and delete the problem's resources.

### Sakura

- [ ] In the team's Sakura account, issue an **API key** (access token + access token secret) scoped to AppRun.
- [ ] Note the two values. They are long-lived, so plan a rotation cadence (see [Rotation and revocation](#rotation-and-revocation)).

### Azure

- [ ] Create a **per-team app registration** in the team's Entra ID directory and generate a **client secret**.
- [ ] Grant that service principal a minimal role (e.g. a custom role with only the resource actions the problem template touches) on the **target subscription / resource group** — not Owner.
- [ ] Record: `azureTenantId` (directory GUID), `clientId`, `clientSecret`, `subscriptionId`, `resourceGroup`, and optional `location`.

> Azure has no AWS-native federation path (Entra federated credentials accept only an OIDC issuer). ADR-032 deliberately defers the platform-as-OIDC-issuer subsystem; v1 uses a stored client secret, so treat it with the same care as the Sakura key.

### GCP (keyless)

- [ ] Create a **Workload Identity Pool** and an **AWS provider** in the team's GCP project that trusts the platform's AWS deploy-worker identity.
- [ ] Create (or pick) a **service account** with a minimal role on the target project, and grant the WIF principal `roles/iam.serviceAccountTokenCreator` on it (impersonation binding).
- [ ] Record: `wifAudience` (e.g. `//iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/tenkacloud/providers/aws`), `serviceAccountEmail`, `projectId`, and `location`.

> GCP is the only keyless provider: no secret is ever stored. The deploy worker signs a `GetCallerIdentity` request, exchanges it at GCP STS, and impersonates the service account for a 1-hour token.

## Step 2: register the per-team credential

Registration is done from the **Application Admin console → Competitor Accounts → "Team cloud credentials"** panel. The panel `PUT`s the credential to `admin/team-cloud-credentials/:provider/:teamSlug`; the backend validates the provider-specific shape and writes it to an SSM SecureString. The secret is write-only — the status check returns a boolean, never the secret.

| Provider | Credential JSON to paste | SSM SecureString path |
|---|---|---|
| `sakura` | `{ "accessToken": "...", "accessTokenSecret": "..." }` | `/<env>/tenants/<tenantId>/teams/<teamSlug>/sakura-api-key` |
| `azure` | `{ "azureTenantId": "...", "clientId": "...", "clientSecret": "...", "subscriptionId": "...", "resourceGroup": "...", "location": "japaneast" }` | `/<env>/tenants/<tenantId>/teams/<teamSlug>/azure-credential` |
| `gcp` | `{ "wifAudience": "...", "serviceAccountEmail": "...", "projectId": "...", "location": "asia-northeast1" }` | `/<env>/tenants/<tenantId>/teams/<teamSlug>/gcp-credential` |

- [ ] Select the provider, enter the team slug (`^[a-z0-9-]+$`), paste the JSON, and click **Register**.
- [ ] Click **Status** — it should report registered.
- [ ] `<env>` is the deploy environment (`development` / `staging` / `production`). The deploy worker's IAM already grants `ssm:GetParameter` + `kms:Decrypt` scoped to these paths (`deploy-api-lambda.ts`), so no IAM change is needed per team.

## Step 3: declare the problem runtime

The problem's `metadata.json` declares the target with a `runtime` block; without it, a problem is treated as legacy `aws/cloudformation`.

```jsonc
{ "runtime": { "provider": "gcp", "engine": "infra-manager", "entry": "main.tf" } }
```

- [ ] `provider` / `engine` must be one of the three rows in the table above.
- [ ] `make validate-problems` checks the runtime block against `problems/SCHEMA.json`.
- [ ] If the provider's credential is **not** registered for the team, `selectAdapter` raises `RuntimeNotSupportedError` (reserved) **before any cloud mutation** — a loud failure, never a silent fallback to AWS.

## Step 4: deploy, reconcile, and tear down

The flow is identical to an AWS problem — the adapter abstraction hides the provider:

1. **Deploy** — the operator deploys the problem for the team. The deploy worker builds the adapter dependencies (`buildAdapterDependencies`), exchanges the credential, and calls `adapter.deploy`. Status starts at `deploying`.
2. **Reconcile** — the generic-scoring tick calls `adapter.getStatus` / `adapter.collectOutputs` (the runtime-status reconciler), advancing the deployment row to `ready` and persisting the endpoint outputs the participant portal shows.
3. **Tear down** — teardown calls `adapter.destroy`; status moves through `destroying` to `destroyed`. Follow the normal [teardown runbook](./teardown.md) for the event as a whole.

## Per-provider verification checklist

Run this once you have a real account for a provider. It is the acceptance evidence for the multi-cloud tracker ([#1408](https://github.com/susumutomita/TenkaCloud/issues/1408)) and the per-provider issues (Sakura #1412 / Azure #1410 / GCP #1411 / federation onboarding #1413). The mechanism and its unit + contract tests already ship; this checklist is the live confirmation.

- [ ] Trust bootstrap done in the team's cloud account (Step 1), least privilege applied.
- [ ] Credential registered and **Status** reports registered (Step 2).
- [ ] A problem declaring that `runtime` passes `make validate-problems`.
- [ ] Deploy reaches `ready`; the portal shows the endpoint output.
- [ ] An unregistered team fails loud with `RuntimeNotSupportedError`, with no resource created.
- [ ] Teardown reaches `destroyed`; no orphan resource remains in the team's cloud account (cross-check the provider console).
- [ ] (GCP) Confirm no secret was ever written to SSM — only the non-secret WIF config.

## Rotation and revocation

- **Rotate** — re-register through the same panel (`PUT` overwrites the SSM SecureString in place). Sakura keys and Azure client secrets are long-lived; rotate on the team's normal cadence and after any suspected exposure.
- **Revoke** — use the panel's **Revoke** (`DELETE`). The next deploy for that team then fails loud (`no <provider> credential registered ...`) until re-registered. Also revoke the underlying secret in the provider's console.
- GCP has no stored secret to rotate; revoke by removing the impersonation binding or disabling the WIF provider in the team's GCP project.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Deploy rejected with `RuntimeNotSupportedError` (reserved) | Credential not registered for the team | Register it (Step 2), then redeploy |
| `no <provider> credential registered for tenant ... team ...` | SecureString missing or wrong team slug | Re-check the slug and re-register |
| Azure token error on deploy | App-registration secret expired, or the role is too narrow | Rotate the secret / widen the role to the template's actions |
| GCP STS exchange fails | WIF provider does not trust the worker identity, or impersonation binding missing | Re-check the pool's AWS provider condition and the `serviceAccountTokenCreator` binding |
| Sakura 401 | API key revoked or wrong scope | Re-issue the AppRun-scoped key and re-register |

## Related

- [Teardown](./teardown.md) — the event-level teardown that the per-provider `destroy` rolls up into.
- [Incident response](./incident-response.md) — if a non-AWS deploy stalls during the event.
- [ADR-026](../architecture/adr-026-sakura-cloud-problem-provider.html) / [ADR-027](../architecture/adr-027-azure-gcp-federated-providers.html) / [ADR-032](../architecture/adr-032-cross-cloud-federation-subject-token.html) — the provider and federation design.
