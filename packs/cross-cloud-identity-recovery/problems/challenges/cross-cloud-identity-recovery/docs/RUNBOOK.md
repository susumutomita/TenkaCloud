# Operator runbook: cross-cloud identity recovery

This problem is a Composite challenge with two targets: `aws-workload`
(AWS CloudFormation) and `gcp-service` (GCP Infrastructure Manager / Terraform).
The platform deploys both into the competitor's own AWS and GCP accounts. This
runbook covers deploy prerequisites, scoring, and exact cleanup verification.

## Prerequisites

- An AWS account for the `aws-workload` target and a GCP project for the
  `gcp-service` target, both owned by the competitor team.
- GCP project `number` and `id` (non-sensitive). The project number feeds the
  Workload Identity Federation audience.
- No static service-account keys are created, requested, or stored at any point.
  This is a keyless problem by construction.

## Deploy

1. Deploy `gcp-service` first. Capture its outputs:
   - `workload_identity_pool_id`
   - `workload_identity_provider_id`
   - `service_account_email`
   - `protected_endpoint_url`
   - `project_number`
2. Deploy `aws-workload`, passing the GCP outputs as the template parameters
   `GcpProjectNumber`, `GcpWorkloadIdentityPoolId`,
   `GcpWorkloadIdentityProviderId`, `GcpServiceAccountEmail`, and
   `GcpProtectedEndpoint`. Capture its outputs:
   - `RecoveryProbeUrl`
   - `WorkloadRoleArn`
   - `FederationAudience`
3. The Composite Runtime orders both targets and exposes the namespaced outputs
   to scoring automatically; manual wiring above is only needed for a standalone
   operator dry run.

## Scoring

Scoring kind is `composite-probe` (`success: "all"`, `pointsAllOk: 100`). The
scorer GETs `<RecoveryProbeUrl>/verify` and awards points only on `200`, which
the workload returns only after the full keyless AWS-to-GCP call succeeds. No
points are awarded while either target is incomplete or while any step fails
closed.

## Teardown

Tear down `aws-workload` and `gcp-service` independently; order does not matter.

- AWS: delete the CloudFormation stack for `aws-workload`.
- GCP: destroy the Infrastructure Manager deployment for `gcp-service`.

## Cleanup verification (exact steps)

Run these after teardown. Every check must hold before the environment is
considered clean. None of these incur billable workload; they read provider
control-plane state only.

### AWS

1. Stack is gone:

   ```bash
   aws cloudformation describe-stacks --stack-name <aws-workload-stack> \
     2>&1 | grep -q "does not exist" && echo "AWS stack deleted" || echo "AWS STACK STILL PRESENT"
   ```

2. No probe function remains:

   ```bash
   aws lambda list-functions \
     --query "Functions[?starts_with(FunctionName, 'RecoveryProbeFunction')].FunctionName" \
     --output text
   ```

   Expect empty output.
3. No leftover IAM role:

   ```bash
   aws iam list-roles --query "Roles[?contains(RoleName, 'RecoveryProbeRole')].RoleName" \
     --output text
   ```

   Expect empty output.

### GCP

1. Protected Cloud Run service is gone (no billable workload remains):

   ```bash
   gcloud run services list --region "$REGION" \
     --filter "metadata.name=protected-endpoint" --format "value(metadata.name)"
   ```

   Expect empty output.
2. Service account is removed:

   ```bash
   gcloud iam service-accounts list \
     --filter "email:protected-caller@*" --format "value(email)"
   ```

   Expect empty output.
3. Workload Identity Pool is deleted (it moves to a soft-deleted control-plane
   record, which is expected and not billable):

   ```bash
   gcloud iam workload-identity-pools describe cross-cloud-recovery \
     --location global --format "value(state)"
   ```

   Expect `DELETED` (soft-deleted control-plane record) or a "not found" error.
   A soft-deleted pool is the expected residual provider control-plane record and
   carries no cost.
4. Confirm no service-account key was ever created (defense in depth):

   ```bash
   gcloud iam service-accounts keys list \
     --iam-account "protected-caller@$PROJECT_ID.iam.gserviceaccount.com" \
     2>&1 | grep -q "NOT_FOUND\|does not exist" \
     && echo "no SA keys (expected)" || echo "CHECK: SA or keys unexpectedly present"
   ```

### Final state

After the steps above:

- No AWS Lambda, IAM role, or CloudFormation stack for this problem remains.
- No GCP Cloud Run service or service account remains.
- The only acceptable residual is the soft-deleted Workload Identity Pool
  control-plane record, which is non-billable.
- No static service-account key exists, because none was ever created.
