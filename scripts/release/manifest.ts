import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  arrayAt,
  enumAt,
  exactObject,
  exactSemverAt,
  fail,
  httpsUrlAt,
  literalAt,
  strictDateTimeAt,
  stringAt,
  stringMatching,
  uniqueStrings,
} from "./manifest-fields";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 2 as const;
export const RELEASE_MANIFEST_SCHEMA_REF = "./tenkacloud-release.schema.json" as const;
export const RELEASE_MANIFEST_PATH = resolve(
  import.meta.dirname,
  "../../release/tenkacloud-release.json",
);

/**
 * Certified evidence freshness window (#3024). Golden Path runs older than this at
 * validation time are stale: they may describe a world that has since drifted (expired
 * credentials, changed AWS service behavior, rotated images), so they cannot carry a
 * current certification claim. Candidates are unaffected — they never claim support.
 */
export const GOLDEN_PATH_EVIDENCE_MAX_AGE_DAYS = 90 as const;

/**
 * Evidence completed after "now" is rejected — future-dated evidence would defeat the
 * staleness window permanently. One hour absorbs honest clock skew between the runner
 * that produced the evidence and the machine validating the manifest.
 */
export const GOLDEN_PATH_EVIDENCE_FUTURE_SKEW_MS = 60 * 60 * 1000;

export const DEPLOYMENT_MODES = ["lite", "saas-pooled", "saas-silo"] as const;

export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];
export type ReleaseStatus = "candidate" | "certified";
export type VerificationResult = "passed" | "failed";
export type ResidualScanDecision = "passed" | "failed" | "undecidable";

/**
 * The platform source carries no commit on purpose (#3024). This manifest lives inside
 * the platform tree, so it cannot contain the SHA of the commit that contains it — the
 * platform identity of a release is definitionally the commit its `v<version>` tag
 * points at, derived and validated at publish time by `identity.ts`.
 */
export interface PlatformSourceRef {
  readonly repository: string;
}

export interface ReleaseSourceRef {
  readonly repository: string;
  /** Authoritative identity. `tag` is a display label and never replaces this full commit. */
  readonly commit: string;
  readonly tag?: string;
}

export interface SupportedMode {
  readonly mode: DeploymentMode;
  readonly regions: readonly string[];
}

export interface ContractVersion {
  readonly id: string;
  readonly version: string;
}

export interface ReleaseToolchain {
  readonly bun: string;
  readonly node: {
    readonly development: string;
    readonly launcher: string;
  };
  readonly awsCdk: {
    readonly cli: string;
    readonly library: string;
  };
}

export interface EvidenceBom {
  readonly releaseVersion: string;
  readonly platformCommit: string;
  readonly catalogCommit: string;
  readonly simulatorImage: string;
  readonly toolchain: ReleaseToolchain;
}

export interface ResidualScanEvidence {
  readonly reportVersion: 1;
  readonly runId: string;
  readonly decision: ResidualScanDecision;
  readonly evidenceUrl: string;
  readonly evidenceSha256: string;
}

export interface FreshEnvironmentEvidence {
  readonly environmentId: string;
  readonly decision: ResidualScanDecision;
  readonly evidenceUrl: string;
  readonly evidenceSha256: string;
}

export interface EvidenceRunner {
  readonly repository: string;
  readonly commit: string;
}

export interface GoldenPathRun {
  readonly runId: string;
  readonly mode: DeploymentMode;
  readonly region: string;
  readonly completedAt: string;
  readonly result: VerificationResult;
  readonly evidenceUrl: string;
  readonly evidenceSha256: string;
  readonly bom: EvidenceBom;
  readonly runner: EvidenceRunner;
  readonly freshEnvironment: FreshEnvironmentEvidence;
  readonly residualScan: ResidualScanEvidence;
}

