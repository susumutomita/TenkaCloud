import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

export function repositoryArtifactFile(repositoryRoot: string, artifact: string): string {
  const selectedRoot = resolve(repositoryRoot);
  const selected = lstatSync(selectedRoot);
  if (selected.isSymbolicLink()) {
    throw new Error("Execution artifact paths must not contain symbolic links");
  }
  if (!selected.isDirectory()) {
    throw new Error("Execution artifacts require a repository directory");
  }
  // Resolve filesystem aliases above the selected root (for example macOS /tmp and /var).
  // The root itself and every repository-controlled artifact component must remain unlinked.
  const root = realpathSync(selectedRoot);
  const file = resolve(root, artifact);
  const withinRoot = relative(root, file);
  if (
    !withinRoot ||
    withinRoot === ".." ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot)
  ) {
    throw new Error("Execution artifacts must be inside the repository");
  }
  // Checking only realpath containment would admit links to internal files or directories.
  let current = root;
  const components = relative(current, file).split(sep);
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) {
      throw new Error("Execution artifact paths must not contain symbolic links");
    }
    if (index === components.length - 1 ? !entry.isFile() : !entry.isDirectory()) {
      throw new Error("Execution artifacts must be regular files with directory path components");
    }
  }
  return file;
}

/** Initial vertical slice uses the real, reviewed hello-world flag challenge, never a synthetic production fixture. */
export function cloudExecutionArtifacts(
  scope: Construct,
  repositoryRoot: string,
  bindings: readonly RunnerBinding[],
) {
  // Validate both paths before reading either artifact, even when only the template is unsafe.
  const metadataFile = repositoryArtifactFile(
    repositoryRoot,
    "problems/challenges/hello-world/metadata.json",
  );
  const templateFile = repositoryArtifactFile(
    repositoryRoot,
    "problems/challenges/hello-world/template.yaml",
  );
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
    .parse(JSON.parse(readFileSync(metadataFile, "utf8")) as unknown);
  const templateBody = readFileSync(templateFile, "utf8");
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
  return {
    bucket,
    catalogKey,
    bindingsKey,
    deployment,
    problemIds: catalog.problems.map((problem) => problem.problemId),
  };
}
