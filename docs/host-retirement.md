# Host retirement review

This is an unpublished Draft. The approved direction retires the SaaS/Lite
platform and individual-practice backend; it does not require every old feature
to move to host. No deployment, migration, data deletion or release publication
is part of this change.

## Retained, retired and unresolved behavior

| Behavior | Decision and current boundary | Owning path |
| --- | --- | --- |
| Organizer and participant hosting | Retained as one Bun process with SQLite; review the actual host catalog for executable problems | `scripts/local-host`, application-admin-console, participant-portal |
| Problem CloudFormation templates | Retained in the pinned problem catalog; no catalog content change | `problems/` |
| Competitor bootstrap and trust | Byte-identical template moved; ExternalId and participant viewer-role contracts remain mandatory | `templates/competitor-bootstrap.yaml`, `scripts/lib/assume-role.ts` |
| Pack creation, validation, immutable install/list/inspect/remove and local activation records | Retained with existing behavior tests; activation alone does not feed host event catalog | `scripts/problem-pack`, public SDKs, `packs/` |
| Generic multi-provider pack authoring | Retained as authoring/validation; host does not promise AWS/GCP/Azure/Sakura execution for every pack | public SDKs and golden-pack tests |
| SaaS control plane, tenant provisioning, pooled/silo CDK and Lambda backend | Retired source and dedicated tests; maintain existing deployments using their fixed old release | [Legacy operations](legacy-operations.md) |
| Lite launcher and launcher release pipeline | Retired; historical v1.11.0 files remain immutable | [Legacy operations](legacy-operations.md) |
| DynamoDB/Turso control data and operational commands | Retired; no conversion or automatic resource cleanup | [Storage boundary](host-storage-decision.md) |
| Individual practice, simulator, snapshots, local disruptions and terminal WebSocket backend | Retired; the table below lists the lost entry points | [Catalog inventory](#individual-practice-catalog) |
| tcloud and machine API generation | Retired backend client/generator; old documentation/specification is a historical reference only | fixed legacy checkout |
| Standalone `POST /problems/{id}/deploy` | **Unresolved review decision and merge blocker.** Removing the old backend removes this endpoint; no host replacement is claimed | Draft review must explicitly decide compatibility |
| Existing AWS sessions | Ending an event, rotating a key or locking a gate prevents eligible new issuance; already issued STS sessions are not instantly revoked | AWS credential expiration/role policy remains the external boundary |
| Container distribution | Unpublished candidate only, with source/catalog labels and local digest record | `release/host-candidate.json` |

## Individual-practice catalog

Measured against catalog commit `363a7c9b83969e20d63b74fd0410a354da5e202b`.
The retired local loader exposes 106 entries, including 98 `multi-verify` and
8 `verify` entries. Fifteen declare terminal access. The host currently retains
`sqli-demo` as a Docker competition problem; the other 105 local entries are
not added to the host by this retirement. Their content remains in `problems/`.
All 15 local terminal paths are retired. Terminal declarations or retained UI
components alone do not imply a working host terminal.

| Problem ID | Old scoring | Old terminal | Host Docker support |
| --- | --- | --- | --- |
| `ac26-bridge-clock` | multi-verify | no | unavailable |
| `ac26-bridge-experiment` | multi-verify | no | unavailable |
| `ac26-bridge-properties` | multi-verify | no | unavailable |
| `ac26-bridge-unknown-x` | multi-verify | no | unavailable |
| `ac26-w1-constraint-lab` | multi-verify | no | unavailable |
| `ac26-w1-underconstraint` | multi-verify | no | unavailable |
| `ac26-w2-beaver-mul` | multi-verify | no | unavailable |
| `ac26-w2-linear-shares` | multi-verify | no | unavailable |
| `ac26-w2-oblivious-transfer` | multi-verify | no | unavailable |
| `ac26-w2-privacy-audit` | multi-verify | no | unavailable |
| `ac26-w2-private-aggregate` | multi-verify | no | unavailable |
| `ac26-w2-secret-sharing` | multi-verify | no | unavailable |
| `ac26-w3-ec-group` | multi-verify | no | unavailable |
| `ac26-w3-fft-domain` | multi-verify | no | unavailable |
| `ac26-w3-field-inverse` | multi-verify | no | unavailable |
| `ac26-w3-nonce-reuse` | multi-verify | no | unavailable |
| `ac26-w3-ntt-roots` | multi-verify | no | unavailable |
| `ac26-w3-passkey-assertion` | multi-verify | no | unavailable |
| `ac26-w3-schnorr` | multi-verify | no | unavailable |
| `ac26-w3-schnorr-drill` | multi-verify | no | unavailable |
| `ac26-w4-arithmetization` | multi-verify | no | unavailable |
| `ac26-w4-commit-open` | multi-verify | no | unavailable |
| `ac26-w4-fri-drill` | multi-verify | no | unavailable |
| `ac26-w4-plonk-drill` | multi-verify | no | unavailable |
| `ac26-w4-proof-pipeline` | multi-verify | no | unavailable |
| `ac26-w4-sumcheck-drill` | multi-verify | no | unavailable |
| `ac26-w5-cmux-blind-rotation` | multi-verify | no | unavailable |
| `ac26-w5-encoding-noise` | multi-verify | no | unavailable |
| `ac26-w5-extract-key-switch` | multi-verify | no | unavailable |
| `ac26-w5-lwe-rlwe` | multi-verify | no | unavailable |
| `ac26-w5-negacyclic-drill` | multi-verify | no | unavailable |
| `ac26-w5-pbs-homnand` | multi-verify | no | unavailable |
| `ac26-w5-rgsw-external` | multi-verify | no | unavailable |
| `ac26-w5-rotation-drill` | multi-verify | no | unavailable |
| `ac26-w6-cosnark-beaver` | multi-verify | no | unavailable |
| `ac26-w6-cosnark-drill` | multi-verify | no | unavailable |
| `ac26-w6-cosnark-linear` | multi-verify | no | unavailable |
| `ac26-w6-cosnark-privacy` | multi-verify | no | unavailable |
| `ac26-w6-nullifier-drill` | multi-verify | no | unavailable |
| `ac26-w6-stack-design` | multi-verify | no | unavailable |
| `ac26-w6-zkvm-exploit-predicate` | multi-verify | no | unavailable |
| `ac26-w6-zkvm-trace-drill` | multi-verify | no | unavailable |
| `ac26-w6-zkvm-witness-binding` | multi-verify | no | unavailable |
| `ac26-w7-capstone-demo` | multi-verify | no | unavailable |
| `ac26-w7-capstone-design` | multi-verify | no | unavailable |
| `acm-validation-migration` | multi-verify | no | unavailable |
| `agent-approval-gameday` | multi-verify | no | unavailable |
| `ai-riscv-screen-repair` | verify | no | unavailable |
| `ai-riscv-soc-repair` | verify | no | unavailable |
| `api-idor-demo` | verify | no | unavailable |
| `asm-worst-case-latency` | multi-verify | no | unavailable |
| `cs-async-result-binding` | multi-verify | no | unavailable |
| `cs-atomic-file-publish` | multi-verify | no | unavailable |
| `cs-auth-claim-audit` | multi-verify | no | unavailable |
| `cs-cache-generation-fence` | multi-verify | no | unavailable |
| `cs-dst-daily-rollup` | multi-verify | no | unavailable |
| `cs-http-retry-idempotency` | multi-verify | no | unavailable |
| `cs-numeric-aggregation-order` | multi-verify | no | unavailable |
| `cs-pagination-drift` | multi-verify | no | unavailable |
| `cs-protocol-state-guard` | multi-verify | no | unavailable |
| `cs-range-boundary-report` | multi-verify | no | unavailable |
| `cs-transaction-visibility-audit` | multi-verify | no | unavailable |
| `csrf-demo` | verify | no | unavailable |
| `db-a1-table-primary-key` | multi-verify | yes | unavailable |
| `db-a10-primary-replica` | multi-verify | yes | unavailable |
| `db-a11-replication-lag` | multi-verify | yes | unavailable |
| `db-a12-partition` | multi-verify | yes | unavailable |
| `db-a2-index-tradeoff` | multi-verify | yes | unavailable |
| `db-a3-query-plan` | multi-verify | yes | unavailable |
| `db-a4-transaction` | multi-verify | yes | unavailable |
| `db-a6-lock` | multi-verify | yes | unavailable |
| `db-a7-mvcc` | multi-verify | yes | unavailable |
| `db-a8-delete-vacuum` | multi-verify | yes | unavailable |
| `db-battle-slow-apparently` | multi-verify | yes | unavailable |
| `db-challenge-blocked-transaction` | multi-verify | yes | unavailable |
| `db-challenge-slow-query` | multi-verify | yes | unavailable |
| `event-host-rehearsal` | multi-verify | no | unavailable |
| `eventbridge-delivery-discipline` | multi-verify | no | unavailable |
| `festivalgate-terminal-api` | multi-verify | no | unavailable |
| `github-oidc-trust-boundary` | multi-verify | no | unavailable |
| `hollow-invite` | multi-verify | no | unavailable |
| `mcp-origin-guardian` | verify | no | unavailable |
| `rls-tenant-isolation` | verify | yes | unavailable |
| `secure-ota-rollback` | multi-verify | no | unavailable |
| `sha256-bytes-padding` | multi-verify | no | unavailable |
| `sha256-compress-digest` | multi-verify | no | unavailable |
| `sha256-schedule-logic` | multi-verify | no | unavailable |
| `signed-does-not-mean-safe` | multi-verify | no | unavailable |
| `sqli-demo` | verify | no | sqli-demo competition |
| `sre-incident-readiness` | multi-verify | no | unavailable |
| `stackstack-defend` | multi-verify | no | unavailable |
| `stackstack-first-request` | multi-verify | no | unavailable |
| `stackstack-gameday` | multi-verify | no | unavailable |
| `stackstack-observability` | multi-verify | no | unavailable |
| `stackstack-onboarding` | multi-verify | no | unavailable |
| `stackstack-recover` | multi-verify | no | unavailable |
| `stackstack-safe-exposure` | multi-verify | no | unavailable |
| `stackstack-secrets` | multi-verify | no | unavailable |
| `stackstack-ship` | multi-verify | no | unavailable |
| `stackstack-vibe-build` | multi-verify | no | unavailable |
| `wix-exposure-audit` | multi-verify | no | unavailable |
| `wp-exposed-backup` | multi-verify | no | unavailable |
| `wp-harden-leaks` | multi-verify | yes | unavailable |
| `wp-midnight-admin` | multi-verify | no | unavailable |
| `wp2shell-local-lab` | multi-verify | no | unavailable |
| `xss-demo` | verify | no | unavailable |

## Tests and evidence

Retained container behavior tests moved in Stage 12. This stage keeps verifier
requests, scoring and version-1 SQLite snapshot reopen checks beside that code.
Pack tests and catalog composition/bundling tests moved with their implementation;
only tests coupled to removed SaaS/Lite event wiring and the SaaS activation guard
are retired. Source-specific CDK/Lambda and control-plane tests are removed with
their implementation. Existing thresholds for retained workspaces are unchanged.
The authoring, workspace membership, candidate identity and host-import checks
remain in the root test entry point.

[Clean checkout verification](host-build-verification.md) and the container
restart test are required evidence before treating a built image as verified.
A copied or shared dependency directory is only a development aid. A real AWS or
external IdP rehearsal is [optional and separately recorded](host-rehearsal.md).