export interface ReleaseManifest {
  readonly $schema: typeof RELEASE_MANIFEST_SCHEMA_REF;
  readonly schemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  readonly release: {
    readonly version: string;
    readonly status: ReleaseStatus;
  };
  readonly sources: {
    readonly platform: PlatformSourceRef;
    readonly catalog: ReleaseSourceRef;
  };
  readonly artifacts: {
    readonly simulatorImage: string;
  };
  readonly toolchain: ReleaseToolchain;
  readonly compatibility: {
    readonly qualificationTargets: readonly SupportedMode[];
    readonly supportedModes: readonly SupportedMode[];
    readonly contracts: readonly ContractVersion[];
  };
  readonly verification: {
    readonly goldenPathRuns: readonly GoldenPathRun[];
  };
  readonly knownLimitations: readonly string[];
}

export const FULL_COMMIT = /^[a-f0-9]{40}$/;
const STABLE_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const DIGEST_PINNED_IMAGE =
  /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const EXACT_MAJOR = /^(0|[1-9]\d*)$/;
const DISPLAY_TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const CONTRACT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;

function parsePlatformSource(value: unknown, path: string): PlatformSourceRef {
  const source = exactObject(value, path, ["repository"]);
  return { repository: httpsUrlAt(source.repository, `${path}.repository`) };
}

function parseSourceRef(value: unknown, path: string): ReleaseSourceRef {
  const source = exactObject(value, path, ["repository", "commit"], ["tag"]);
  const parsed: ReleaseSourceRef = {
    repository: httpsUrlAt(source.repository, `${path}.repository`),
    commit: stringMatching(
      source.commit,
      `${path}.commit`,
      FULL_COMMIT,
      "expected a lowercase full 40-hex commit; mutable refs and abbreviated SHAs are invalid",
    ),
  };
  if (source.tag === undefined) return parsed;
  return {
    ...parsed,
    tag: stringMatching(
      source.tag,
      `${path}.tag`,
      DISPLAY_TAG,
      "expected a conventional display tag without revision operators",
    ),
  };
}

function parseSupportedMode(
  value: unknown,
  index: number,
  collection: "qualificationTargets" | "supportedModes" = "supportedModes",
): SupportedMode {
  const path = `$.compatibility.${collection}[${index}]`;
  const supported = exactObject(value, path, ["mode", "regions"]);
  const regions = arrayAt(supported.regions, `${path}.regions`).map((region, regionIndex) =>
    stringMatching(
      region,
      `${path}.regions[${regionIndex}]`,
      AWS_REGION,
      "expected an AWS region identifier",
    ),
  );
  if (regions.length === 0) fail(`${path}.regions`, "expected at least one region");
  uniqueStrings(regions, `${path}.regions`);
  return {
    mode: enumAt(supported.mode, `${path}.mode`, DEPLOYMENT_MODES),
    regions,
  };
}

function parseContract(value: unknown, index: number): ContractVersion {
  const path = `$.compatibility.contracts[${index}]`;
  const contract = exactObject(value, path, ["id", "version"]);
  return {
    id: stringMatching(
      contract.id,
      `${path}.id`,
      CONTRACT_ID,
      "expected a lowercase kebab-case contract id",
    ),
    version: stringAt(contract.version, `${path}.version`),
  };
}

export function parseToolchain(value: unknown, path: string): ReleaseToolchain {
  const toolchain = exactObject(value, path, ["bun", "node", "awsCdk"]);
  const node = exactObject(toolchain.node, `${path}.node`, ["development", "launcher"]);
  const awsCdk = exactObject(toolchain.awsCdk, `${path}.awsCdk`, ["cli", "library"]);
  return {
    bun: exactSemverAt(toolchain.bun, `${path}.bun`),
    node: {
      development: stringMatching(
        node.development,
        `${path}.node.development`,
        EXACT_MAJOR,
        "expected an exact Node.js major version",
      ),
      launcher: stringMatching(
        node.launcher,
        `${path}.node.launcher`,
        EXACT_MAJOR,
        "expected an exact Node.js major version",
      ),
    },
    awsCdk: {
      cli: exactSemverAt(awsCdk.cli, `${path}.awsCdk.cli`),
      library: exactSemverAt(awsCdk.library, `${path}.awsCdk.library`),
    },
  };
}

