# External Pack CI

External problem-pack repositories validate their pack in CI by running
TenkaCloud's published SDK CLI directly — no checkout, build, or deployment of
any TenkaCloud platform code is needed (Issue 2108).

> **History:** this integration used to be a reusable `workflow_call` GitHub
> Actions workflow at `.github/workflows/problem-pack-ci.yml`. A pack adopted it
> with a `uses: susumutomita/TenkaCloud/.github/workflows/problem-pack-ci.yml@<tag>`
> stanza. That workflow has been removed from this repository, so a pin to
> any new tag will not find it — only old tags published before the removal
> still carry the file. The CLI it invoked is unaffected and is now the
> supported integration path.

## Adopt it

Add `.github/workflows/pack-ci.yml` to your pack repository, calling the
published CLI directly:

```yaml
name: pack-ci

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  validate-pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
      - name: Validate pack and produce report
        env:
          npm_config_ignore_scripts: "true"
        run: |
          bunx --bun @tenkacloud/problem-sdk tenkacloud-pack-report . \
            --out pack-report.json
```

`@tenkacloud/problem-sdk` installs only the pinned public CLI/SDK toolchain —
it never checks out or executes anything from the TenkaCloud platform repo.
Pin `actions/checkout` and `oven-sh/setup-bun` to a full commit SHA (not shown
above) to match this repository's own supply-chain posture.

## CLI usage

```bash
bunx @tenkacloud/problem-sdk tenkacloud-pack-report <pack-directory> \
  [--out <report.json>] [--no-local-tests]
```

| Flag                | Purpose                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| `<pack-directory>`   | Relative path to the pack root (holds `tenkacloud-pack.json`).          |
| `--out <path>`       | Write the JSON validation report to this path.                          |
| `--no-local-tests`   | Skip the offline local problem harness (default: it runs).             |

The report uses the namespaced diagnostic codes (`PACK_*` / `PROBLEM_*` /
`RUNTIME_*`) from the SDK's public validation contract:

| Report field    | Description                                              |
| ---------------- | --------------------------------------------------------- |
| `result`         | Overall result: `passed` or `failed`.                    |
| `packId`         | Reverse-DNS pack id from the validated manifest.         |
| `packVersion`    | Exact SemVer pack version from the validated manifest.   |
| `contentDigest`  | Deterministic hex SHA-256 over the pack's file bytes.    |
| `ranLocalTests`  | Whether the offline harness phase ran.                   |
| `diagnostics`    | Public, namespaced diagnostics; empty iff `result` is `passed`. |

## Security model

The CLI is offline and least-privilege by construction:

- it requests no cloud credentials and references no secrets;
- the only pack-supplied content it reads is the pack's own files — it never
  executes a script from the pack, and lifecycle scripts stay disabled when
  you install it with `npm_config_ignore_scripts=true` (as shown above);
- it performs no network I/O beyond the package install itself.

Least privilege for your own workflow (the `permissions: contents: read` and
pinned-action guidance above) is your repository's responsibility — the CLI
does not require any elevated scope to run.

## Version policy

Pin `@tenkacloud/problem-sdk` to an exact published version (not `latest`) so
your pack's CI is reproducible; check
[the package on npm](https://www.npmjs.com/package/@tenkacloud/problem-sdk)
for the current one. Diff the SDK's release notes before moving the pin.
