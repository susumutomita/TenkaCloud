# Participant instructions: cross-cloud identity recovery

## Your goal

An AWS workload must call a protected GCP endpoint, and it must do so without any
static service-account key. The platform deploys two targets for you:

- `aws-workload` (AWS CloudFormation): a recovery probe workload. Its public
  `/verify` route attempts the full AWS-to-GCP keyless call and reports the
  result. The scorer probes this route.
- `gcp-service` (GCP Infrastructure Manager / Terraform): a Workload Identity
  Federation pool, a service account, and a protected Cloud Run endpoint. The
  trust and the impersonation binding are deliberately broken.

Right now the `/verify` route fails. Your job is to repair the GCP identity
boundary so the keyless path works end to end.

## What you may and may not do

- You MUST keep the path keyless. Do not create a service-account key
  (`google_service_account_key`), do not paste a key into the AWS workload, and
  do not expose the protected endpoint to anonymous callers. Any of these fails
  scoring.
- You do NOT need platform-admin credentials. Everything you change lives inside
  the two deployed targets you own.

## The keyless path, step by step

1. The AWS workload presents a federated subject token (its own AWS role
   identity) to GCP STS with a specific audience.
2. GCP STS validates the token against the Workload Identity Pool provider's
   trust (allowed audiences plus an attribute condition on the AWS account) and
   returns a short-lived federated access token.
3. The federated identity impersonates the GCP service account. This requires
   the service account to grant the federated principal
   `roles/iam.workloadIdentityUser`.
4. The impersonated token calls the protected Cloud Run endpoint, which permits
   only the impersonated service account (never anonymous traffic).

## What is broken (and how to fix it)

Inspect `gcp/terraform/main.tf`. Two faults block the path:

1. Broken trust on the provider (`google_iam_workload_identity_pool_provider`):
   - `attribute_condition` pins the AWS account to a placeholder
     (`000000000000`) instead of the real `aws-workload` account. Bind it to the
     deployed AWS account id. The AWS target output `WorkloadRoleArn` /
     `FederationAudience` tells you the account.
   - `oidc.allowed_audiences` is set to a value the workload never presents. Set
     it to the audience the workload actually uses, which is the AWS target
     output `FederationAudience`.
2. Missing impersonation binding: the `google_service_account_iam_member` that
   grants `roles/iam.workloadIdentityUser` to the federated principal is
   commented out. Add it, with the member
   `principalSet://iam.googleapis.com/<pool-name>/attribute.aws_account/<aws-account-id>`.

Re-apply the GCP target, then re-run the probe.

## Verify your fix

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$RECOVERY_PROBE_URL/verify"
```

`RECOVERY_PROBE_URL` is the `RecoveryProbeUrl` output of the AWS target. A `200`
means the keyless cross-cloud call succeeded end to end and you will score. Any
other status means a step still fails closed -- read the response body for which
step (`federation exchange failed`, `impersonation failed`, or
`protected endpoint rejected the caller`).

## Scoring

Scoring is `composite-probe` with `success: "all"`: the platform awards
`pointsAllOk` (100) only when the AWS target's `/verify` route returns `200`,
which it does only when the entire keyless path works. Presence of IAM
configuration alone earns nothing -- the end-to-end call must succeed.
