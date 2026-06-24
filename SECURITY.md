# Security Policy

TenkaCloud is a self-hostable, Apache-2.0 platform. It is deployed from source
(there are no published version artifacts), so security fixes land on `main`.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` (latest) | ✅ |
| Older commits / forks | Update to the latest `main` |

Self-hosters should track `main` and redeploy to pick up fixes. Dependencies are
kept current by Renovate / Dependabot, and CI scans for malicious packages
(Aikido Safe Chain) on every install.

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

## Hardening and posture

- Cross-account `AssumeRole` into competitor accounts always requires `ExternalId`,
  and the competitor IAM role is least-privilege. Auth is Cognito JWT throughout
  (no bypasses). See [CLAUDE.md](./CLAUDE.md) ("Security") for the full list.
</content>
