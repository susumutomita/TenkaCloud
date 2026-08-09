import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { renderReleaseReport, renderReleaseReportForCheck } from "./generate-release-report";
import {
  assertReleaseCheckEligible,
  parseReleaseManifest,
  readReleaseManifest,
  type VerificationResult,
} from "./manifest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const MANIFEST_PATH = join(REPO_ROOT, "release/tenkacloud-release.json");
const SCHEMA_PATH = join(REPO_ROOT, "release/tenkacloud-release.schema.json");
const REPORT_PATH = join(REPO_ROOT, "release/tenkacloud-release.md");
const GIT_BINARY = "/usr/bin/git";
const GIT_LOCAL_ENVIRONMENT = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const;

type UnknownRecord = Record<string, unknown>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function cloneManifestValue(): UnknownRecord {
  return structuredClone(readJson(MANIFEST_PATH)) as UnknownRecord;
}

function objectAt(record: UnknownRecord, key: string): UnknownRecord {
  return record[key] as UnknownRecord;
}

function evidenceBom(value: UnknownRecord): UnknownRecord {
  const sources = objectAt(value, "sources");
  return {
    releaseVersion: objectAt(value, "release").version,
    platformCommit: objectAt(sources, "platform").commit,
    catalogCommit: objectAt(sources, "catalog").commit,
    simulatorImage: objectAt(value, "artifacts").simulatorImage,
    toolchain: structuredClone(objectAt(value, "toolchain")),
  };
}

function goldenPathRun(
  value: UnknownRecord,
  result: VerificationResult,
  index: number,
): UnknownRecord {
  return {
    runId: `golden-${index + 1}`,
    mode: "lite",
    region: "ap-northeast-1",
    completedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    result,
    evidenceUrl: `https://github.com/susumutomita/TenkaCloud/actions/runs/${index + 1}`,
    evidenceSha256: (index + 1).toString(16).padStart(64, "0"),
    bom: evidenceBom(value),
    runner: {
      repository: "https://github.com/susumutomita/TenkaCloud.git",
      commit: "a".repeat(40),
    },
    freshEnvironment: {
      environmentId: `fresh-lite-${index + 1}`,
      decision: "passed",
      evidenceUrl: `https://evidence.tenkacloud.dev/fresh-environments/${index + 1}`,
      evidenceSha256: (index + 101).toString(16).padStart(64, "0"),
    },
    residualScan: {
      reportVersion: 1,
      runId: `golden-${index + 1}`,
      decision: result === "passed" ? "passed" : "failed",
      evidenceUrl: `https://evidence.tenkacloud.dev/residual-scans/${index + 1}`,
      evidenceSha256: (index + 201).toString(16).padStart(64, "0"),
    },
  };
}

function certifiedManifest(results: readonly VerificationResult[]): UnknownRecord {
  const value = cloneManifestValue();
  const release = objectAt(value, "release");
  release.status = "certified";
  release.version = "1.1.0";
  objectAt(value, "compatibility").supportedModes = [{ mode: "lite", regions: ["ap-northeast-1"] }];
  objectAt(value, "verification").goldenPathRuns = results.map((result, index) =>
    goldenPathRun(value, result, index),
  );
  objectAt(value, "knownLimitations").length = 0;
  return value;
}

function cleanGitEnvironment(ambientEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...ambientEnvironment };
  for (const name of GIT_LOCAL_ENVIRONMENT) Reflect.deleteProperty(env, name);
  return env;
}

function gitOutput(
  cwd: string,
  args: string[],
  ambientEnvironment: NodeJS.ProcessEnv = process.env,
): string {
  const env = cleanGitEnvironment(ambientEnvironment);
  return execFileSync(GIT_BINARY, args, { cwd, encoding: "utf8", env }).trim();
}

function platformBlob(commit: string, path: string): string {
  return gitOutput(REPO_ROOT, ["show", `${commit}:${path}`]);
}

