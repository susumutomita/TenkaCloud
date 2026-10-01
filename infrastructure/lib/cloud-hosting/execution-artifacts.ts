import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RemovalPolicy } from "aws-cdk-lib";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { z } from "zod";
import { contentDigest } from "../problem-deploy/control-data/domain/deployment-work.js";
import {
  executionCatalogSchema,
  type RunnerBinding,
} from "../problem-deploy/handlers/cloud-api/execution-config.js";

/** Initial vertical slice uses the real, reviewed hello-world flag challenge, never a synthetic production fixture. */
export function cloudExecutionArtifacts(
  scope: Construct,
  repositoryRoot: string,
  bindings: readonly RunnerBinding[],
) {
  const folder = join(repositoryRoot, "problems/challenges/hello-world");
  const metadata = z
    .object({
      id: z.literal("hello-world"),
      cfnParameters: z.record(z.string()),
      scoring: z.object({
        kind: z.literal("flag"),
        points: z.number(),
        flagOutputKey: z.string(),
        wrongAnswerPenalty: z.number(),
      }),
    })
    .passthrough()
    .parse(JSON.parse(readFileSync(join(folder, "metadata.json"), "utf8")) as unknown);
  const templateBody = readFileSync(join(folder, "template.yaml"), "utf8");
  const catalog = executionCatalogSchema.parse({
    version: 1,
    problems: [
      {
        problemId: metadata.id,
        problemDir: "problems/challenges/hello-world",
        templateBody,
        artifactDigest: contentDigest(templateBody),
        parameters: metadata.cfnParameters,
        scoring: {
          kind: "flag",
          points: metadata.scoring.points,
          flagOutputKey: metadata.scoring.flagOutputKey,
          wrongPenalty: metadata.scoring.wrongAnswerPenalty,
        },
        capabilities: ["CAPABILITY_NAMED_IAM"],
        publicOutputKeys: ["NamePrefix", "ParameterName", "ParameterConsoleUrl"],
      },
    ],
  });
  const rawCatalog = JSON.stringify(catalog);
  const rawBindings = JSON.stringify(bindings);
  const catalogKey = `catalogs/${contentDigest(rawCatalog)}.json`;
  const bindingsKey = `bindings/${contentDigest(rawBindings)}.json`;
  const bucket = new Bucket(scope, "ExecutionArtifacts", {
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    encryption: BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    versioned: true,
    removalPolicy: RemovalPolicy.RETAIN,
  });
  const deployment = new BucketDeployment(scope, "ExecutionArtifactUpload", {
    destinationBucket: bucket,
    sources: [Source.data(catalogKey, rawCatalog), Source.data(bindingsKey, rawBindings)],
    prune: false,
  });
  return { bucket, catalogKey, bindingsKey, deployment };
}
