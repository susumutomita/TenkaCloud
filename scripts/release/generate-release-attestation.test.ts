import { describe, expect, it } from "bun:test";
import {
  buildReleaseAttestation,
  parseReleaseAttestation,
  parseSha256Sums,
  requiredReleaseAssets,
  type WorkflowIdentity,
  workflowIdentityFromEnv,
} from "./generate-release-attestation";
import { parseReleaseIdentity, type ReleaseIdentity } from "./identity";

const IDENTITY: ReleaseIdentity = {
  tag: "v1.4.0",
  version: "1.4.0",
  status: "candidate",
  platformCommit: "d".repeat(40),
  catalogCommit: "5".repeat(40),
  simulatorImage: `ghcr.io/susumutomita/tenkacloud-simulator@sha256:${"0".repeat(64)}`,
  toolchain: {
    bun: "1.3.11",
    node: { development: "24", launcher: "22" },
    awsCdk: { cli: "2.1133.0", library: "2.262.1" },
  },
};

const WORKFLOW: WorkflowIdentity = {
  repository: "susumutomita/TenkaCloud",
  runId: "31569275500",
  runAttempt: "1",
  workflowRef: "susumutomita/TenkaCloud/.github/workflows/release-cli.yml@refs/tags/v1.4.0",
};

function sumsFor(names: readonly string[]): string {
  const lines = names.map((name, i) => {
    const digest = (i + 1).toString(16).padStart(64, "0");
    return `${digest}  ${name}`;
  });
  return `${lines.join("\n")}\n`;
}

function completeSums(): string {
  return sumsFor(requiredReleaseAssets(IDENTITY.version));
}

describe("release attestation", () => {
  it("binds tag, platform commit, manifest digest, asset digests, and the workflow run", () => {
    const sums = parseSha256Sums(completeSums());
    const attestation = buildReleaseAttestation({
      identity: IDENTITY,
      sums,
      workflow: WORKFLOW,
      generatedAt: "2026-08-12T07:00:00.000Z",
    });
    expect(attestation.schemaVersion).toBe(1);
    expect(attestation.tag).toBe("v1.4.0");
    expect(attestation.platformCommit).toBe(IDENTITY.platformCommit);
    expect(attestation.manifestSha256).toBe(
      sums.find(({ name }) => name === "release-manifest.json")?.sha256,
    );
    expect(attestation.assets.map(({ name }) => name)).toEqual([
      "tenkacloud-cli-1.4.0.tgz",
      "tenkacloud-cli.tgz",
      "release-manifest.json",
      "release-report.md",
    ]);
    expect(attestation.workflow).toEqual(WORKFLOW);
  });

  it.each(requiredReleaseAssets("1.4.0"))("fails closed when %s is missing", (missing) => {
    const names = requiredReleaseAssets(IDENTITY.version).filter((name) => name !== missing);
    expect(() =>
      buildReleaseAttestation({
        identity: IDENTITY,
        sums: parseSha256Sums(sumsFor(names)),
        workflow: WORKFLOW,
        generatedAt: "2026-08-12T07:00:00.000Z",
      }),
    ).toThrow(`required release asset ${JSON.stringify(missing)} is missing`);
  });

  it("rejects unexpected extra assets: the release asset set is closed", () => {
    const names = [...requiredReleaseAssets(IDENTITY.version), "debug.log"];
    expect(() =>
      buildReleaseAttestation({
        identity: IDENTITY,
        sums: parseSha256Sums(sumsFor(names)),
        workflow: WORKFLOW,
        generatedAt: "2026-08-12T07:00:00.000Z",
      }),
    ).toThrow('unexpected asset "debug.log"');
  });

  it("rejects duplicate and unparseable SHA256SUMS lines", () => {
    const duplicated = completeSums() + completeSums();
    expect(() =>
      buildReleaseAttestation({
        identity: IDENTITY,
        sums: parseSha256Sums(duplicated),
        workflow: WORKFLOW,
        generatedAt: "2026-08-12T07:00:00.000Z",
      }),
    ).toThrow("duplicate asset names");
    expect(() => parseSha256Sums("not-a-hash  file.tgz\n")).toThrow("unparseable sha256sum line");
    expect(() => parseSha256Sums(`${"a".repeat(64)} single-space.tgz\n`)).toThrow(
      "unparseable sha256sum line",
    );
    expect(parseSha256Sums(`${"a".repeat(64)} *binary-marker.tgz\n`)).toEqual([
      { name: "binary-marker.tgz", sha256: "a".repeat(64) },
    ]);
  });

  it("re-validates identities that crossed the process boundary", () => {
    expect(() => parseReleaseIdentity({ ...IDENTITY, tag: "v9.9.9" })).toThrow(
      "does not match its version",
    );
    expect(() => parseReleaseIdentity({ ...IDENTITY, platformCommit: "main" })).toThrow(
      "lowercase full 40-hex platform commit",
    );
    expect(() => parseReleaseIdentity({ ...IDENTITY, extra: true })).toThrow("unknown property");
    expect(parseReleaseIdentity(structuredClone(IDENTITY))).toEqual(IDENTITY);
  });

  it("round-trips through the parser a downloaded attestation must pass", () => {
    const attestation = buildReleaseAttestation({
      identity: IDENTITY,
      sums: parseSha256Sums(completeSums()),
      workflow: WORKFLOW,
      generatedAt: "2026-08-12T07:00:00.000Z",
    });
    expect(parseReleaseAttestation(JSON.parse(JSON.stringify(attestation)))).toEqual(attestation);
  });

  it.each([
    [{ schemaVersion: 2 }, "$.schemaVersion"],
    [{ tag: "v1.4" }, "stable v<major>.<minor>.<patch> release tag"],
    [{ tag: "v9.9.9" }, "does not match the attested version"],
    [{ platformCommit: "d".repeat(39) }, "lowercase full 40-hex platform commit"],
    [{ simulatorImage: "ghcr.io/susumutomita/tenkacloud-simulator:v1.4.0" }, "sha256 digest"],
    [{ manifestSha256: "not-a-digest" }, "lowercase SHA-256 digest"],
    [{ status: "released" }, "expected one of candidate, certified"],
    [{ generatedAt: "2026-08-12" }, "RFC 3339 date-time"],
    [{ workflow: { repository: "susumutomita/TenkaCloud" } }, "required property is missing"],
    [{ extra: true }, "unknown property"],
  ])("rejects a downloaded attestation with %j", (overrides, message) => {
    const attestation = buildReleaseAttestation({
      identity: IDENTITY,
      sums: parseSha256Sums(completeSums()),
      workflow: WORKFLOW,
      generatedAt: "2026-08-12T07:00:00.000Z",
    });
    expect(() => parseReleaseAttestation({ ...attestation, ...overrides })).toThrow(
      message as string,
    );
  });

  it("requires the full workflow identity from the environment", () => {
    const env = {
      GITHUB_REPOSITORY: WORKFLOW.repository,
      GITHUB_RUN_ID: WORKFLOW.runId,
      GITHUB_RUN_ATTEMPT: WORKFLOW.runAttempt,
      GITHUB_WORKFLOW_REF: WORKFLOW.workflowRef,
    };
    expect(workflowIdentityFromEnv(env)).toEqual(WORKFLOW);
    expect(() => workflowIdentityFromEnv({ ...env, GITHUB_RUN_ID: "" })).toThrow(
      "$.env.GITHUB_RUN_ID",
    );
  });
});
