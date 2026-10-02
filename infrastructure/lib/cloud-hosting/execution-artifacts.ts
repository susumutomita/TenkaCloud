import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RemovalPolicy } from "aws-cdk-lib";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { buildSync } from "esbuild";
import { z } from "zod";
import { contentDigest } from "../problem-deploy/control-data/domain/deployment-work.js";
import {
  executionCatalogSchema,
  type RunnerBinding,
} from "../problem-deploy/handlers/cloud-api/execution-config.js";
import { deploymentLogGroup } from "../utils/deployment-log-group.js";

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

/** Build only the reviewed pure plugin closure; never upload its CloudFormation placeholder. */
export function nativeBattleArtifact(repositoryRoot: string) {
  const problemDir = "problems/battles/ac26-crypto-battle";
  const entry = `${problemDir}/coordination/crypto-battle.ts`;
  const metadata = z
    .object({
      id: z.literal("ac26-crypto-battle"),
      name: z.string(),
      description: z.string(),
      instructions: z.string(),
      interTeamCoordination: z.object({
        plugin: z.literal("coordination/crypto-battle.ts"),
        stateBudget: z.object({ bytesPerTeam: z.literal(31744), baseBytes: z.literal(1536) }),
      }),
      i18n: z.object({
        en: z.object({ name: z.string(), description: z.string(), instructions: z.string() }),
      }),
    })
    .parse(
      JSON.parse(
        readFileSync(repositoryArtifactFile(repositoryRoot, `${problemDir}/metadata.json`), "utf8"),
      ) as unknown,
    );
  const result = buildSync({
    absWorkingDir: realpathSync(repositoryRoot),
    entryPoints: [repositoryArtifactFile(repositoryRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  for (const [input, details] of Object.entries(result.metafile.inputs)) {
    const path = relative(
      realpathSync(repositoryRoot),
      resolve(realpathSync(repositoryRoot), input),
    )
      .split(sep)
      .join("/");
    if (
      path !== entry &&
      !path.startsWith(`${problemDir}/game/src/`) &&
      !path.startsWith("packages/coordination-plugin-sdk/src/")
    )
      throw new Error("Native plugin import is outside the reviewed closure.");
    repositoryArtifactFile(repositoryRoot, path);
    if (details.imports.some((item) => item.external && item.path !== "node:crypto"))
      throw new Error("Native plugin has an unreviewed external import.");
  }
  for (const output of Object.values(result.metafile.outputs))
    if (output.imports.some((item) => !item.external || item.path !== "node:crypto"))
      throw new Error("Native plugin bundle is not self-contained.");
  const source = result.outputFiles?.[0]?.text;
  if (
    !source ||
    Buffer.byteLength(source) > 1024 * 1024 ||
    /\b(?:require|import)\s*\(/u.test(source)
  )
    throw new Error("Native plugin bundle contains an unsupported dynamic import.");
  const artifactDigest = contentDigest(source);
  const pluginKey = `plugins/${artifactDigest}.mjs`;
  return {
    source,
    descriptor: {
      kind: "coordination" as const,
      problemId: metadata.id,
      problemDir,
      artifactDigest,
      pluginKey,
      stateBudget: metadata.interTeamCoordination.stateBudget,
      name: metadata.name,
      description: metadata.description,
      instructions: metadata.instructions,
      i18n: metadata.i18n,
    },
  };
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
  const native = nativeBattleArtifact(repositoryRoot);
  const catalog = executionCatalogSchema.parse({
    version: 1,
    nativeProblems: [native.descriptor],
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
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });
  const deployment = new BucketDeployment(scope, "ExecutionArtifactUpload", {
    logGroup: deploymentLogGroup(scope),
    destinationBucket: bucket,
    sources: [
      Source.data(catalogKey, rawCatalog),
      Source.data(bindingsKey, rawBindings),
      Source.data(native.descriptor.pluginKey, native.source),
    ],
    prune: false,
    retainOnDelete: false,
  });
  deployment.node.addDependency(bucket);
  return {
    bucket,
    catalogKey,
    bindingsKey,
    deployment,
    pluginKey: native.descriptor.pluginKey,
    nativeProblemIds: (catalog.nativeProblems ?? []).map((problem) => problem.problemId),
    problemIds: [...catalog.problems, ...(catalog.nativeProblems ?? [])].map(
      (problem) => problem.problemId,
    ),
  };
}
