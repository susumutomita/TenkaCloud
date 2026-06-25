# Codewiki App-to-Quest Adapter

This reference defines how TenkaCloud App-to-Quest consumes codewiki's structured export:

```text
.codewiki/app-to-quest/analysis.json
```

This is a reference specification for the problem authoring skill. It is not runtime platform code, does not add a TenkaCloud API, and does not perform repository analysis. Codewiki owns repository investigation; TenkaCloud owns normalization into a source app profile and later quest generation.

## Responsibility Boundary

| System | Responsibility |
| --- | --- |
| codewiki | Read the target repository, inspect README/package/routes/data/auth/env/IaC/Git history, produce evidence-backed `analysis.json`, preserve unknowns, and avoid storing secret values. |
| TenkaCloud App-to-Quest | Validate `analysis.json`, normalize it into `source-app-profile.json`, prepare risk inventory inputs, generate quest candidates, and eventually scaffold one reviewed problem draft. |

## Inputs

The adapter reads:

```text
.codewiki/app-to-quest/analysis.json
```

Optional neighboring files can improve human review but are not required for normalization:

```text
.codewiki/app-to-quest/source-summary.md
.codewiki/app-to-quest/evidence-map.json
.codewiki/app-to-quest/unknowns.md
.codewiki/app-to-quest/security-relevant-files.md
```

Validate `analysis.json` against [`codewiki-analysis.schema.json`](./codewiki-analysis.schema.json) before mapping.

## Outputs

The adapter writes draft artifacts under:

```text
.claude/drafts/app-to-quest/<app-slug>/
├── 00-source-summary.md
├── 01-source-app-profile.json
└── unknowns.md
```

`01-source-app-profile.json` must conform to [`source-app-profile.schema.json`](./source-app-profile.schema.json).

## Mapping

### Repository and Summary

| codewiki `analysis.json` | source app profile | Notes |
| --- | --- | --- |
| `repo.name` | `appSlug` candidate | Normalize to kebab-case. If unavailable, derive from `repo.root`; if still unknown, stop and ask the author. |
| `summary` | `summary` | Preserve codewiki wording unless it contains unsupported claims. |
| `techStack.languages` | `techStack.languages` | Use an empty array only when codewiki proves absence; otherwise add an unknown. |
| `techStack.frameworks` | `techStack.frameworks` | Preserve framework names and variants. |
| `techStack.datastores` | `techStack.datastores` | Include relational, document, cache, queue, and hosted data services. |
| `techStack.infrastructure` | `techStack.infrastructure` | CDK, Terraform, SST, Serverless, Vercel, Docker, and similar deployment descriptors. |
| `techStack.externalServices` | `techStack.externalServices` | Include AI, payment, email, auth, analytics, and storage providers. |
| `techStack.packageManagers` | `techStack.packageManagers` | Optional but useful for fixture reproduction. |

### Entrypoints

| codewiki `analysis.json` | source app profile | Notes |
| --- | --- | --- |
| `entrypoints[].path` | `entrypoints[].path` | Keep route syntax as codewiki reported it. |
| `entrypoints[].type` | `entrypoints[].type` | Map `cli` to `job` unless the future profile schema gains a dedicated `cli` value. Unknown values become `unknown`. |
| `entrypoints[].method` | `entrypoints[].method` | Normalize to uppercase HTTP methods or `unknown`. |
| `entrypoints[].authRequired` | `entrypoints[].authRequired` | Preserve `yes`, `no`, or `unknown`. |
| `entrypoints[].evidence` | `entrypoints[].evidence` | Evidence is mandatory; if missing, add an unknown and set low confidence. |

### Data Model

| codewiki `analysis.json` | source app profile | Notes |
| --- | --- | --- |
| `dataModel[].name` | `dataInventory[].name` | Preserve domain terms. |
| `dataModel[].fields` | `dataInventory[].fields` | Keep field names, not values. |
| `dataModel[].evidence` | `dataInventory[].evidence` | Preserve file paths or code quotes. |
| derived | `dataInventory[].classification` | Use the classification rules below. |
| derived | `dataInventory[].location` | Prefer datastore/table/file evidence; otherwise use `unknown`. |

Classification rules:

| Signal | Classification |
| --- | --- |
| `password`, `token`, `secret`, `apiKey`, `privateKey`, `credential` | `secret` |
| `payment`, `card`, `bank`, `health`, `ssn`, `tax` | `sensitive` |
| `email`, `phone`, `address`, `name`, `userId`, `customerId`, `ip` | `personal` |
| explicitly public content | `public` |
| operational metrics, traces, or logs without direct personal data | `operational` |
| insufficient evidence | `unknown` |

Do not store values from `.env`, fixture secrets, credentials, API responses, or database rows. Store variable names, field names, usage, and evidence only.

### Authentication and Authorization

