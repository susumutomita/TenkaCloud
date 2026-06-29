# External Pack CI (reusable workflow)

External problem-pack repositories validate their pack in CI by calling
TenkaCloud's published reusable GitHub Actions workflow. A pack repo adopts the
same deterministic quality gate as official packs with one `uses:` stanza, and
without checking out, building, or deploying any TenkaCloud platform code
(Issue 2108).

## Adopt it

Add `.github/workflows/pack-ci.yml` to your pack repository:

```yaml
name: pack-ci

on:
  push:
  pull_request:

jobs:
  validate-pack:
    uses: susumutomita/TenkaCloud/.github/workflows/problem-pack-ci.yml@v1
    with:
      pack-directory: .
      run-local-tests: true
      upload-report: true
```

That is the whole integration. The workflow checks out your pack, installs only
the pinned public `@tenkacloud/problem-sdk` CLI, validates the manifest +
metadata + structure offline, and produces a deterministic JSON report.

## Inputs

| Input             | Type    | Default    | Purpose                                                         |
| ----------------- | ------- | ---------- | --------------------------------------------------------------- |
| `pack-directory`  | string  | `.`        | Relative path to the pack root (holds `tenkacloud-pack.json`).  |
| `run-local-tests` | boolean | `true`     | Run the offline local problem harness (deterministic SDK validation). |
| `upload-report`   | boolean | `false`    | Upload the JSON validation report as a build artifact.          |
| `core-version`    | string  | `latest`   | Explicit `@tenkacloud/problem-sdk` version for compatibility validation. |

## Outputs

| Output                    | Description                                              |
| ------------------------- | -------------------------------------------------------- |
| `pack-id`                 | Reverse-DNS pack id from the validated manifest.         |
| `pack-version`            | Exact SemVer pack version from the validated manifest.   |
| `content-digest`          | Deterministic hex SHA-256 over the pack's file bytes.    |
| `validation-report-path`  | Path to the JSON report inside the runner workspace.     |
| `result`                  | Overall result: `passed` or `failed`.                    |

The report uses the same namespaced diagnostic codes (`PACK_*` / `PROBLEM_*` /
`RUNTIME_*`) as the SDK's public validation contract, so a diagnostic means the
same thing whether you run the workflow or `@tenkacloud/problem-sdk` locally.

## Run it locally

The workflow runs nothing you cannot run yourself — it invokes the published CLI:

```bash
bunx @tenkacloud/problem-sdk tenkacloud-pack-report . --out pack-report.json
```

## Security model

The reusable workflow is offline and least-privilege by construction:

- it is `workflow_call`-only; it never uses a privileged pull-request trigger;
- the job token is read-only (`permissions: contents: read`);
- it requests no cloud credentials and references no secrets;
- the only pack-supplied command it runs is the published SDK CLI — no script
  from the pack is executed, and lifecycle scripts stay disabled during install;
- pack source files are never uploaded as artifacts; only the JSON report is, and
  only when `upload-report` is `true`;
- every third-party action is pinned to a full commit SHA.

## Version policy

The `@v1` tag of the reusable workflow points at a reviewed, immutable release.
Breaking changes to the inputs, outputs, or security posture ship under a new
major tag (`@v2`); additive changes ship within `@v1`. Pin to a major tag (not a
branch) so an external pack's CI is reproducible.
