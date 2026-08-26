# Reference AWS Hello pack

A minimal reference [TenkaCloud problem pack](../../docs/) that lives outside the
core `problems/` catalog. It exercises the pack manifest (`tenkacloud-pack.json`)
and the offline validator contracts, and doubles as the worked example a
`tenkacloud pack init` scaffold expands into.

Runtime: `aws/cloudformation` (artifact `template.yaml`).

## Layout

```
tenkacloud-pack.json                       # pack manifest (the only entrypoint)
problems/challenges/hello-world/
  metadata.json                            # problem source of truth
  template.yaml                            # provider artifact placeholder
```

## Validate

Run the offline validator against this directory, from the repo root:

```bash
make pack-validate ARGS="packs/reference-aws-hello"
```

It must report zero diagnostics. A regression test (`reference-pack.test.ts`)
asserts the same so the example never drifts from the contract.

## Validate in CI

An external pack repository validates in CI by running the published SDK CLI
directly, without copying any platform internals (see
[`docs/external-pack-ci.md`](../../docs/external-pack-ci.md)):

```yaml
jobs:
  validate-pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bunx --bun @tenkacloud/problem-sdk tenkacloud-pack-report .
```

## Test

This pack carries no author tests of its own; the validator above is the contract
it must always pass. Author your own problem tests alongside `metadata.json` when
you grow this pack into a real one.

## Version

Bump the `version` field in `tenkacloud-pack.json` (SemVer) on every change, and
keep `core` aligned with the platform release range you target.

## Publish

Publishing is out of band: validate, commit, tag the pack version, and share the
directory or archive. The pack carries no credentials and no secrets.
