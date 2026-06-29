# Threat model and expected remediation

## Asset

A protected GCP endpoint that should be reachable only by a specific AWS
workload, with no long-lived shared secret crossing the cloud boundary.

## Trust boundary

The boundary is the AWS-to-GCP identity exchange. AWS and GCP do not share a
credential. The only thing that crosses is a short-lived, audience-scoped
federated token derived from the AWS workload's own role identity. The security
of the path depends entirely on GCP correctly validating who is calling.

## Threats

| # | Threat | Mitigation in this problem |
|---|--------|----------------------------|
| T1 | Static service-account key leaks (committed, logged, or copied to AWS) and grants standing access. | No key is ever created. There is no `google_service_account_key` resource; the AWS workload holds no GCP credential; outputs and logs carry only identifiers. The grader rejects any static key it observes anywhere. |
| T2 | An attacker in a different AWS account presents a federated token and is accepted. | The Workload Identity provider's `attribute_condition` must pin the trusted AWS account. The shipped condition is intentionally wrong (placeholder account) so an unauthorized account fails closed until remediated. |
| T3 | A token minted for a different audience is replayed against this provider. | The provider's `allowed_audiences` must match exactly the audience the workload presents. The shipped value never matches, so a broken / mismatched audience fails closed. |
| T4 | A federated identity impersonates the service account without authorization. | Impersonation requires `roles/iam.workloadIdentityUser` granted to the exact federated principal. The binding is intentionally absent, so an unbound / unauthorized service account fails closed. |
| T5 | The protected endpoint accepts anonymous traffic, bypassing identity entirely. | The Cloud Run service grants `roles/run.invoker` only to the impersonated service account, with no `allUsers` / `allAuthenticatedUsers` binding. Anonymous traffic is rejected. |
| T6 | Scoring passes on IAM presence without a working call (false positive). | Scoring (`composite-probe`) and the grader both verify the END-TO-END call: the AWS `/verify` route exercises the full exchange-impersonate-call path and returns `200` only on real success. IAM configuration alone scores nothing. |

## Expected remediation

The participant restores the keyless path by fixing only the GCP target:

1. Correct the provider trust: set `attribute_condition` to the real
   `aws-workload` account and set `allowed_audiences` to the audience the
   workload presents (T2, T3).
2. Add the impersonation binding: grant `roles/iam.workloadIdentityUser` to the
   federated principal
   `principalSet://iam.googleapis.com/<pool>/attribute.aws_account/<aws-account-id>`
   (T4).

No change introduces a static key (T1) and no change opens the endpoint to
anonymous traffic (T5). After remediation the `/verify` route returns `200` and
the composite scores (T6).

## Residual risk

The federated token is short-lived and audience-scoped, so even if it were
observed it cannot be replayed outside its audience or after expiry. The only
standing trust is the provider's account condition plus the per-service-account
impersonation binding, both of which are least-privilege and scoped to a single
AWS account.
