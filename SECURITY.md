# Security Policy

TenkaCloud is a self-hostable, Apache-2.0 platform. It is deployed from source
(there are no published version artifacts), so security fixes land on `main`.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` (latest) | ✅ |
| Older commits / forks | Update to the latest `main` |

Self-hosters should track `main` and redeploy to pick up fixes. Dependencies are
kept current by Dependabot (`.github/dependabot.yml`), and CI scans for malicious
packages (Aikido Safe Chain) on every install.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's
**[Report a vulnerability](https://github.com/susumutomita/TenkaCloud/security/advisories/new)**
(Security → Advisories → Report a vulnerability) on this repository. Include:

- the affected component (file path or endpoint),
- reproduction steps or a proof of concept,
- the impact (what an attacker can do), and
- any suggested remediation.

We aim to acknowledge a report within a few days and to keep you updated as we
triage, fix, and — when appropriate — publish an advisory. Reporters are credited
on request.

## Scope

**In scope:** the platform code (`apps/*`, `infrastructure/*`, `scripts/*`,
`packages/*`) and the deploy / federation / scoring paths.

**Out of scope — intentional by design:** competition problem templates under
`problems/` (for example `security-battle-royale`) deliberately ship vulnerable
applications so competitors can attack and defend them. A vulnerability *inside a
problem's training scenario is a feature, not a bug*. Please report only issues
that let a problem escape its isolated competitor account or that affect the
platform itself.

## Issue comment attachments

TenkaCloud does not accept zip archives, binaries, installer files, shell
scripts, or patch files through Issue / PR comments. Submit code changes as a
normal pull request instead. Maintainers should avoid downloading or extracting
comment attachments unless they have been inspected in a safe environment.

## Hardening and posture

- Cross-account `AssumeRole` into competitor accounts always requires `ExternalId`.
  Auth is Cognito JWT throughout (no bypasses). See [CLAUDE.md](./CLAUDE.md)
  ("Security") for the full list.
- **Competitor bootstrap role is a deliberate exception, not least-privilege.**
  The IAM role created by
  [`infrastructure/templates/competitor-bootstrap.yaml`](./infrastructure/templates/competitor-bootstrap.yaml)
  attaches the AWS managed `AdministratorAccess` policy inside the
  competitor's own AWS account (Issue #721: granular per-service policies kept
  missing permissions as new problem templates were added, causing repeated
  `CREATE_FAILED` / `ROLLBACK_COMPLETE`). This exception is scoped to that one
  role — it does not extend to the Control Plane, Application Plane, CI, or
  operator roles, which stay least-privilege. Compensating controls: the
  trust policy is locked to the TenkaCloud account ID plus a mandatory
  `ExternalId`, `MaxSessionDuration` is capped at 1 hour, and the competitor
  revokes access in one shot by deleting the stack.
