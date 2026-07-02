# Hello Multicloud pack

The **hello-world of Composite Runtime**: one Challenge that deploys a free
hello endpoint on **AWS** (Lambda Function URL) and on **Google Cloud**
(Cloud Run), scored by `composite-probe` against both targets. Its whole
purpose is to smoke-test the composite pipeline end to end — deploy fan-out,
per-target status, namespaced outputs, scoring, and teardown — with the
smallest possible cloud footprint.

## What one deploy stands up

| Target | Provider / engine | Resources | Probe output |
| --- | --- | --- | --- |
| `aws-hello` | `aws` / `cloudformation` | Lambda (128 MB, inline hello) + Function URL + read-only participant viewer role | `AwsHelloUrl` |
| `gcp-hello` | `gcp` / `infra-manager` | One scale-to-zero Cloud Run service (stock `gcr.io/cloudrun/hello` image, public invoker) | `GcpHelloUrl` |

Scoring: `composite-probe`, `success: "all"` — the problem scores
`pointsAllOk: 100` only when **both** hello URLs answer HTTP 200. One cloud
down = no points, which is exactly the signal a smoke test wants.

## Cost

- **AWS**: $0 at rest and effectively $0 under probe traffic (Lambda free tier
  is 1M requests/month; the function has no idle cost and no other resource is
  billed).
- **Google Cloud**: Cloud Run scales to zero (no idle cost) and probe traffic
  sits far inside the Cloud Run free tier; `max_instance_count = 1` caps any
  surprise. Verify current Infrastructure Manager pricing for your account
  before a long-running event — the deployment object itself may be billed
  per active hour depending on GCP's current pricing.

## Validate / test offline

```bash
# Pack validation + declarative scoring cases (also run in CI):
cd infrastructure && bunx vitest run test/problem-pack/hello-multicloud-pack.test.ts
```

## Install into a platform checkout

```bash
bun run infrastructure/bin/tenkacloud-pack.ts install packs/hello-multicloud
```

`install` validates, snapshots, and locks the pack (it does not activate).
Activate the revision for an event through the normal pack activation flow.

## Live-deploy prerequisites (one-time)

1. **Feature flag** — non-AWS runtimes are OFF by default (ADR-035). Set
   `features: { "nonAwsRuntime": true }` in `runtime-config.json`.
2. **Team GCP credential (keyless WIF)** — create a Workload Identity pool +
   service account with `gcloud` and register
   `{ wifAudience, serviceAccountEmail, projectId, location }` in the Team
   Cloud Credentials panel. The Infra Manager deployment is created in that
   `projectId` / `location`. No service-account key exists anywhere.
3. **Verified AWS competitor account** — same requirement as every AWS problem.
4. **Public Cloud Run allowed** — the hello service uses an `allUsers` invoker
   binding; an org policy with domain-restricted sharing will reject it.

## Known platform gaps this pack works around (read before a live run)

- **GCP entry staging**: the platform passes a GCP target's `entry` verbatim to
  Infrastructure Manager as `terraformBlueprint.gcsSource`, and no code stages
  local files to GCS yet. The pack declares the local module `gcp/terraform`
  (which is what pack validation requires); for a live run, upload that
  directory to a bucket the team's WIF service account can read and point the
  target's entry at it:

  ```bash
  gsutil -m cp -r packs/hello-multicloud/problems/challenges/hello-multicloud/gcp/terraform \
    gs://<your-staging-bucket>/hello-multicloud/
  # then, in the installed revision's metadata, set the gcp-hello entry to:
  #   gs://<your-staging-bucket>/hello-multicloud/terraform
  ```

- **AWS template location**: the live CFn path (CodeBuild `deploy-battles.sh`)
  always deploys `<problemDir>/template.yaml` and ignores the composite
  target's `entry`. This pack therefore keeps the AWS body at the problem root
  as `template.yaml` — do not move it under `aws/`.

- **AWS stack naming**: the live CFn path names the stack
  `tc-<problemId>-<teamSlug>` (no per-target suffix). Harmless for this pack
  (it has exactly one AWS target), but keep it in mind when reading stacks.

## Live smoke checklist

1. Deploy the problem for a test team; watch the organizer deployment detail —
   the parent should go `PENDING -> IN_PROGRESS -> COMPLETE` once **both**
   targets are ready.
2. Confirm both outputs appear under their target ids — `aws-hello` and
   `gcp-hello` — then `curl` both URLs; each answers 200.
3. Run scoring — `composite-probe` awards 100 only with both targets up.
4. Stop the Cloud Run service or delete the function URL and re-score — points
   stop (the failure path works).
5. Tear down — the parent reaches `DELETED`, the CFn stack is gone, and the
   Infra Manager deployment (and its Cloud Run service) is deleted.
