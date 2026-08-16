import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReleaseBomFields, parseReleaseIdentity, type ReleaseIdentity } from "./identity";
import {
  arrayAt,
  exactObject,
  fail,
  literalAt,
  strictDateTimeAt,
  stringAt,
  stringMatching,
} from "./manifest-fields";

export const RELEASE_ATTESTATION_SCHEMA_VERSION = 1 as const;
export const RELEASE_ATTESTATION_FILENAME = "release-attestation.json";

/**
 * The asset set every published release must carry (#3024). The attestation itself is
 * excluded from SHA256SUMS — it is written after the sums and embeds them, so hashing
 * it into its own input would be circular.
 */
export function requiredReleaseAssets(version: string): readonly string[] {
  return [
    `tenkacloud-cli-${version}.tgz`,
    "tenkacloud-cli.tgz",
    "release-manifest.json",
    "release-report.md",
  ];
}

export interface AttestedAsset {
  readonly name: string;
  readonly sha256: string;
}

export interface WorkflowIdentity {
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly workflowRef: string;
}

export interface ReleaseAttestation {
  readonly schemaVersion: typeof RELEASE_ATTESTATION_SCHEMA_VERSION;
  readonly tag: string;
  readonly version: string;
  readonly status: ReleaseIdentity["status"];
  readonly platformCommit: string;
  readonly catalogCommit: string;
  readonly simulatorImage: string;
  readonly manifestSha256: string;
  readonly assets: readonly AttestedAsset[];
  readonly workflow: WorkflowIdentity;
  readonly generatedAt: string;
}

/** Parses `sha256sum` output: one `<64-hex><two spaces or space+*><name>` per line. */
export function parseSha256Sums(content: string): readonly AttestedAsset[] {
  const assets: AttestedAsset[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (line === "") continue;
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
    if (!match)
      fail(`$.sha256sums[${index}]`, `unparseable sha256sum line ${JSON.stringify(line)}`);
    assets.push({ name: match[2] as string, sha256: match[1] as string });
  }
  return assets;
}

export interface BuildAttestationInput {
  readonly identity: ReleaseIdentity;
  readonly sums: readonly AttestedAsset[];
  readonly workflow: WorkflowIdentity;
  readonly generatedAt: string;
}

/**
 * Joins the resolved release identity with the hashed asset set into the attestation
 * that binds tag, platform commit, manifest digest, artifact digests, and workflow run
 * identity (#3024). Fails closed when the asset set is not exactly the required one —
 * a missing artifact must stop the release before `gh release create`, and an
 * unexpected extra file must never ship unexamined.
 */
export function buildReleaseAttestation(input: BuildAttestationInput): ReleaseAttestation {
  const required = requiredReleaseAssets(input.identity.version);
  const byName = new Map(input.sums.map((asset) => [asset.name, asset]));
  if (byName.size !== input.sums.length) {
    fail("$.sha256sums", "duplicate asset names in SHA256SUMS");
  }
  for (const name of required) {
    if (!byName.has(name)) {
      fail("$.sha256sums", `required release asset ${JSON.stringify(name)} is missing`);
    }
  }
  for (const asset of input.sums) {
    if (!required.includes(asset.name)) {
      fail(
        "$.sha256sums",
        `unexpected asset ${JSON.stringify(asset.name)}; the release asset set is closed`,
      );
    }
  }
  const manifestSha256 = byName.get("release-manifest.json")?.sha256 as string;
  return {
    schemaVersion: RELEASE_ATTESTATION_SCHEMA_VERSION,
    tag: input.identity.tag,
    version: input.identity.version,
    status: input.identity.status,
    platformCommit: input.identity.platformCommit,
    catalogCommit: input.identity.catalogCommit,
    simulatorImage: input.identity.simulatorImage,
    manifestSha256,
    assets: required.map((name) => byName.get(name) as AttestedAsset),
    workflow: input.workflow,
    generatedAt: input.generatedAt,
  };
}

const SHA256 = /^[a-f0-9]{64}$/;
const RUN_NUMBER = /^[1-9]\d*$/;

