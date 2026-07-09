# Cross-cloud identity recovery pack

A production-grade [TenkaCloud Composite problem pack](../reference-aws-hello/README.md)
that lives outside the core `problems/` catalog. It demonstrates the Composite
Runtime on a real cloud-engineering exercise: an AWS workload must recover
keyless access to a protected GCP endpoint through a deliberately misconfigured
Workload Identity Federation boundary.

Runtimes: `aws/cloudformation` (artifact `aws/template.yaml`) and
`gcp/infra-manager` (artifact `gcp/terraform`).

## Layout

```
tenkacloud-pack.json                                         # pack manifest (only entrypoint)
problems/challenges/cross-cloud-identity-recovery/
  metadata.json                                              # problem source of truth (composite + composite-probe)
  aws/template.yaml                                          # AWS target: keyless recovery probe workload
  gcp/terraform/main.tf                                      # GCP target: WIF + broken-trust SA + protected endpoint
  grader/grader.ts                                           # pure, dependency-injected end-to-end grader
  docs/PARTICIPANT.md                                        # participant instructions
  docs/RUNBOOK.md                                            # operator runbook + exact cleanup verification
  docs/THREAT_MODEL.md                                       # threat model + expected remediation
```

## What makes it keyless

No static GCP service-account key exists anywhere: not in the AWS template, not
in the GCP Terraform (there is no `google_service_account_key` resource), not in
either target's outputs, and not in logs. The AWS workload reaches GCP purely
through short-lived federated tokens (STS token exchange plus service-account
impersonation). The grader rejects any static key it sees, wherever it appears.

## Validate

Run the offline validator against this directory, from the repo root:

```bash
make pack-validate ARGS="packs/cross-cloud-identity-recovery"
```

It must report zero diagnostics. The regression test
`infrastructure/test/problem-pack/cross-cloud-identity-recovery.test.ts` asserts
the same, exercises the SDK scoring parser over the metadata, and drives the
grader through the happy path plus every required negative case.

## Solve and score

See [`docs/PARTICIPANT.md`](problems/challenges/cross-cloud-identity-recovery/docs/PARTICIPANT.md)
to solve, [`docs/THREAT_MODEL.md`](problems/challenges/cross-cloud-identity-recovery/docs/THREAT_MODEL.md)
for the security rationale, and
[`docs/RUNBOOK.md`](problems/challenges/cross-cloud-identity-recovery/docs/RUNBOOK.md)
for operator deploy, scoring, and exact teardown verification.

## Version

Bump `version` in `tenkacloud-pack.json` (SemVer) on every change, and keep
`core` aligned with the platform release range you target.
