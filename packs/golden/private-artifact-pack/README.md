# Golden private artifact pack

Golden reference pack. The declared private payload and provenance contract: the payload is referenced by source and digest, with no secret embedded in the pack.

It is a canonical, executable example: scaffoldable, validatable, testable, and
composable through the same public contracts as any external contributor pack.
It lives outside the core `problems/` catalog and imports no platform internals.

## Capability covered

The declared private payload and provenance contract: the payload is referenced by source and digest, with no secret embedded in the pack.

## Validate

```bash
bun --cwd infrastructure run pack validate packs/golden/private-artifact-pack
```

The reusable external-pack CI workflow runs the same offline validation; see
[`docs/external-pack-ci.md`](../../../docs/external-pack-ci.md).

## Test

Local harness fixtures live next to each problem under `tests/*.json` and run
offline through `@tenkacloud/problem-test` (no cloud, no network).

## Copy this pack

An external author copies this directory and edits only the documented
author-owned files: metadata.json, template.yaml, and tests/*.json. Bump `version` (SemVer) in
`tenkacloud-pack.json` on every change and keep `core` aligned with the
platform release range you target.

The full contracts live in the Developer Portal reference docs; this README does
not duplicate them.