function parseEvidenceBom(value: unknown, path: string): EvidenceBom {
  const bom = exactObject(value, path, [
    "releaseVersion",
    "platformCommit",
    "catalogCommit",
    "simulatorImage",
    "toolchain",
  ]);
  return {
    releaseVersion: exactSemverAt(bom.releaseVersion, `${path}.releaseVersion`),
    platformCommit: stringMatching(
      bom.platformCommit,
      `${path}.platformCommit`,
      FULL_COMMIT,
      "expected a lowercase full 40-hex platform commit",
    ),
    catalogCommit: stringMatching(
      bom.catalogCommit,
      `${path}.catalogCommit`,
      FULL_COMMIT,
      "expected a lowercase full 40-hex catalog commit",
    ),
    simulatorImage: stringMatching(
      bom.simulatorImage,
      `${path}.simulatorImage`,
      DIGEST_PINNED_IMAGE,
      "expected an OCI image pinned by a lowercase sha256 digest",
    ),
    toolchain: parseToolchain(bom.toolchain, `${path}.toolchain`),
  };
}

function parseResidualScan(value: unknown, path: string): ResidualScanEvidence {
  const scan = exactObject(value, path, [
    "reportVersion",
    "runId",
    "decision",
    "evidenceUrl",
    "evidenceSha256",
  ]);
  return {
    reportVersion: literalAt(scan.reportVersion, `${path}.reportVersion`, 1),
    runId: stringAt(scan.runId, `${path}.runId`),
    decision: enumAt(scan.decision, `${path}.decision`, [
      "passed",
      "failed",
      "undecidable",
    ] as const),
    evidenceUrl: httpsUrlAt(scan.evidenceUrl, `${path}.evidenceUrl`),
    evidenceSha256: stringMatching(
      scan.evidenceSha256,
      `${path}.evidenceSha256`,
      SHA256,
      "expected a lowercase sha256 evidence digest",
    ),
  };
}

function parseFreshEnvironment(value: unknown, path: string): FreshEnvironmentEvidence {
  const evidence = exactObject(value, path, [
    "environmentId",
    "decision",
    "evidenceUrl",
    "evidenceSha256",
  ]);
  return {
    environmentId: stringAt(evidence.environmentId, `${path}.environmentId`),
    decision: enumAt(evidence.decision, `${path}.decision`, [
      "passed",
      "failed",
      "undecidable",
    ] as const),
    evidenceUrl: httpsUrlAt(evidence.evidenceUrl, `${path}.evidenceUrl`),
    evidenceSha256: stringMatching(
      evidence.evidenceSha256,
      `${path}.evidenceSha256`,
      SHA256,
      "expected a lowercase sha256 evidence digest",
    ),
  };
}

function parseEvidenceRunner(value: unknown, path: string): EvidenceRunner {
  const runner = exactObject(value, path, ["repository", "commit"]);
  return {
    repository: httpsUrlAt(runner.repository, `${path}.repository`),
    commit: stringMatching(
      runner.commit,
      `${path}.commit`,
      FULL_COMMIT,
      "expected a lowercase full 40-hex verification-runner commit",
    ),
  };
}

function parseGoldenPathRun(value: unknown, index: number): GoldenPathRun {
  const path = `$.verification.goldenPathRuns[${index}]`;
  const run = exactObject(value, path, [
    "runId",
    "mode",
    "region",
    "completedAt",
    "result",
    "evidenceUrl",
    "evidenceSha256",
    "bom",
    "runner",
    "freshEnvironment",
    "residualScan",
  ]);
  return {
    runId: stringAt(run.runId, `${path}.runId`),
    mode: enumAt(run.mode, `${path}.mode`, DEPLOYMENT_MODES),
    region: stringMatching(
      run.region,
      `${path}.region`,
      AWS_REGION,
      "expected an AWS region identifier",
    ),
    completedAt: strictDateTimeAt(run.completedAt, `${path}.completedAt`),
    result: enumAt(run.result, `${path}.result`, ["passed", "failed"] as const),
    evidenceUrl: httpsUrlAt(run.evidenceUrl, `${path}.evidenceUrl`),
    evidenceSha256: stringMatching(
      run.evidenceSha256,
      `${path}.evidenceSha256`,
      SHA256,
      "expected a lowercase sha256 evidence digest",
    ),
    bom: parseEvidenceBom(run.bom, `${path}.bom`),
    runner: parseEvidenceRunner(run.runner, `${path}.runner`),
    freshEnvironment: parseFreshEnvironment(run.freshEnvironment, `${path}.freshEnvironment`),
    residualScan: parseResidualScan(run.residualScan, `${path}.residualScan`),
  };
}

