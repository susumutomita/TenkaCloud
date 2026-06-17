# TenkaCloud Security Posture

> Landing page for operators, enterprise evaluators, and security reviewers. For vulnerability reporting (private channel), see [`SECURITY.md`](../../SECURITY.md).

## Start here

- [Commercial hosted event hardening checklist](./HARDENING-CHECKLIST.html) — the item-by-item posture statement covering identity & access, problem template safety, operator account hygiene, data & log handling, participant safety, teardown, and supply chain. Each item links to its evidence (file / harness rule / ADR / runbook) and is tagged **Implemented / Gap / Roadmap**.
- [Data classification & handling policy](./DATA-CLASSIFICATION.html) — the inventory of every data item the platform collects, classified as PII / secret / operational, with its storage location, retention, and encryption. It is the source of truth the public privacy policy must stay consistent with.
- [backup and restore posture](../runbooks/backup-restore.html) — operator-facing recovery boundary for DynamoDB state, S3 assets, runtime config, audit logs, environment configuration, and intentionally ephemeral data.

This is the minimum credible security baseline for running **paid** TenkaCloud cloud-competition events. It is **not** a SOC2 certification. SOC2-oriented audit work is tracked separately under [#1335](https://github.com/susumutomita/TenkaCloud/issues/1335).

## How to verify each control locally

Run these before every paid event. All commands are non-destructive.

| Control area | What to verify | Command |
| --- | --- | --- |
| Identity & access | No `AUTH_SKIP` bypass anywhere in the tree | `grep -R "AUTH_SKIP" apps/ infrastructure/` (must return nothing) |
| Identity & access | Harness rule `iam-wildcard-needs-justify` is active | `make harness-test` |
| Identity & access | SAML admin allowlist parses (or is empty = deny-all) | `bun run --filter @TenkaCloud/infrastructure test -- saml-admin-allowlist` |
| Identity & access | Cross-account trust requires ExternalId | `grep -n ExternalId infrastructure/templates/competitor-bootstrap.yaml` |
| Template safety | All problem templates pass the 5 security rules | `make check-template-security` |
| Template safety | Templates only contain printable ASCII (Description fields) | `make check-template-ascii` |
| Template safety | Template CFn references resolve | `make check-template-cfn-refs` |
| Data & log handling | Secrets Manager is not imported anywhere | `grep -R "@aws-sdk/client-secrets-manager" infrastructure/ apps/` (must return nothing) |
| Data & log handling | Audit redact tests pass | `bun run --filter @TenkaCloud/infrastructure test -- audit-redact` |
| Tenant isolation | Harness rule `handler-tenant-isolation` is green | `make harness` |
| Participant safety | Flag submission uses `WRITE_VERY_LOW` rate limit | `grep -n WRITE_VERY_LOW infrastructure/lib/problem-deploy/handlers/participant-handler/` |
| Supply chain | No new lifecycle scripts vs. baseline | `make audit-deps` |
| Supply chain | All GitHub Actions are SHA-pinned | `grep -E "uses: [^@]+@v" .github/workflows/` (must return nothing) |
| Full gate | Everything together | `make harness && make before-commit` |

## When to re-read the checklist

- Before every commercial pilot kick-off
- After merging any ADR that touches IAM, audit, or cross-account access
- When opening a PR that touches `infrastructure/lib/control-plane/`, `infrastructure/lib/problem-deploy/handlers/`, or `infrastructure/templates/`
- Quarterly, as a posture sanity check

## Reporting a security issue

See [`SECURITY.md`](../../SECURITY.md). Do not file public GitHub issues for sensitive disclosures.

## Cross-references

- Architecture invariants — [`docs/architecture/harness.md`](../architecture/harness.md)
- Operations runbooks — [`docs/runbooks/`](../runbooks/)
- backup and restore — [`docs/runbooks/backup-restore.md`](../runbooks/backup-restore.md)
- Project rules (forbidden patterns + tech stack) — [`CLAUDE.md`](../../CLAUDE.md), [`AGENTS.md`](../../AGENTS.md)
