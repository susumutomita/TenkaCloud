# Architecture Decision Records

ADRs are the source of truth for TenkaCloud's design decisions. They are authored as
self-contained HTML (`adr-<number>-<slug>.html`), not Markdown — see
[CLAUDE.md](../../CLAUDE.md#adr-conventions) for the authoring rules
(self-contained, no chat context, no rolling-update metadata).

## Numbering convention

New ADRs use a **3-digit, zero-padded number** (`adr-005-...html`, `adr-012-...html`,
`adr-100-...html` once the count passes 99). The first four ADRs in this repository predate
this convention and were numbered with 4 digits (`adr-0001`..`adr-0004`); they are **not**
renumbered, to avoid breaking existing inbound links — 4-digit and 3-digit are both valid for
ADRs that already exist, but every **new** ADR from here forward uses 3 digits.

## Existing ADRs

| ADR | Title | Status |
| --- | --- | --- |
| [adr-0001](./adr-0001-managed-participant-access-for-non-aws-targets.html) | Managed participant access for non-AWS targets | Accepted |
| [adr-0002](./adr-0002-pack-compatibility-and-release-policy.html) | Pack compatibility and release policy | Accepted |
| [adr-0003](./adr-0003-unified-developer-platform-architecture.html) | Unified developer platform architecture | Accepted |
| [adr-0004](./adr-0004-api-docs-sandbox-contract.html) | API docs sandbox contract | Accepted |
| [adr-012](./adr-012-three-asset-problem-model.html) | Three-asset problem model and built-in scoring kinds | Accepted |
| [adr-014](./adr-014-polling-first-with-eventbridge-reconciliation.html) | Polling-first with EventBridge reconciliation | Accepted |
| [adr-016](./adr-016-lite-mode-single-tenant.html) | Lite mode (single-tenant) | Accepted |
| [adr-028](./adr-028-inter-team-coordination.html) | Inter-team coordination plugin contract | Accepted |
| [adr-035](./adr-035-feature-flags.html) | Feature flags | Accepted |
| [adr-048](./adr-048-composite-target-participant-access.html) | Managed participant access for composite targets (AWS / GCP / Azure / Sakura) | Accepted |
| [adr-049](./adr-049-always-on-cloudflare-control-plane.html) | Always-on control plane on Cloudflare, on-demand AWS event runtime | Accepted |
| [adr-050](./adr-050-oidc-command-seam.html) | AWS-native OIDC federation for the Cloudflare → AWS command seam | Accepted |
| [adr-051](./adr-051-local-multicloud-simulator.html) | Provider-neutral local cloud simulation | Accepted |
| [adr-052](./adr-052-google-form-as-landing-form-backend.html) | Google Form as the landing page's form backend | Accepted |
| [adr-053](./adr-053-stateless-mcp-role-boundaries.html) | Stateless MCP 2026-07-28 with role-bound endpoints | Accepted |

## Referenced-but-not-yet-drafted ADR numbers

Several ADR numbers are referenced in code comments (`grep -rn "ADR-0XX"`) without a matching
HTML file in this directory yet. Issue #2229 (RC-30) tracks drafting the highest-impact ones; the
following are known and intentionally out of scope for that issue's first pass:

- **ADR-008 / ADR-023 / ADR-030 / ADR-039** — referenced only, no HTML draft exists. If you are
  about to add a **new** reference to one of these numbers, do not assume the design is
  documented — read the referencing code's own comments for the current understanding, and
  consider drafting the ADR (or filing a follow-up issue) instead of adding another dangling
  reference.

## Adding a new ADR

1. Pick the next unused 3-digit number.
2. Copy the structure of an existing ADR (background → decision → consequences → alternatives
   considered → migration) — see [adr-048](./adr-048-composite-target-participant-access.html) for
   a fully-worked example with tables and pill/badge styling you can reuse.
3. Write it to stand alone: no "Claude proposes / user owns" role-split notes, no chat
   transcript excerpts, no unresolved TODOs. An OSS reader with no prior context must be able
   to understand the background, the decision, and the impact from the ADR alone.
4. Add a row to the table above.
5. `make harness` runs the `adr-must-be-html` / `adr-self-contained` invariant checks; existing
   violations are baselined at `.claude/harness/baselines/adr-self-contained.json` so only new
   regressions fail the gate.