function modeRegionPairs(modes: readonly SupportedMode[]): Set<string> {
  return new Set(
    modes.flatMap(({ mode, regions }) => regions.map((region) => `${mode}:${region}`)),
  );
}

function assertUniqueEvidenceIdentities(manifest: ReleaseManifest): void {
  const { qualificationTargets, supportedModes, contracts } = manifest.compatibility;
  const runs = manifest.verification.goldenPathRuns;
  uniqueStrings(
    qualificationTargets.map(({ mode }) => mode),
    "$.compatibility.qualificationTargets",
  );
  uniqueStrings(
    supportedModes.map(({ mode }) => mode),
    "$.compatibility.supportedModes",
  );
  uniqueStrings(
    contracts.map(({ id }) => id),
    "$.compatibility.contracts",
  );
  uniqueStrings(
    runs.map(({ runId }) => runId),
    "$.verification.goldenPathRuns",
  );
  uniqueStrings(
    runs.flatMap((run) => [
      run.evidenceUrl,
      run.freshEnvironment.evidenceUrl,
      run.residualScan.evidenceUrl,
    ]),
    "$.verification.goldenPathRuns evidence URLs",
  );
  uniqueStrings(
    runs.flatMap((run) => [
      run.evidenceSha256,
      run.freshEnvironment.evidenceSha256,
      run.residualScan.evidenceSha256,
    ]),
    "$.verification.goldenPathRuns evidence digests",
  );
  uniqueStrings(
    runs.map((run) => run.freshEnvironment.environmentId),
    "$.verification.goldenPathRuns fresh environment IDs",
  );
  uniqueStrings(manifest.knownLimitations, "$.knownLimitations");
}

function assertSupportedPairsAreTargets(
  supportedPairs: ReadonlySet<string>,
  qualificationPairs: ReadonlySet<string>,
): void {
  for (const pair of supportedPairs) {
    if (!qualificationPairs.has(pair)) {
      fail(
        "$.compatibility.supportedModes",
        `certified support pair ${pair} is missing from qualificationTargets`,
      );
    }
  }
}

function assertEvidenceBindings(
  manifest: ReleaseManifest,
  qualificationPairs: ReadonlySet<string>,
): void {
  // The manifest cannot pin its own platform commit (see PlatformSourceRef), so runs are
  // required to agree on ONE platform commit here; `resolveReleaseIdentity` binds that
  // commit to the actual tag commit when the release is published.
  const expectedPlatformCommit = manifest.verification.goldenPathRuns[0]?.bom.platformCommit;
  for (const run of manifest.verification.goldenPathRuns) {
    if (!qualificationPairs.has(`${run.mode}:${run.region}`)) {
      fail(
        "$.verification.goldenPathRuns",
        `run ${JSON.stringify(run.runId)} does not reference a declared qualification target`,
      );
    }
    const expectedBom: EvidenceBom = {
      releaseVersion: manifest.release.version,
      platformCommit: expectedPlatformCommit as string,
      catalogCommit: manifest.sources.catalog.commit,
      simulatorImage: manifest.artifacts.simulatorImage,
      toolchain: manifest.toolchain,
    };
    if (JSON.stringify(run.bom) !== JSON.stringify(expectedBom)) {
      fail(
        "$.verification.goldenPathRuns",
        `run ${JSON.stringify(run.runId)} BOM does not exactly match the top-level release BOM and the platform commit shared by every run`,
      );
    }
    if (run.residualScan.runId !== run.runId) {
      fail(
        "$.verification.goldenPathRuns",
        `run ${JSON.stringify(run.runId)} residual scanner report refers to ${JSON.stringify(run.residualScan.runId)}`,
      );
    }
  }
}