function platformJson<T>(commit: string, path: string): T {
  return JSON.parse(platformBlob(commit, path)) as T;
}

function canonicalRepositoryUrl(url: string): string {
  const githubSsh = url.match(/^(?:ssh:\/\/)?git@github\.com[:/](.+)$/);
  const normalized = githubSsh ? `https://github.com/${githubSsh[1]}` : url;
  return normalized.replace(/\/$/, "").replace(/\.git$/, "");
}

function submoduleUrl(gitmodules: string, name: string): string | undefined {
  const block = gitmodules.match(
    new RegExp(`\\[submodule "${name}"\\]([\\s\\S]*?)(?=\\n\\[submodule |$)`),
  )?.[1];
  for (const line of block?.split("\n") ?? []) {
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== "url") continue;
    const value = line.slice(separator + 1).trim();
    if (value !== "" && !value.includes(" ")) return value;
  }
  return undefined;
}

function commitAvailable(cwd: string, commit: string): boolean {
  return (
    spawnSync(GIT_BINARY, ["cat-file", "-e", `${commit}^{commit}`], {
      cwd,
      stdio: "ignore",
      env: cleanGitEnvironment(process.env),
    }).status === 0
  );
}

function parameterDefault(template: string, name: string): string {
  const parameter = template.match(
    new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [A-Z][A-Za-z0-9]+:\\n|\\nConditions:)`),
  )?.[1];
  const value = parameter?.match(/^ {4}Default: ["']?([^"'\n]+)["']?$/m)?.[1];
  if (!value) throw new Error(`Could not read ${name} default from Lite launcher template`);
  return value;
}

function exportedString(source: string, name: string): string | undefined {
  const declaration = `export const ${name}`;
  const declarationStart = source.indexOf(declaration);
  if (declarationStart === -1) return undefined;
  const assignment = source.indexOf("=", declarationStart + declaration.length);
  if (assignment === -1) return undefined;
  const quoteStart = source.indexOf('"', assignment + 1);
  if (quoteStart === -1) return undefined;
  const quoteEnd = source.indexOf('"', quoteStart + 1);
  return quoteEnd === -1 ? undefined : source.slice(quoteStart + 1, quoteEnd);
}

describe("release manifest schema and parser", () => {
  it("accepts the committed candidate in both the public JSON Schema and semantic parser", () => {
    const schema = readJson(SCHEMA_PATH) as object;
    const value = readJson(MANIFEST_PATH);
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    const manifest = parseReleaseManifest(value);
    expect(manifest.release.status).toBe("candidate");
    expect(manifest.compatibility.qualificationTargets).toEqual([
      { mode: "lite", regions: ["ap-northeast-1"] },
    ]);
    expect(manifest.compatibility.supportedModes).toEqual([]);
    expect(manifest.verification.goldenPathRuns).toEqual([]);
  });

  it("rejects unknown fields instead of silently stripping them", () => {
    const value = cloneManifestValue();
    objectAt(objectAt(value, "sources"), "platform").branch = "main";
    expect(() => parseReleaseManifest(value)).toThrow("$.sources.platform.branch");
  });

  it.each([
    "main",
    "HEAD",
    "v1.1.0",
    "0732c74",
    "A".repeat(40),
  ])("rejects mutable, abbreviated, or non-canonical authoritative ref %s", (ref) => {
    const value = cloneManifestValue();
    objectAt(objectAt(value, "sources"), "platform").commit = ref;
    expect(() => parseReleaseManifest(value)).toThrow("lowercase full 40-hex commit");
  });

  it("requires the Simulator artifact to be digest-pinned", () => {
    const value = cloneManifestValue();
    objectAt(value, "artifacts").simulatorImage =
      "ghcr.io/susumutomita/tenkacloud-simulator:latest";
    expect(() => parseReleaseManifest(value)).toThrow("pinned by a lowercase sha256 digest");
  });

  it("does not let a candidate claim a supported mode", () => {
    const value = cloneManifestValue();
    objectAt(value, "compatibility").supportedModes = [
      { mode: "lite", regions: ["ap-northeast-1"] },
    ];
    expect(() => parseReleaseManifest(value)).toThrow(
      "a candidate release cannot claim certified support",
    );
  });

  it("requires candidate versions to be visibly distinct from a published release version", () => {
    const value = cloneManifestValue();
    objectAt(value, "release").version = "1.1.0";
    expect(() => parseReleaseManifest(value)).toThrow("explicit -candidate prerelease label");
  });

  it("lets a candidate retain partial and failed qualification evidence without claiming support", () => {
    const value = cloneManifestValue();
    objectAt(value, "verification").goldenPathRuns = [
      goldenPathRun(value, "passed", 0),
      goldenPathRun(value, "failed", 1),
    ];

    const manifest = parseReleaseManifest(value);
    expect(manifest.release.status).toBe("candidate");
    expect(manifest.compatibility.supportedModes).toEqual([]);
    expect(manifest.verification.goldenPathRuns.map(({ result }) => result)).toEqual([
      "passed",
      "failed",
    ]);
  });
});

describe("certification evidence", () => {
  it("keeps the public schema aligned with the semantic certified evidence shape", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(readJson(SCHEMA_PATH) as object);
    const value = certifiedManifest(["passed", "passed", "passed"]);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(parseReleaseManifest(value).release.status).toBe("certified");
  });

  it.each([0, 1, 2])("rejects certification with only %i successful run(s)", (count) => {
    const value = certifiedManifest(Array.from({ length: count }, () => "passed" as const));
    expect(() => parseReleaseManifest(value)).toThrow(/Golden Path evidence|at least three/);
  });

  it("accepts three consecutive passed runs even when evidence is not input chronologically", () => {
    const value = certifiedManifest(["passed", "passed", "passed"]);
    const verification = objectAt(value, "verification");
    verification.goldenPathRuns = (verification.goldenPathRuns as unknown[]).toReversed();
    expect(parseReleaseManifest(value).release.status).toBe("certified");
  });

  it("blocks certified publication until the #2982 artifact resolver authenticates evidence", () => {
    const manifest = parseReleaseManifest(certifiedManifest(["passed", "passed", "passed"]));
    expect(() => assertReleaseCheckEligible(manifest)).toThrow(
      "Certified publication is blocked until #2982",
    );
    expect(() => renderReleaseReportForCheck(manifest)).toThrow(
      "Certified publication is blocked until #2982",
    );
    expect(() => assertReleaseCheckEligible(readReleaseManifest())).not.toThrow();
  });

  it("allows an older failure after three newer consecutive passes", () => {
    expect(
      parseReleaseManifest(certifiedManifest(["failed", "passed", "passed", "passed"])).release
        .status,
    ).toBe("certified");
  });

  it("rejects pass-pass-pass-fail because a later failure breaks certification", () => {
    expect(() =>
      parseReleaseManifest(certifiedManifest(["passed", "passed", "passed", "failed"])),
    ).toThrow("latest three Golden Path runs");
  });

  it("rejects evidence for a mode/region that is not a qualification target", () => {
    const value = certifiedManifest(["passed", "passed", "passed"]);
    const runs = objectAt(value, "verification").goldenPathRuns as UnknownRecord[];
    runs[0].region = "us-east-1";
    expect(() => parseReleaseManifest(value)).toThrow(
      "does not reference a declared qualification target",
    );
  });

  it("rejects a run whose BOM differs from the exact top-level release BOM", () => {
    const value = certifiedManifest(["passed", "passed", "passed"]);
    const runs = objectAt(value, "verification").goldenPathRuns as UnknownRecord[];
    objectAt(runs[0], "bom").catalogCommit = "f".repeat(40);

    expect(() => parseReleaseManifest(value)).toThrow(
      "BOM does not exactly match the top-level release BOM",
    );
  });

  it("requires an immutable full-SHA verification runner identity", () => {
    const value = certifiedManifest(["passed", "passed", "passed"]);
    const runs = objectAt(value, "verification").goldenPathRuns as UnknownRecord[];
    objectAt(runs[0], "runner").commit = "main";
    expect(() => parseReleaseManifest(value)).toThrow("verification-runner commit");
  });

  it.each([
    "failed",
    "undecidable",
  ])("rejects certification when a latest residual scan is %s", (decision) => {
    const value = certifiedManifest(["passed", "passed", "passed"]);
    const runs = objectAt(value, "verification").goldenPathRuns as UnknownRecord[];
    objectAt(runs[2], "residualScan").decision = decision;
    expect(() => parseReleaseManifest(value)).toThrow("residual scanner report v1 decision passed");
  });

  it("rejects reusing one environment identity as three fresh starts", () => {
    const value = certifiedManifest(["passed", "passed", "passed"]);
    const runs = objectAt(value, "verification").goldenPathRuns as UnknownRecord[];
    objectAt(runs[1], "freshEnvironment").environmentId = objectAt(
      runs[0],
      "freshEnvironment",
    ).environmentId;
    expect(() => parseReleaseManifest(value)).toThrow("duplicate value");
  });

  it.each([
    "failed",
    "undecidable",
  ])("rejects certification when fresh-environment evidence is %s", (decision) => {
    const value = certifiedManifest(["passed", "passed", "passed"]);
    const runs = objectAt(value, "verification").goldenPathRuns as UnknownRecord[];
    objectAt(runs[2], "freshEnvironment").decision = decision;
    expect(() => parseReleaseManifest(value)).toThrow("fresh-environment evidence decision passed");
  });

  it.each([
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-01T24:00:00Z",
  ])("rejects nonexistent completion date %s", (completedAt) => {
    const value = certifiedManifest(["passed", "passed", "passed"]);
    const runs = objectAt(value, "verification").goldenPathRuns as UnknownRecord[];
    runs[0].completedAt = completedAt;
    expect(() => parseReleaseManifest(value)).toThrow("date-time is not a real calendar instant");
  });

  it("rejects a residual scanner report bound to another run", () => {
    const value = certifiedManifest(["passed", "passed", "passed"]);
    const runs = objectAt(value, "verification").goldenPathRuns as UnknownRecord[];
    objectAt(runs[1], "residualScan").runId = "golden-1";

    expect(() => parseReleaseManifest(value)).toThrow("residual scanner report refers to");
  });

  it("rejects reused evidence URLs or digests", () => {
    const value = certifiedManifest(["passed", "passed", "passed"]);
    const runs = objectAt(value, "verification").goldenPathRuns as UnknownRecord[];
    objectAt(runs[1], "residualScan").evidenceUrl = runs[0].evidenceUrl;

    expect(() => parseReleaseManifest(value)).toThrow("duplicate value");

    const reusedDigest = certifiedManifest(["passed", "passed", "passed"]);
    const digestRuns = objectAt(reusedDigest, "verification").goldenPathRuns as UnknownRecord[];
    objectAt(digestRuns[1], "freshEnvironment").evidenceSha256 = digestRuns[0].evidenceSha256;
    expect(() => parseReleaseManifest(reusedDigest)).toThrow("duplicate value");
  });
});

describe("release source parity and generated report", () => {
  const manifest = readReleaseManifest();
  const launcher = readFileSync(
    join(REPO_ROOT, "infrastructure/templates/lite-pipeline.yaml"),
    "utf8",
  );

  it("verifies both declared repositories, display tags, and exact source objects", () => {
    const gitlink = gitOutput(REPO_ROOT, [
      "ls-tree",
      manifest.sources.platform.commit,
      "problems",
    ]).split(/\s+/)[2];
    expect(gitlink).toBe(manifest.sources.catalog.commit);

    expect(canonicalRepositoryUrl(parameterDefault(launcher, "RepoUrl"))).toBe(
      canonicalRepositoryUrl(manifest.sources.platform.repository),
    );
    expect(canonicalRepositoryUrl(parameterDefault(launcher, "ProblemsRepoUrl"))).toBe(
      canonicalRepositoryUrl(manifest.sources.catalog.repository),
    );
    expect(canonicalRepositoryUrl(gitOutput(REPO_ROOT, ["remote", "get-url", "origin"]))).toBe(
      canonicalRepositoryUrl(manifest.sources.platform.repository),
    );
    expect(
      canonicalRepositoryUrl(
        gitOutput(join(REPO_ROOT, "problems"), ["remote", "get-url", "origin"]),
      ),
    ).toBe(canonicalRepositoryUrl(manifest.sources.catalog.repository));
    const parentGitDir = gitOutput(REPO_ROOT, ["rev-parse", "--absolute-git-dir"]);
    expect(
      canonicalRepositoryUrl(
        gitOutput(join(REPO_ROOT, "problems"), ["remote", "get-url", "origin"], {
          ...process.env,
          GIT_DIR: parentGitDir,
        }),
      ),
    ).toBe(canonicalRepositoryUrl(manifest.sources.catalog.repository));
    const pinnedCatalogRepository = submoduleUrl(
      platformBlob(manifest.sources.platform.commit, ".gitmodules"),
      "problems",
    );
    expect(pinnedCatalogRepository).toBeDefined();
    expect(canonicalRepositoryUrl(pinnedCatalogRepository as string)).toBe(
      canonicalRepositoryUrl(manifest.sources.catalog.repository),
    );

    if (manifest.sources.platform.tag) {
      expect(
        gitOutput(REPO_ROOT, [
          "rev-parse",
          "--verify",
          `refs/tags/${manifest.sources.platform.tag}^{commit}`,
        ]),
      ).toBe(manifest.sources.platform.commit);
    }
    expect(commitAvailable(join(REPO_ROOT, "problems"), manifest.sources.catalog.commit)).toBe(
      true,
    );
    expect(commitAvailable(join(REPO_ROOT, "problems"), "f".repeat(40))).toBe(false);
    if (manifest.sources.catalog.tag) {
      expect(
        gitOutput(join(REPO_ROOT, "problems"), [
          "rev-parse",
          "--verify",
          `refs/tags/${manifest.sources.catalog.tag}^{commit}`,
        ]),
      ).toBe(manifest.sources.catalog.commit);
    }
  });

  it("reads Simulator, release version, and toolchain from the pinned platform commit", () => {
    const commit = manifest.sources.platform.commit;
    const mise = platformBlob(commit, "mise.toml");
    const rootPackage = platformJson<{
      version: string;
      packageManager: string;
      engines: { node: string };
    }>(commit, "package.json");
    const infrastructurePackage = platformJson<{
      devDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    }>(commit, "infrastructure/package.json");
    const simulatorSource = platformBlob(commit, "scripts/local-play/simulator-launch-state.ts");
    const simulatorImage = exportedString(simulatorSource, "DEFAULT_SIMULATOR_IMAGE");
    if (!simulatorImage) throw new Error("Could not read DEFAULT_SIMULATOR_IMAGE");

    expect(manifest.release.version.match(/^\d+\.\d+\.\d+/)?.[0]).toBe(rootPackage.version);
    expect(manifest.artifacts.simulatorImage).toBe(simulatorImage);
    expect(mise).toContain(`bun = "${manifest.toolchain.bun}"`);
    expect(mise).toContain(`node = "${manifest.toolchain.node.development}"`);
    expect(rootPackage.packageManager).toBe(`bun@${manifest.toolchain.bun}`);
    expect(rootPackage.engines.node).toBe(`>=${manifest.toolchain.node.development}`);
    expect(parameterDefault(launcher, "BunVersion")).toBe(manifest.toolchain.bun);
    expect(launcher).toContain(`nodejs: ${manifest.toolchain.node.launcher}`);
    expect(infrastructurePackage.devDependencies["aws-cdk"]).toBe(manifest.toolchain.awsCdk.cli);
    expect(infrastructurePackage.dependencies["aws-cdk-lib"]).toBe(
      manifest.toolchain.awsCdk.library,
    );
  });

  it("keeps the parity seam historical instead of silently reading current HEAD", () => {
    const historical = platformJson<{
      devDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    }>("31f0262ee2cda8aa84eb179307042e5fcc06b1b1", "infrastructure/package.json");
    const current = readJson(join(REPO_ROOT, "infrastructure/package.json")) as {
      devDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };

    expect(historical.devDependencies["aws-cdk"]).toBe("2.1122.0");
    expect(historical.devDependencies["aws-cdk"]).not.toBe(current.devDependencies["aws-cdk"]);
    expect(historical.dependencies["aws-cdk-lib"]).not.toBe(current.dependencies["aws-cdk-lib"]);
  });

  it("matches launcher refs and named subsystem contract versions", () => {
    const commit = manifest.sources.platform.commit;
    const migrations = gitOutput(REPO_ROOT, [
      "ls-tree",
      "-r",
      "--name-only",
      commit,
      "--",
      "apps/always-on-control-plane/migrations",
    ])
      .split("\n")
      .filter((file) => file.endsWith(".sql"))
      .toSorted();
    const packSchemaSource = platformBlob(commit, "packages/problem-sdk/src/manifest.ts");
    const packSchemaVersion = packSchemaSource.match(
      /export const PACK_SCHEMA_VERSION = (\d+) as const/,
    )?.[1];
    const contracts = Object.fromEntries(
      manifest.compatibility.contracts.map(({ id, version }) => [id, version]),
    );
    const latestMigration = migrations.at(-1);
    if (!latestMigration) throw new Error("No Always-On D1 migrations found");
    const latestMigrationVersion = latestMigration
      .split("/")
      .at(-1)
      ?.replace(/\.sql$/, "");
    if (!latestMigrationVersion) throw new Error("Could not derive latest Always-On migration");

    expect(parameterDefault(launcher, "RepoRef")).toBe(manifest.sources.platform.commit);
    expect(parameterDefault(launcher, "ProblemsRepoRef")).toBe(manifest.sources.catalog.commit);
    expect(packSchemaVersion).toBeDefined();
    expect(contracts["problem-pack-manifest"]).toBe(packSchemaVersion);
    expect(contracts["always-on-control-plane-d1-migration"]).toBe(latestMigrationVersion);
  });

  it("keeps the committed human report byte-identical to the manifest", () => {
    expect(readFileSync(REPORT_PATH, "utf8")).toBe(renderReleaseReport(manifest));
  });

  it("keeps README, operator docs, and release notes pointed at the manifest report", () => {
    const publicSurfaces = [
      ["README.md", "./release/tenkacloud-release.json", "./release/tenkacloud-release.md"],
      ["README.ja.md", "./release/tenkacloud-release.json", "./release/tenkacloud-release.md"],
      [
        "infrastructure/templates/README.md",
        "../../release/tenkacloud-release.json",
        "../../release/tenkacloud-release.md",
      ],
      ["docs/operations/event-runbook.md", "../../release/tenkacloud-release.md"],
      [
        "apps/developer-portal/src/app/developers/changelog/page.tsx",
        "release/tenkacloud-release.md",
        "candidate remains unverified",
        "current release report",
      ],
    ] as const;

    for (const [path, ...requiredText] of publicSurfaces) {
      const content = readFileSync(join(REPO_ROOT, path), "utf8");
      for (const text of requiredText) expect(content, path).toContain(text);
    }
  });
});
