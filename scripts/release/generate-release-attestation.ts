import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseReleaseIdentity,
  parseReleaseIdentityCore,
  RELEASE_IDENTITY_CORE_FIELDS,
  type ReleaseIdentity,
} from "./identity";
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

/** A lowercase hex SHA-256, the only digest form this release contract writes or accepts. */
export const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Re-parses a published `release-attestation.json` with the same fail-closed vocabulary the
 * builder writes it under. The attestation crosses the widest trust boundary in this contract
 * — it is downloaded back from a GitHub Release by whoever is auditing it (#3024 PR 5) — so a
 * verifier must never read it as loosely-typed JSON.
 */
export function parseReleaseAttestation(value: unknown): ReleaseAttestation {
  const record = exactObject(value, "$", [
    ...RELEASE_IDENTITY_CORE_FIELDS,
    "schemaVersion",
    "manifestSha256",
    "assets",
    "workflow",
    "generatedAt",
  ]);
  const workflow = exactObject(record.workflow, "$.workflow", [
    "repository",
    "runId",
    "runAttempt",
    "workflowRef",
  ]);
  return {
    // The identity fields parse under the same rules as the resolved identity this
    // attestation was built from — including tag/version agreement (scripts/release/identity.ts).
    ...parseReleaseIdentityCore(record),
    schemaVersion: literalAt(
      record.schemaVersion,
      "$.schemaVersion",
      RELEASE_ATTESTATION_SCHEMA_VERSION,
    ),
    manifestSha256: stringMatching(
      record.manifestSha256,
      "$.manifestSha256",
      SHA256_HEX,
      "expected a lowercase 64-hex sha256 digest",
    ),
    assets: arrayAt(record.assets, "$.assets").map((asset, index) => {
      const entry = exactObject(asset, `$.assets[${index}]`, ["name", "sha256"]);
      return {
        name: stringAt(entry.name, `$.assets[${index}].name`),
        sha256: stringMatching(
          entry.sha256,
          `$.assets[${index}].sha256`,
          SHA256_HEX,
          "expected a lowercase 64-hex sha256 digest",
        ),
      };
    }),
    workflow: {
      repository: stringAt(workflow.repository, "$.workflow.repository"),
      runId: stringAt(workflow.runId, "$.workflow.runId"),
      runAttempt: stringAt(workflow.runAttempt, "$.workflow.runAttempt"),
      workflowRef: stringAt(workflow.workflowRef, "$.workflow.workflowRef"),
    },
    generatedAt: strictDateTimeAt(record.generatedAt, "$.generatedAt"),
  };
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