function assertCandidateRelease(manifest: ReleaseManifest): void {
  if (manifest.compatibility.supportedModes.length > 0) {
    fail("$.compatibility.supportedModes", "a candidate release cannot claim certified support");
  }
  if (manifest.knownLimitations.length === 0) {
    fail("$.knownLimitations", "a candidate release must state why it is not certified");
  }
}

function assertCertifiedRunHistory(
  manifest: ReleaseManifest,
  supportedPairs: ReadonlySet<string>,
  now: Date,
): void {
  if (manifest.compatibility.supportedModes.length === 0) {
    fail("$.compatibility.supportedModes", "a certified release must support at least one mode");
  }
  if (manifest.verification.goldenPathRuns.length === 0) {
    fail("$.verification.goldenPathRuns", "a certified release must include Golden Path evidence");
  }
  for (const pair of supportedPairs) {
    const [mode, region] = pair.split(":");
    const runs = manifest.verification.goldenPathRuns
      .filter((run) => run.mode === mode && run.region === region)
      .toSorted(
        (left, right) =>
          Date.parse(left.completedAt) - Date.parse(right.completedAt) ||
          left.runId.localeCompare(right.runId),
      );
    if (runs.length < 3) {
      fail(
        "$.verification.goldenPathRuns",
        `certified support for ${mode}/${region} requires at least three consecutive Golden Path runs`,
      );
    }
    const latestRuns = runs.slice(-3);
    const latestRunsQualify = latestRuns.every(
      (run) =>
        run.result === "passed" &&
        run.freshEnvironment.decision === "passed" &&
        run.residualScan.reportVersion === 1 &&
        run.residualScan.decision === "passed",
    );
    if (!latestRunsQualify) {
      fail(
        "$.verification.goldenPathRuns",
        `the latest three Golden Path runs for ${mode}/${region} must all pass with distinct fresh-environment evidence decision passed and residual scanner report v1 decision passed`,
      );
    }
    const staleBefore = now.getTime() - GOLDEN_PATH_EVIDENCE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const run of latestRuns) {
      const completedAt = Date.parse(run.completedAt);
      if (completedAt < staleBefore) {
        fail(
          "$.verification.goldenPathRuns",
          `run ${JSON.stringify(run.runId)} evidence is stale: certification requires Golden Path evidence completed within ${GOLDEN_PATH_EVIDENCE_MAX_AGE_DAYS} days`,
        );
      }
      if (completedAt > now.getTime() + GOLDEN_PATH_EVIDENCE_FUTURE_SKEW_MS) {
        fail(
          "$.verification.goldenPathRuns",
          `run ${JSON.stringify(run.runId)} evidence is future-dated beyond the allowed clock skew`,
        );
      }
    }
  }
}

function assertCompatibilityAndEvidence(manifest: ReleaseManifest, now: Date): void {
  const qualificationTargets = manifest.compatibility.qualificationTargets;
  if (qualificationTargets.length === 0) {
    fail("$.compatibility.qualificationTargets", "expected at least one qualification target");
  }
  assertUniqueEvidenceIdentities(manifest);
  const qualificationPairs = modeRegionPairs(qualificationTargets);
  const supportedPairs = modeRegionPairs(manifest.compatibility.supportedModes);
  assertSupportedPairsAreTargets(supportedPairs, qualificationPairs);
  assertEvidenceBindings(manifest, qualificationPairs);
  if (manifest.release.status === "candidate") {
    assertCandidateRelease(manifest);
    return;
  }
  assertCertifiedRunHistory(manifest, supportedPairs, now);
}

export interface ParseReleaseManifestOptions {
  /** Validation instant for the certified-evidence freshness window. Injectable for tests. */
  readonly now?: Date;
}

/**
 * Parses the public release contract without coercion or silent unknown-field stripping.
 * Cross-field certification rules live here because JSON Schema cannot express the
 * per-mode/per-region evidence join without duplicating every future compatibility row,
 * and the evidence freshness window is relative to the validation instant.
 */