| codewiki `analysis.json` | source app profile | Notes |
| --- | --- | --- |
| `authnAuthz.authentication.provider` | `authentication.provider` | Use `unknown` if codewiki cannot identify it. |
| `authnAuthz.authentication.evidence` | `authentication.evidence` | Preserve evidence. |
| `authnAuthz.authorizationPatterns[].resource` | `authorizationBoundaries[].resource` | Preserve resource names. |
| `authnAuthz.authorizationPatterns[].boundary` | `authorizationBoundaries[].expectedBoundary` | Treat `unknown` as an explicit unknown, not a guess. |
| `authnAuthz.authorizationPatterns[].evidence` | `authorizationBoundaries[].implementationEvidence` | Preserve codewiki evidence. |
| `authnAuthz.authorizationPatterns[].confidence` | `authorizationBoundaries[].confidence` | Preserve confidence. |

### AI Data Flows

| codewiki `analysis.json` | source app profile | Notes |
| --- | --- | --- |
| `aiDataFlows[].provider` | `aiDataFlows[].provider` | Preserve provider or `unknown`. |
| `aiDataFlows[].dataSent` | `aiDataFlows[].dataSent` | Store data classes or field names only. |
| `aiDataFlows[].userConsent` | `aiDataFlows[].userConsent` | Preserve `yes`, `no`, or `unknown`. |
| `aiDataFlows[].evidence` | `aiDataFlows[].evidence` | Preserve evidence. |

### Secrets and Configuration

| codewiki `analysis.json` | source app profile | Notes |
| --- | --- | --- |
| `secretsAndConfig[].name` | `secretHandling.evidence[]` | Include variable name and file path evidence only. |
| `secretsAndConfig[].usage` | `secretHandling.summary` | Summarize usage without secret values. |
| `secretsAndConfig[].source` | `secretHandling.evidence[]` | Preserve `env`, `file`, `secret-manager`, or `unknown`. |
| `secretsAndConfig[].evidence` | `secretHandling.evidence[]` | Preserve evidence. |

### Logging, Deployment, and Operations

| codewiki `analysis.json` | source app profile | Notes |
| --- | --- | --- |
| `loggingAndObservability.logPoints[]` | `loggingAndAuditability.evidence[]` | Preserve log point evidence. |
| `loggingAndObservability.auditLog` | `loggingAndAuditability.auditTrail` | Preserve `present`, `absent`, or `unknown`. |
| `deployment.platform[]` | `deploymentModel.hosting` or `deploymentModel.evidence[]` | Use hosting when one platform is clear; otherwise preserve as evidence. |
| `deployment.iac[]` | `deploymentModel.infrastructureAsCode[]` | Preserve IaC tools. |
| `deployment.runtime[]` | `deploymentModel.evidence[]` | Preserve runtime evidence. |
| `riskSignals[]` with category `operations` or `reliability` | `operationalSignals[]` or future risk inventory | Keep evidence and confidence. |
| `riskSignals[]` with category `cost` | `costSensitivePaths[]` or future risk inventory | Use route/path when present, otherwise preserve in risk inventory. |

### Unknowns

Always append `analysis.unknowns[]` to `sourceAppProfile.unknowns[]`.

Do not fill unknowns with model guesses. If the adapter derives a field from weak evidence, keep the derived value and set `confidence` to `low`, or keep the field `unknown` and add an unknown explaining what must be reviewed.

## Minimal Normalized Example

```json
{
  "appSlug": "sample-vibe-app",
  "summary": "AI-assisted small web app for user orders.",
  "techStack": {
    "frameworks": ["Next.js"],
    "languages": ["TypeScript"],
    "datastores": ["PostgreSQL"],
    "externalServices": ["OpenAI", "Stripe"]
  },
  "actors": [
    { "name": "anonymous", "trustLevel": "anonymous" },
    { "name": "user", "trustLevel": "authenticated" },
    { "name": "admin", "trustLevel": "admin" }
  ],
  "dataInventory": [
    {
      "name": "orders",
      "classification": "personal",
      "location": "database",
      "fields": ["userId", "shippingAddress"],
      "evidence": ["prisma/schema.prisma"]
    }
  ],
  "entrypoints": [
    {
      "path": "/api/orders/[id]",
      "type": "api",
      "authRequired": "yes",
      "evidence": ["app/api/orders/[id]/route.ts"]
    }
  ],
  "unknowns": ["Whether delete requests remove related order rows is unknown."],
  "confidence": "medium"
}
```

## Safety Rules

- Do not run active scans against deployed systems.
- Do not probe production URLs.
- Do not install optional analyzers during normalization.
- Do not store secret values, credentials, session tokens, API response bodies, or database rows.
- Do not generate exploitation steps from codewiki evidence.
- Do preserve evidence, confidence, and unknowns for human review.

## Future Runtime Promotion

This adapter can move to `scripts/app-to-quest/normalize-codewiki-analysis.ts` only after the schema and mapping have been exercised by the create-problem `app-to-quest` mode. Until then, the reference files are the source of truth for authoring.
