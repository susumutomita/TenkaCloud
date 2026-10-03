import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CfnOutput, RemovalPolicy, Stack, Stage } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import type {
  PackAsset,
  ProblemsCatalogBundle,
} from "../../../scripts/problem-pack/catalog-types.js";
import {
  contentDigest,
  type ExecutionCatalog,
  MAX_EXECUTION_CATALOG_BYTES,
  MAX_EXECUTION_PLUGIN_BYTES,
  MAX_EXECUTION_SOURCE_BYTES,
  parseExecutionCatalog,
} from "../problem-deploy/handlers/shared/execution-catalog.js";
import { deploymentLogGroup } from "../utils/deployment-log-group.js";
import { repositoryArtifactFile } from "./execution-artifact-path.js";
import { nativeBattleArtifact } from "./native-battle-artifact.js";

export interface CloudExecutionArtifactInput {
  /** Exact recovered legacy catalog; absence must never adopt the current snapshot. */
  readonly legacyCatalogKey?: string;
  readonly repositoryRoot: string;
  readonly bundle: ProblemsCatalogBundle;
  readonly packAssets?: readonly PackAsset[];
  readonly sourceArchive: ExecutionCatalog["sourceArchive"];
}

function sourceRoot(
  input: CloudExecutionArtifactInput,
  directory: string,
): { root: string; directory: string } {
  if (directory.startsWith("problems/")) return { root: input.repositoryRoot, directory };
  for (const asset of input.packAssets ?? []) {
    const prefix = `pack-problems/${asset.packId}/${asset.version}/`;
    if (directory.startsWith(prefix))
      return { root: asset.problemsRootAbs, directory: directory.slice(prefix.length) };
  }
  throw new Error(`Execution catalog has no owned source root for ${directory}.`);
}
const asMap = (value: unknown): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Execution projection must be an object.");
  return value as Record<string, unknown>;
};

function sourceFiles(selected: { root: string; directory: string }, subdirectory = ""): string[] {
  const target = resolve(selected.root, selected.directory, subdirectory);
  const within = relative(resolve(selected.root), target);
  if (
    !within ||
    within.startsWith(`..${sep}`) ||
    within === ".." ||
    isAbsolute(within) ||
    lstatSync(target).isSymbolicLink()
  )
    throw new Error("Unsafe execution source directory.");
  const files: string[] = [];
  const entries = readdirSync(target, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (["node_modules", ".git", ".DS_Store"].includes(entry.name)) continue;
    const relativePath = [subdirectory, entry.name].filter(Boolean).join("/");
    if (entry.isSymbolicLink())
      throw new Error("Execution source must not contain symbolic links.");
    if (entry.isDirectory()) files.push(...sourceFiles(selected, relativePath));
    else files.push(relativePath);
  }
  return files;
}

function captureProblemSource(
  selected: { root: string; directory: string },
  objects: Map<string, Uint8Array>,
) {
  const files: ExecutionCatalog["sources"][string] = {};
  let hints: unknown;
  for (const relativePath of sourceFiles(selected)) {
    const file = repositoryArtifactFile(selected.root, `${selected.directory}/${relativePath}`);
    if (lstatSync(file).size > MAX_EXECUTION_SOURCE_BYTES)
      throw new Error("Execution source file exceeds byte limit.");
    const bytes = readFileSync(file);
    const digest = contentDigest(bytes);
    const key = `sources/${digest}`;
    objects.set(key, bytes);
    files[relativePath] = { key, digest };
    if (relativePath === "metadata.json") {
      const metadata = JSON.parse(bytes.toString("utf8")) as { hints?: unknown };
      hints = metadata.hints;
    }
  }
  if (!files["metadata.json"]) throw new Error("Execution source metadata missing.");
  return { files, hints };
}

function captureNativeProfile(
  input: CloudExecutionArtifactInput,
  sources: ExecutionCatalog["sources"],
  plugins: ExecutionCatalog["plugins"],
  objects: Map<string, Uint8Array>,
) {
  const problemId = "ac26-crypto-battle";
  if (asMap(input.bundle.catalog)[problemId] !== "problems/battles/ac26-crypto-battle") return [];
  const metadataKey = sources[problemId]?.["metadata.json"]?.key;
  const bytes = metadataKey ? objects.get(metadataKey) : undefined;
  if (!bytes) throw new Error("Native problem metadata is missing.");
  const metadata = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
    cfnParameters?: { ScoreStealEnabled?: string };
  };
  // The existing optional AWS score-steal variant retains its CloudFormation runtime.
  if (metadata.cfnParameters?.ScoreStealEnabled !== "false") return [];
  const native = nativeBattleArtifact(input.repositoryRoot);
  plugins[problemId] = {
    key: native.descriptor.pluginKey,
    digest: native.descriptor.artifactDigest,
  };
  objects.set(native.descriptor.pluginKey, Buffer.from(native.source));
  return [native.descriptor];
}

