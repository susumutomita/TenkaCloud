# Risk-to-Quest Mapping

This reference defines how App-to-Quest turns a normalized source application profile into a bounded set of defensive QuestCandidates.

It is an authoring specification for `.claude/skills/create-problem`. It is not a vulnerability scanner, does not run active probes, and does not publish problem catalog files. The output remains draft material until a human author selects exactly one candidate and reviews the generated problem.

## Inputs

Read the normalized profile from:

```text
.claude/drafts/app-to-quest/<app-slug>/01-source-app-profile.json
```

Validate it against [`source-app-profile.schema.json`](./source-app-profile.schema.json) before applying this mapping.

The mapping primarily uses:

| Source profile field | Use |
| --- | --- |
| `actors` | Identify anonymous, authenticated, admin, operator, service, and external actors. |
| `dataInventory` | Find personal, sensitive, secret, operational, and public data handled by the app. |
| `entrypoints` | Identify public routes, authenticated APIs, admin APIs, webhooks, jobs, and dynamic resource paths. |
| `authorizationBoundaries` | Decide whether ownership, role, tenant, or admin boundaries have evidence. |
| `aiDataFlows` | Identify data sent to AI providers, consent assumptions, and retention assumptions. |
| `secretHandling` | Identify environment variables, client-exposed names, README examples, and storage evidence. |
| `loggingAndAuditability` | Decide whether raw personal data, secrets, prompts, or request bodies may enter logs. |
| `deploymentModel` | Identify hosting, IaC, regions, and single-environment assumptions. |
| `backupDeletionRetention` | Identify backup, restore, deletion, and retention evidence. |
| `costSensitivePaths` | Identify paid API, quota, and rate-limit sensitive operations. |
| `operationalSignals` | Identify health checks, metrics, alerts, and audit trails. |
| `unknowns` | Preserve review questions instead of filling gaps with guesses. |

## Outputs

Write the intermediate risk inventory and the candidate list:

```text
.claude/drafts/app-to-quest/<app-slug>/02-risk-inventory.md
.claude/drafts/app-to-quest/<app-slug>/03-quest-candidates.json
```

Validate `03-quest-candidates.json` against [`quest-candidate.schema.json`](./quest-candidate.schema.json).

`02-risk-inventory.md` is a human review artifact. Use this structure:

```markdown
# Risk Inventory: <app-slug>

## Source Profile

- Profile: 01-source-app-profile.json
- Overall confidence: <high|medium|low|unknown>

## Ranked Risks

| Rank | Rule | Category | Severity | Evidence | Unknowns |
| --- | --- | --- | --- | --- | --- |
| 1 | idor-owner-check | security/privacy | high | `app/api/orders/[id]/route.ts` | Owner check evidence is missing. |

## Rejected Or Deferred Ideas

- <idea> - <reason>

## Safety Notes

- No production probes were requested.
- No secret values were copied.
```

## Candidate Output Contract

`03-quest-candidates.json` is an object with a bounded candidate list:

```json
{
  "$schema": "./quest-candidate.schema.json",
  "appSlug": "sample-vibe-app",
  "sourceProfile": "01-source-app-profile.json",
  "riskInventory": "02-risk-inventory.md",
  "humanReviewRequired": true,
  "candidates": [
    {
      "id": "orders-owner-check",
      "title": "Prevent URL changes from exposing another user's data",
      "category": "privacy",
      "severity": "high",
      "sourceEvidence": ["app/api/orders/[id]/route.ts"],
      "riskStatement": "Orders appear user-owned, but owner-boundary evidence is missing for the dynamic route.",
      "businessImpact": "Order history and addresses could be exposed, creating support, legal, and trust impact.",
      "whatHappensIfIgnored": "A user may access another user's order data by changing the URL identifier.",
      "learnerExperience": "The learner adds a server-side owner check and verifies allowed and denied fixture requests.",
      "mission": "Require a matching owner before returning an order.",
      "successCriteria": [
        "Own order returns success",
        "Another user's order returns 403 or 404"
      ],
      "scoringSignals": ["allowed-own-order", "denied-other-order"],
      "safeSimulationPlan": "Use two synthetic users in a local fixture and do not call production URLs.",
      "remediationHints": ["Check the authenticated user id against the order owner id"],
      "suggestedProblemType": "challenge",
      "suggestedScoringKind": "flag",
      "confidence": "medium"
    }
  ]
}
```

