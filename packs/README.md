# packs/

In-repo sample / golden / reference problem packs (3-asset model:
`metadata.json` + `template.yaml` + optional `portal/`). Each subdirectory is a
self-contained Problem Pack (`tenkacloud-pack.json` manifest + `problems/`
tree) with its own README — worked examples and fixtures, not the community
catalog (that's the [`problems/`](../problems/) submodule →
[TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge)).

To install / activate any pack for a tenant, see the top-level README's
[Add your own problems / Option B](../README.md#add-your-own-problems)
(`make pack-init` / `pack-validate` / `pack-install` / `pack-activate`).

## Golden packs (`golden/`)

- [`basic-aws-pack`](./golden/basic-aws-pack/) — one deploy-only problem + one flag-scored problem
- [`multicloud-pack`](./golden/multicloud-pack/) — Composite Runtime over AWS/GCP/Azure/Sakura, scored by composite-probe
- [`portal-ui-pack`](./golden/portal-ui-pack/) — the portal extension contract (`endpoints[]` slot + `portal/` component + uptime-flat)
- [`private-artifact-pack`](./golden/private-artifact-pack/) — declared private payload + provenance, no embedded secret

## Reference packs

- [`reference-aws-hello`](./reference-aws-hello/) — minimal pack exercising the manifest + offline validators
- [`reference-coordination-battle`](./reference-coordination-battle/) — worked example of the inter-team coordination contract

## Sample packs

- [`sample-aws-endpoint`](./sample-aws-endpoint/) — smallest problem with a real, reachable endpoint scored on uptime
- [`sample-aws-flag`](./sample-aws-flag/) — smallest end-to-end deploy → flag → score example

## Production-grade example

- [`cross-cloud-identity-recovery`](./cross-cloud-identity-recovery/) — AWS workload recovers keyless access to a GCP endpoint via Workload Identity Federation