/** Snapshot every runtime source file and bundle projection together, before publication. */
export function buildCloudExecutionArtifacts(input: CloudExecutionArtifactInput) {
  const rawCatalog = asMap(input.bundle.catalog);
  const catalog: Record<string, string> = {};
  const sources: ExecutionCatalog["sources"] = {};
  const hints: Record<string, unknown> = {};
  const objects = new Map<string, Uint8Array>();
  for (const [problemId, directory] of Object.entries(rawCatalog)) {
    if (typeof directory !== "string")
      throw new Error("Execution problem directory must be a string.");
    catalog[problemId] = directory;
    const captured = captureProblemSource(sourceRoot(input, directory), objects);
    sources[problemId] = captured.files;
    if (captured.hints !== undefined) hints[problemId] = captured.hints;
  }
  const plugins: ExecutionCatalog["plugins"] = {};
  for (const [problemId, source] of Object.entries(asMap(input.bundle.coordinationBundles))) {
    if (
      !Object.hasOwn(catalog, problemId) ||
      typeof source !== "string" ||
      !source ||
      Buffer.byteLength(source) > MAX_EXECUTION_PLUGIN_BYTES
    )
      throw new Error("Invalid execution plugin bundle.");
    const digest = contentDigest(source);
    const key = `plugins/${digest}.mjs`;
    plugins[problemId] = { key, digest };
    objects.set(key, Buffer.from(source));
  }
  const nativeProblems = captureNativeProfile(input, sources, plugins, objects);
  const artifact = parseExecutionCatalog(
    JSON.stringify({
      version: 1,
      catalog,
      sources,
      plugins,
      hints,
      ...Object.fromEntries(
        [
          "scoring",
          "endpoints",
          "phases",
          "visibility",
          "runtimes",
          "disruptions",
          "writeups",
          "provenance",
          "coordination",
        ].map((key) => [key, asMap(input.bundle[key as keyof ProblemsCatalogBundle])]),
      ),
      sourceArchive: input.sourceArchive,
      ...(nativeProblems.length ? { nativeProblems } : {}),
    }),
  );
  const serialized = JSON.stringify(artifact);
  if (Buffer.byteLength(serialized) > MAX_EXECUTION_CATALOG_BYTES)
    throw new Error("Execution catalog exceeds byte limit.");
  const catalogKey = `catalogs/${contentDigest(serialized)}.json`;
  objects.set(catalogKey, Buffer.from(serialized));
  return { catalog: artifact, catalogKey, objects };
}

export class CloudExecutionArtifacts extends Construct {
  readonly bucket: Bucket;
  readonly catalogKey: string;
  readonly supportedProblemIds: readonly string[];
  readonly nativeProblemIds: readonly string[];
  readonly deployment: BucketDeployment;
  readonly legacyCatalogKey?: string;
  constructor(scope: Construct, id: string, input: CloudExecutionArtifactInput) {
    super(scope, id);
    if (input.legacyCatalogKey && !/^catalogs\/[a-f0-9]{64}\.json$/u.test(input.legacyCatalogKey))
      throw new Error("Invalid recovered legacy catalog identity.");
    this.legacyCatalogKey = input.legacyCatalogKey;
    const snapshot = buildCloudExecutionArtifacts(input);
    this.catalogKey = snapshot.catalogKey;
    this.supportedProblemIds = Object.keys(snapshot.catalog.catalog);
    this.nativeProblemIds = (snapshot.catalog.nativeProblems ?? []).map(
      (problem) => problem.problemId,
    );
    this.bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const assembly = Stage.of(this);
    if (!assembly) throw new Error("Execution artifacts require a CDK assembly.");
    // Keep reusable synth inputs under the owned assembly, never loose in the
    // operating-system temp directory. CDK's normal outdir cleanup owns them.
    const staging = join(assembly.outdir, "execution-inputs", snapshot.catalogKey.slice(9, -5));
    mkdirSync(staging, { recursive: true });
    for (const [key, bytes] of snapshot.objects) {
      mkdirSync(dirname(join(staging, key)), { recursive: true });
      writeFileSync(join(staging, key), bytes);
    }
    this.deployment = new BucketDeployment(this, "Deploy", {
      logGroup: deploymentLogGroup(this, "UploadLogs"),
      sources: [Source.asset(staging)],
      destinationBucket: this.bucket,
      prune: false,
      retainOnDelete: false,
      memoryLimit: 512,
    });
  }

  bindReaders(scope: Construct) {
    const readerIds = [
      "DeployApi",
      "EventApi",
      "ParticipantPortalLambda",
      "GenericScoring",
      "DisruptionExecutor",
      "CfnDeploy",
      "CoordinationDispatcher",
    ];
    for (const node of scope.node.findAll()) {
      if (!(node instanceof NodejsFunction)) continue;
      const parts = node.node.path.split("/");
      if (!readerIds.some((id) => parts.includes(id))) continue;
      const prefixes: ("catalogs" | "sources" | "plugins")[] = ["catalogs"];
      if (["DeployApi", "EventApi", "CfnDeploy"].some((id) => parts.includes(id)))
        prefixes.push("sources");
      // EventApi only verifies saved plugin bytes before admitting a reset;
      // actual plugin execution stays in CoordinationDispatcher.
      if (["EventApi", "CoordinationDispatcher"].some((id) => parts.includes(id)))
        prefixes.push("plugins");
      this.bind(node, prefixes);
    }
    new CfnOutput(scope, "ExecutionArtifactBucket", { value: this.bucket.bucketName });
    new CfnOutput(scope, "ExecutionCatalogKey", { value: this.catalogKey });
    if (this.legacyCatalogKey)
      new CfnOutput(scope, "LegacyExecutionCatalogKey", { value: this.legacyCatalogKey });
  }

  /** Private backend readers only; no portal client receives an artifact URL or IAM grant. */
  bind(fn: NodejsFunction, prefixes: readonly ("catalogs" | "sources" | "plugins")[]) {
    fn.addEnvironment("CLOUD_ARTIFACT_BUCKET", this.bucket.bucketName);
    fn.addEnvironment("CLOUD_CATALOG_KEY", this.catalogKey);
    fn.addEnvironment("CONTROL_PLANE_ACCOUNT", Stack.of(this).account);
    if (this.legacyCatalogKey) fn.addEnvironment("CLOUD_LEGACY_CATALOG_KEY", this.legacyCatalogKey);
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: prefixes.map((prefix) => this.bucket.arnForObjects(`${prefix}/*`)),
      }),
    );
    fn.node.addDependency(this.deployment);
  }
}