Each candidate must include:

```ts
type QuestCandidate = {
  id: string;
  title: string;
  category: "security" | "privacy" | "reliability" | "operations" | "cost" | "ai-safety";
  severity: "critical" | "high" | "medium" | "low";
  sourceEvidence: string[];
  riskStatement: string;
  businessImpact: string;
  whatHappensIfIgnored: string;
  learnerExperience: string;
  mission: string;
  successCriteria: string[];
  scoringSignals: string[];
  safeSimulationPlan: string;
  remediationHints: string[];
  suggestedProblemType: "assessment" | "challenge" | "battle" | "workshop";
  suggestedScoringKind: "flag" | "multi-flag" | "uptime-flat" | "uptime-multi" | "phased-polling" | "attack-detection" | "manual-review";
  confidence: "high" | "medium" | "low";
};
```

`manual-review` is allowed only for draft candidates. A formal TenkaCloud problem must be converted to an existing supported scoring kind before it enters `problems/`.

## Mapping Process

1. Validate `01-source-app-profile.json`.
2. Derive reusable signals from the profile.
3. Apply the eight mapping rules below.
4. Drop candidates without concrete `sourceEvidence`.
5. Deduplicate candidates that would teach the same learner action against the same surface.
6. Rank the remaining candidates with the priority policy below.
7. Keep at most 10 candidates.
8. Write `02-risk-inventory.md` and `03-quest-candidates.json`.

Do not turn an unknown into a fact. When a rule fires mainly because evidence is absent, use `confidence: "low"` and make the missing evidence visible in `riskStatement`, `safeSimulationPlan`, or the risk inventory.

## Derived Signals

| Signal | Derivation |
| --- | --- |
| `hasUserOwnedData` | `dataInventory[]` includes `personal`, `sensitive`, or domain objects with fields such as `userId`, `ownerId`, `accountId`, `customerId`, `teamId`, `tenantId`, `email`, `address`, `profile`, or `order`. |
| `hasSecretData` | `dataInventory[]` includes `secret`, or `secretHandling` references secret-like variable names. |
| `hasDynamicResourceRoute` | `entrypoints[].path` contains `:id`, `[id]`, `{id}`, `<id>`, `/{resourceId}`, or similar dynamic resource markers. |
| `hasPublicEntrypoint` | Any entrypoint has `authRequired` of `no`, `partial`, or `unknown`. |
| `hasAdminSurface` | Any actor has `trustLevel: "admin"`, entrypoint type is `admin`, entrypoint path contains `admin`, or authorization boundary names an admin-only resource. |
| `hasWeakBoundaryEvidence` | Authorization confidence is `low` or `unknown`, implementation evidence is empty, or the expected boundary is `unknown`. |
| `hasPaidExternalPath` | `costSensitivePaths[]` is non-empty, or `techStack.externalServices[]` names AI, email, image generation, payment, storage, SMS, search, or analytics providers. |
| `hasPersistentStore` | `techStack.datastores[]` or `storageLocations[]` includes a database, bucket, queue, file store, cache, or hosted persistence service. |
| `hasDeletionGap` | Personal or sensitive data exists and `backupDeletionRetention.deletion` is `unknown`, empty, or absent. |
| `hasRecoveryGap` | Persistent storage exists and backup or restore evidence is absent, `unknown`, or low confidence. |

## Rules

### Rule 1: IDOR or Missing Owner Check

Detection signals:

- `hasUserOwnedData`
- `hasDynamicResourceRoute`
- authorization boundary for the resource is `unknown`, low confidence, or lacks implementation evidence
- the entrypoint may be authenticated, but there is no evidence of a resource owner check

Generate a candidate:

| Field | Value |
| --- | --- |
| `id` | `idor-owner-check` or `<resource>-owner-check` |
| `category` | `security` when the main lesson is authorization, `privacy` when personal data exposure is central |
| `severity` | `critical` for sensitive or secret data, otherwise `high` |
| `title` | `Prevent URL changes from exposing another user's data` |
| `riskStatement` | Explain which resource appears user-owned and which route lacks owner-boundary evidence. |
| `businessImpact` | Personal data exposure, support burden, loss of trust, legal review, or account abuse. |
| `whatHappensIfIgnored` | Another user's orders, address, tickets, profile, or workspace data may be accessed by changing a resource identifier. |
| `mission` | Add a server-side resource owner check and keep admin override explicit. |
| `successCriteria` | Own resource returns success; another user's resource returns `403` or `404`; admin access uses explicit role check and audit evidence. |
| `suggestedScoringKind` | `flag` when a synthetic fixture can prove allowed versus denied access, otherwise `manual-review`. |

Safe simulation plan:

- Use local fixtures or a generated template with two synthetic users.
- Do not call a production URL.
- Do not include real identifiers, tokens, or request captures.

### Rule 2: Admin API Protected Only by Frontend Display Logic

Detection signals:

- `hasAdminSurface`
- frontend route or conditional render evidence exists
- backend authorization evidence is absent, low confidence, or only names UI code

Generate a candidate:

| Field | Value |
| --- | --- |
| `id` | `server-side-admin-authorization` |
| `category` | `security` |
| `severity` | `high`, or `critical` if the admin action can delete users, change tenant settings, or expose sensitive data |
| `title` | `Protect admin APIs with server-side authorization` |
| `riskStatement` | The admin action appears hidden in UI but lacks backend role enforcement evidence. |
| `businessImpact` | Unauthorized users may delete data, change settings, or read administrative records. |
| `whatHappensIfIgnored` | A user can bypass hidden buttons by calling the API directly if the server trusts only frontend display logic. |
| `mission` | Add backend role checks to every admin action. |
| `successCriteria` | Non-admin request returns `403`; admin request succeeds; role checks execute server-side; audit evidence records admin action attempts. |
| `suggestedScoringKind` | `flag` or `manual-review` |

### Rule 3: Secret or API Key Handling Gap

Detection signals:

- `hasSecretData`
- secret-like names appear under `NEXT_PUBLIC_*` or other client-exposed prefixes
- `.env.example`, README, code, or logs contain realistic secret-shaped examples
- paid or external services exist and `secretHandling` is absent, `unknown`, or low confidence

Generate a candidate:

| Field | Value |
| --- | --- |
| `id` | `secret-handling` or `<provider>-secret-handling` |
| `category` | `security` |
| `severity` | `critical` when real-looking secret material is evidenced, otherwise `high` or `medium` |
| `title` | `Move API keys out of public and committed locations` |
| `riskStatement` | Secret metadata suggests a key may be committed, exposed to a client bundle, logged, or unmanaged. |
| `businessImpact` | Third parties may spend provider quota, access data, or interrupt service availability. |
| `whatHappensIfIgnored` | Exposed API keys can be reused by outsiders, causing billing spikes, unauthorized access, or provider suspension. |
| `mission` | Keep secrets server-side and reference them through environment variables or a secret manager. |
| `successCriteria` | No secret values in Git; no secret in client bundle; server-side configuration or secret manager is used; examples use placeholder values. |
| `suggestedScoringKind` | `flag` for fixture-based detection, otherwise `manual-review` |

Do not copy secret values into the candidate. Use variable names and file paths only.

### Rule 4: Personal Data Logging

Detection signals:

- `dataInventory[]` includes `personal` or `sensitive`
- `loggingAndAuditability.evidence[]` exists
- evidence indicates raw request bodies, user objects, prompts, tokens, email, address, or profile data may be logged

Generate a candidate:

