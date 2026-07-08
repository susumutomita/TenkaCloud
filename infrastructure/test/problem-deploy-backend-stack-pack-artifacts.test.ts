import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Match } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, it } from "vitest";
import {
  synthWithDeployViaLambda,
  synthWithPackAssets,
} from "./problem-deploy-backend-stack.test-helpers";

/**
 * Issue #2462: on the Lambda deploy path, each installed + active pack revision is materialized into
 * the source bucket under `pack-problems/<packId>/<version>/` via its own `BucketDeployment`, so the
 * pack catalog directory keys (`pack-problems/<packId>/<version>/<category>/<id>`) resolve to real
 * objects. `packAssets` empty (the default core-only path) adds no pack `BucketDeployment` =
 * CFn byte-identical. prune:false keeps each pack from clobbering the core tree / source.zip.
 */
const SOURCE_BUCKET = "test-source-bucket";
const PACK_ID = "com.example.cloud-pack";
const VERSION = "1.0.0";

// Module-scope fixture: a pack snapshot problems root with one problem's deploy body. Created before
// the collection-phase synth below so `Source.asset` can stage it; removed after the suite runs.
const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-artifacts-"));
const problemDir = path.join(packRoot, "challenges", "pack-only");
fs.mkdirSync(problemDir, { recursive: true });
fs.writeFileSync(path.join(problemDir, "template.yaml"), "Resources: {}\n");
fs.writeFileSync(path.join(problemDir, "metadata.json"), JSON.stringify({ id: "pack-only" }));

describe("ProblemDeployBackendStack — active pack artifacts materialization (#2462)", () => {
  // Synth in the collection phase (not inside it()) — the full-stack synth bundles Lambdas + stages
  // the problems/ and pack assets and exceeds vitest's 5s per-test timeout otherwise. Mirrors the
  // shared-fixture pattern in the sibling backend-stack test files.
  const tpl = synthWithPackAssets([
    { packId: PACK_ID, version: VERSION, problemsRootAbs: packRoot },
  ]);
  afterAll(() => fs.rmSync(packRoot, { recursive: true, force: true }));

  it("should materialize each active pack under pack-problems/<packId>/<version> with Prune=false", () => {
    tpl.hasResourceProperties(
      "Custom::CDKBucketDeployment",
      Match.objectLike({
        DestinationBucketName: SOURCE_BUCKET,
        DestinationBucketKeyPrefix: `pack-problems/${PACK_ID}/${VERSION}`,
        Prune: false,
      }),
    );
  });
});

describe("ProblemDeployBackendStack — no pack artifacts when packAssets is empty (#2462)", () => {
  const tpl = synthWithDeployViaLambda();

  it("should NOT add any pack-problems bucket deployment on the default core-only path", () => {
    const deployments = tpl.findResources("Custom::CDKBucketDeployment");
    const packTargets = Object.values(deployments).filter((resource) =>
      String(
        (resource as { Properties?: { DestinationBucketKeyPrefix?: unknown } }).Properties
          ?.DestinationBucketKeyPrefix ?? "",
      ).startsWith("pack-problems/"),
    );
    expect(packTargets).toHaveLength(0);
  });
});
