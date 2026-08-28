# Architecture

TenkaCloud does not maintain standalone design-decision documents. Detailed design
documents age independently from the implementation and are not treated as a
source of truth.

Use the closest executable evidence instead:

- [`AGENTS.md`](../../AGENTS.md) for platform boundaries and delivery rules.
- [`principles.md`](./principles.md) for judgment principles that apply across
  implementations.
- [`enforcement-registry.md`](./enforcement-registry.md) and
  [`enforcement-rules.json`](./enforcement-rules.json) for machine-enforced
  repository rules.
- Source code, tests, generated CloudFormation assertions, and current GitHub
  issues for behavior and planned work.

When behavior changes, update the implementation and its nearest deterministic
test in the same pull request. Keep documentation at the level of stable user
entry points and avoid duplicating internal control flow.

## Decision records (narrow exception)

[`decisions/`](./decisions/) holds numbered ADRs for the rare case where a design
decision spans multiple repositories and needs a durable, reviewable record
before any implementation lands — not a substitute for the executable-evidence
rule above. See
[`decisions/0001-security-harness-trust-boundary.md`](./decisions/0001-security-harness-trust-boundary.md)
for the security harness boundary and
[`decisions/0002-ctfd-runtime-integration.md`](./decisions/0002-ctfd-runtime-integration.md)
for the CTFd / TenkaCloud cross-system responsibility and credential boundary, and
[`decisions/0003-local-runtime-trust-boundary.md`](./decisions/0003-local-runtime-trust-boundary.md)
for the local-play Docker / Compose trust boundary and broker target architecture.