| Field | Value |
| --- | --- |
| `id` | `personal-data-logging` |
| `category` | `privacy` |
| `severity` | `high` for personal or sensitive data, `critical` if secret data may be logged |
| `title` | `Keep personal data out of application logs` |
| `riskStatement` | Logging evidence includes or may include raw personal data. |
| `businessImpact` | Logs can spread regulated or sensitive data into observability systems, developer machines, and long-lived backups. |
| `whatHappensIfIgnored` | Personal data may remain in logs after deletion requests, making incident review and privacy response harder. |
| `mission` | Replace raw data logging with minimal identifiers and structured context. |
| `successCriteria` | Email, address, token, prompt, and raw request body are not logged; `userId` or `requestId` is used instead; error logs redact secrets and personal data. |
| `suggestedScoringKind` | `flag`, `attack-detection`, or `manual-review` |

### Rule 5: Personal Data Sent to AI API

Detection signals:

- `aiDataFlows[]` is non-empty
- `aiDataFlows[].dataSent` overlaps personal or sensitive data inventory
- `userConsent` or `retentionAssumption` is `unknown`, `no`, absent, or low confidence

Generate a candidate:

| Field | Value |
| --- | --- |
| `id` | `ai-data-minimization` |
| `category` | `ai-safety` when the core behavior is AI processing, `privacy` when the core harm is data exposure |
| `severity` | `high` for sensitive data, otherwise `medium` |
| `title` | `Minimize personal data sent to AI APIs` |
| `riskStatement` | The app appears to send user data to an AI provider without clear minimization, notice, consent, or retention evidence. |
| `businessImpact` | Enterprise adoption, privacy policy alignment, audit readiness, and user trust can be harmed. |
| `whatHappensIfIgnored` | Users may send personal data to external AI processing that they did not understand or approve. |
| `mission` | Reduce prompt data to the minimum needed and document provider use. |
| `successCriteria` | Unnecessary personal fields are removed from prompts; external AI use is disclosed; consent, privacy notice, or retention policy is recorded. |
| `suggestedScoringKind` | `manual-review`, or `flag` only when a safe local fixture can inspect prompt construction without calling a real AI API |

### Rule 6: Missing Rate Limit or Cost Guard

Detection signals:

- `hasPublicEntrypoint`
- `hasPaidExternalPath`
- no rate-limit, quota, budget guard, or throttling evidence

Generate a candidate:

| Field | Value |
| --- | --- |
| `id` | `rate-limit-cost-guard` |
| `category` | `cost` when spend is primary, `operations` when quota exhaustion or reliability is primary |
| `severity` | `high` for paid AI, email, SMS, storage, or image generation calls; otherwise `medium` |
| `title` | `Add rate limits to metered API paths` |
| `riskStatement` | Public or weakly authenticated routes can trigger paid or quota-limited external services without guard evidence. |
| `businessImpact` | Unexpected traffic, bots, or implementation bugs can create billing spikes and service degradation. |
| `whatHappensIfIgnored` | A few hours of automated traffic can exhaust quota or create a bill before operators notice. |
| `mission` | Add user or IP scoped rate limits and budget or quota guards. |
| `successCriteria` | Rate limit exists per IP or user; budget or quota guard exists; error response is clear; monitoring logs limit events. |
| `suggestedScoringKind` | `uptime-flat`, `uptime-multi`, `phased-polling`, or `manual-review` |

Safe simulation plan:

- Use bounded local load or synthetic scoring calls.
- Never instruct the learner to flood a real service.

### Rule 7: Backup or Restore Gap

Detection signals:

- `hasPersistentStore`
- backup, restore, migration rollback, or seed evidence is absent, `unknown`, or low confidence
- deployment appears single environment or single region

Generate a candidate:

| Field | Value |
| --- | --- |
| `id` | `backup-restore-readiness` |
| `category` | `reliability` or `operations` |
| `severity` | `high` when user or business data is persistent, otherwise `medium` |
| `title` | `Make data recoverable after deletion or migration failure` |
| `riskStatement` | Persistent data exists, but backup and restore evidence is missing or weak. |
| `businessImpact` | Migration mistakes, database deletion, region issues, or operator mistakes can become unrecoverable outages. |
| `whatHappensIfIgnored` | A database or bucket loss can permanently remove user data and block service recovery. |
| `mission` | Define backup cadence, restore procedure, and rollback plan. |
| `successCriteria` | Backup policy exists; restore steps are documented or automated; rollback is defined for migrations; a non-production restore drill is possible. |
| `suggestedScoringKind` | `phased-polling`, `uptime-multi`, or `manual-review` |

