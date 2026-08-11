import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  synthWithCodeBuild,
  synthWithDeployViaLambda,
} from "./problem-deploy-backend-stack.test-helpers";

/**
 * Issue #2291: the Lambda deploy path's `buildS3ArtifactsResolver` reads
 * `${problemDir}/template.yaml` + `${problemDir}/metadata.json` from the source bucket, where
 * `problemDir` is `problems/<category>/<id>` (events.ts schema). This slice materializes the repo
 * `problems/` tree into the source bucket under the `problems/` key prefix via a `BucketDeployment`
 * so those keys resolve. It is gated on `deployViaLambda`; flag OFF adds no resource (default-safe).
 */
const SOURCE_BUCKET = "test-source-bucket";

describe("ProblemDeployBackendStack — problem artifacts materialization (Issue #2291)", () => {
  // Synth in the collection phase (not inside it()) — the full-stack synth bundles 5 Lambdas +
  // stages the problems/ asset and exceeds vitest's 5s per-test timeout otherwise. This mirrors
  // the shared-fixture pattern in the sibling backend-stack test files.
  const tpl = synthWithDeployViaLambda();

  it("should materialize problem artifacts into the source bucket when deployViaLambda is on", () => {
    // A BucketDeployment that (a) targets the source bucket, (b) lands objects under the
    // `problems/` key prefix (so keys equal `problems/<category>/<id>/template.yaml`), and
    // (c) sets Prune=false so it does NOT delete source.zip / other objects in that bucket.
    tpl.hasResourceProperties(
      "Custom::CDKBucketDeployment",
      Match.objectLike({
        DestinationBucketName: SOURCE_BUCKET,
        DestinationBucketKeyPrefix: "problems",
        Prune: false,
      }),
    );
  });
});

describe("ProblemDeployBackendStack — no artifacts materialization when deployViaLambda is off", () => {
  // Issue #2291: Lambda が既定になったので、flag OFF (在来 CodeBuild 経路) を明示 synth する。
  const tpl = synthWithCodeBuild();

  it("should NOT add the bucket deployment when deployViaLambda is off", () => {
    // The flag-OFF (CodeBuild) stack still has the CompetitorBootstrapHosting BucketDeployment, but
    // it targets its own generated bucket — none may target the shared source bucket.
    const deployments = tpl.findResources("Custom::CDKBucketDeployment");
    const targetingSource = Object.values(deployments).filter(
      (resource) =>
        (resource as { Properties?: { DestinationBucketName?: unknown } }).Properties
          ?.DestinationBucketName === SOURCE_BUCKET,
    );
    expect(targetingSource).toHaveLength(0);
  });
});