export function parseReleaseManifest(
  value: unknown,
  options: ParseReleaseManifestOptions = {},
): ReleaseManifest {
  const root = exactObject(value, "$", [
    "$schema",
    "schemaVersion",
    "release",
    "sources",
    "artifacts",
    "toolchain",
    "compatibility",
    "verification",
    "knownLimitations",
  ]);
  const release = exactObject(root.release, "$.release", ["version", "status"]);
  const sources = exactObject(root.sources, "$.sources", ["platform", "catalog"]);
  const artifacts = exactObject(root.artifacts, "$.artifacts", ["simulatorImage"]);
  const compatibility = exactObject(root.compatibility, "$.compatibility", [
    "qualificationTargets",
    "supportedModes",
    "contracts",
  ]);
  const verification = exactObject(root.verification, "$.verification", ["goldenPathRuns"]);

  const qualificationTargets = arrayAt(
    compatibility.qualificationTargets,
    "$.compatibility.qualificationTargets",
  ).map((target, index) => parseSupportedMode(target, index, "qualificationTargets"));
  const supportedModes = arrayAt(
    compatibility.supportedModes,
    "$.compatibility.supportedModes",
  ).map((supported, index) => parseSupportedMode(supported, index, "supportedModes"));
  const contracts = arrayAt(compatibility.contracts, "$.compatibility.contracts").map(
    parseContract,
  );
  if (contracts.length === 0) {
    fail("$.compatibility.contracts", "expected at least one named schema or migration contract");
  }
  const goldenPathRuns = arrayAt(verification.goldenPathRuns, "$.verification.goldenPathRuns").map(
    parseGoldenPathRun,
  );
  const knownLimitations = arrayAt(root.knownLimitations, "$.knownLimitations").map(
    (limitation, index) => stringAt(limitation, `$.knownLimitations[${index}]`),
  );

  const manifest: ReleaseManifest = {
    $schema: literalAt(root.$schema, "$.$schema", RELEASE_MANIFEST_SCHEMA_REF),
    schemaVersion: literalAt(
      root.schemaVersion,
      "$.schemaVersion",
      RELEASE_MANIFEST_SCHEMA_VERSION,
    ),
    release: {
      version: stringMatching(
        release.version,
        "$.release.version",
        STABLE_RELEASE_VERSION,
        "expected a stable X.Y.Z release version; candidate status is carried by $.release.status, not a version suffix",
      ),
      status: enumAt(release.status, "$.release.status", ["candidate", "certified"] as const),
    },
    sources: {
      platform: parsePlatformSource(sources.platform, "$.sources.platform"),
      catalog: parseSourceRef(sources.catalog, "$.sources.catalog"),
    },
    artifacts: {
      simulatorImage: stringMatching(
        artifacts.simulatorImage,
        "$.artifacts.simulatorImage",
        DIGEST_PINNED_IMAGE,
        "expected an OCI image pinned by a lowercase sha256 digest",
      ),
    },
    toolchain: parseToolchain(root.toolchain, "$.toolchain"),
    compatibility: { qualificationTargets, supportedModes, contracts },
    verification: { goldenPathRuns },
    knownLimitations,
  };
  assertCompatibilityAndEvidence(manifest, options.now ?? new Date());
  return manifest;
}

export function readReleaseManifest(
  path = RELEASE_MANIFEST_PATH,
  options: ParseReleaseManifestOptions = {},
): ReleaseManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read release manifest ${path}: ${message}`);
  }
  return parseReleaseManifest(value, options);
}

/**
 * Publication stop until #2982 authenticates referenced evidence bytes, schemas, and digests.
 * Structural metadata can become certification-eligible, but CI must not publish it as certified.
 */
export function assertReleaseCheckEligible(manifest: ReleaseManifest): void {
  if (manifest.release.status === "certified") {
    throw new Error(
      "Certified publication is blocked until #2982 verifies evidence artifact bytes, schemas, and SHA-256 digests.",
    );
  }
}