### Rule 8: Deletion or Retention Gap

Detection signals:

- personal or sensitive data exists
- account deletion or data deletion flow is absent, `unknown`, or low confidence
- data is also sent to external services, logs, files, or backups

Generate a candidate:

| Field | Value |
| --- | --- |
| `id` | `data-deletion-retention` |
| `category` | `privacy` or `operations` |
| `severity` | `high` for sensitive or regulated data, otherwise `medium` |
| `title` | `Delete or anonymize related data when users leave` |
| `riskStatement` | Personal data exists, but deletion and retention behavior is not evidenced. |
| `businessImpact` | Support, compliance, and privacy response processes become manual and error-prone. |
| `whatHappensIfIgnored` | User data may remain in databases, files, logs, or external services after a deletion request. |
| `mission` | Implement deletion, anonymization, or documented retention for related data. |
| `successCriteria` | User deletion flow exists; related rows and files are deleted or anonymized; retained data has a documented reason and retention period. |
| `suggestedScoringKind` | `manual-review` or `flag` when a synthetic fixture can verify deletion outcomes |

## Ranking and Limits

Initial output is capped at 10 candidates. Rank in this order:

1. Risks involving personal, sensitive, or secret data.
2. Risks involving authorization boundaries or admin control.
3. Risks involving paid external APIs, quota exhaustion, or cost exposure.
4. Risks involving recovery, auditability, deletion, or retention.
5. Low-confidence risks with many unknowns that need review before launch.

Tie breakers:

- Prefer candidates with stronger source evidence.
- Prefer candidates that can become a safe TenkaCloud scoring kind without real external calls.
- Prefer one representative candidate per route, datastore, or external provider.
- Prefer learner missions that can be finished in 30 to 90 minutes.

## Scoring Kind Guidance

| Suggested scoring kind | Use when |
| --- | --- |
| `flag` | A fixture can prove the learner changed behavior, such as own resource allowed and other resource denied. |
| `multi-flag` | The same quest has several independent proof points that should earn partial credit, such as allowed access, denied access, and missing-resource behavior. |
| `uptime-flat` | The mission is a single health or availability invariant. |
| `uptime-multi` | The mission has several independent endpoints or service levels. |
| `phased-polling` | The mission has ordered stages, such as backup policy, restore drill, and recovery verification. |
| `attack-detection` | The learning goal is detection, alerting, or safe audit evidence against synthetic events. |
| `manual-review` | Evidence is important but cannot be safely or reliably scored yet. Convert before catalog publication. |

## Required Safety Boundaries

Do not output:

- real-service attack steps
- token abuse steps
- WAF bypass or detection bypass instructions
- production URL probing instructions
- secret values
- API response bodies or database rows
- commands that create unbounded load
- confident claims based only on absence of evidence

Use defensive language. A QuestCandidate should explain the risk, the consequence, and the safe remediation mission. It should not teach exploitation against a real app.

## Unknowns and Confidence

Use `confidence: "high"` only when multiple evidence points support the candidate and the mission is clear.

Use `confidence: "medium"` when the risk is plausible and supported by at least one concrete evidence path.

Use `confidence: "low"` when the candidate is driven mainly by missing evidence or unclear source profile fields. Low-confidence candidates are allowed, but they must:

- state the missing evidence in `riskStatement` or `safeSimulationPlan`
- avoid definitive exploitability claims
- remain below higher-confidence candidates with the same severity

Carry unresolved questions into `02-risk-inventory.md`. Do not silently discard unknowns just because the first candidate list is capped at 10.

## App-to-Quest Mode Integration

The future `app-to-quest` mode should read this file after producing `01-source-app-profile.json` and before prompting the author to select a draft. The mode should show the risk inventory and candidate list to the author. After the author selects exactly one candidate, continue with [`candidate-to-draft.md`](./candidate-to-draft.md) and stop for human review before writing catalog files.