function parseAttestedAsset(value: unknown, index: number): AttestedAsset {
  const record = exactObject(value, `$.assets[${index}]`, ["name", "sha256"]);
  return {
    name: stringAt(record.name, `$.assets[${index}].name`),
    sha256: stringMatching(
      record.sha256,
      `$.assets[${index}].sha256`,
      SHA256,
      "expected a lowercase SHA-256 digest",
    ),
  };
}

function parseWorkflowIdentity(value: unknown): WorkflowIdentity {
  const record = exactObject(value, "$.workflow", [
    "repository",
    "runId",
    "runAttempt",
    "workflowRef",
  ]);
  return {
    repository: stringAt(record.repository, "$.workflow.repository"),
    runId: stringMatching(record.runId, "$.workflow.runId", RUN_NUMBER, "expected a GitHub run id"),
    runAttempt: stringMatching(
      record.runAttempt,
      "$.workflow.runAttempt",
      RUN_NUMBER,
      "expected a GitHub run attempt number",
    ),
    workflowRef: stringAt(record.workflowRef, "$.workflow.workflowRef"),
  };
}

/**
 * Parses a `release-attestation.json` that crossed a trust boundary — a downloaded
 * release asset (#3024 PR 5), not the file this script just wrote. Same fail-closed
 * vocabulary as the manifest and identity parsers: unknown fields, short SHAs, mutable
 * image tags, and a tag that disagrees with its own version are all rejected before any
 * field is compared with the release being verified.
 */
export function parseReleaseAttestation(value: unknown): ReleaseAttestation {
  const record = exactObject(value, "$", [
    "schemaVersion",
    "tag",
    "version",
    "status",
    "platformCommit",
    "catalogCommit",
    "simulatorImage",
    "manifestSha256",
    "assets",
    "workflow",
    "generatedAt",
  ]);
  const attestation: ReleaseAttestation = {
    schemaVersion: literalAt(
      record.schemaVersion,
      "$.schemaVersion",
      RELEASE_ATTESTATION_SCHEMA_VERSION,
    ),
    ...parseReleaseBomFields(record),
    manifestSha256: stringMatching(
      record.manifestSha256,
      "$.manifestSha256",
      SHA256,
      "expected a lowercase SHA-256 digest",
    ),
    assets: arrayAt(record.assets, "$.assets").map(parseAttestedAsset),
    workflow: parseWorkflowIdentity(record.workflow),
    generatedAt: strictDateTimeAt(record.generatedAt, "$.generatedAt"),
  };
  if (attestation.tag !== `v${attestation.version}`) {
    fail("$.tag", `does not match the attested version ${JSON.stringify(attestation.version)}`);
  }
  return attestation;
}

export function workflowIdentityFromEnv(env: NodeJS.ProcessEnv): WorkflowIdentity {
  const read = (name: string): string => {
    const value = env[name];
    if (!value) fail(`$.env.${name}`, "required workflow environment variable is missing");
    return value;
  };
  return {
    repository: read("GITHUB_REPOSITORY"),
    runId: read("GITHUB_RUN_ID"),
    runAttempt: read("GITHUB_RUN_ATTEMPT"),
    workflowRef: read("GITHUB_WORKFLOW_REF"),
  };
}

function argValue(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(
      "Usage: bun run scripts/release/generate-release-attestation.ts " +
        "--identity <release-identity.json> --assets-dir <dir>",
    );
  }
  return value;
}

function main(): void {
  const identityPath = argValue(process.argv.slice(2), "--identity");
  const assetsDir = argValue(process.argv.slice(2), "--assets-dir");
  const identity = parseReleaseIdentity(JSON.parse(readFileSync(identityPath, "utf8")));
  const sums = parseSha256Sums(readFileSync(join(assetsDir, "SHA256SUMS"), "utf8"));
  const attestation = buildReleaseAttestation({
    identity,
    sums,
    workflow: workflowIdentityFromEnv(process.env),
    generatedAt: new Date().toISOString(),
  });
  const outputPath = join(assetsDir, RELEASE_ATTESTATION_FILENAME);
  writeFileSync(outputPath, `${JSON.stringify(attestation, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
