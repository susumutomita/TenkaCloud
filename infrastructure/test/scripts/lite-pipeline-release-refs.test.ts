import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const releaseManifest = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "release", "tenkacloud-release.json"), "utf8"),
) as {
  release: { version: string };
  sources: { platform: { commit: string }; catalog: { commit: string } };
};
const PLATFORM_CANDIDATE_SHA = releaseManifest.sources.platform.commit;
const CATALOG_CANDIDATE_SHA = releaseManifest.sources.catalog.commit;
const FIXTURE_TAG = "v-fixture";
const GIT_BINARY = "/usr/bin/git";
const BASH_BINARY = "/bin/bash";
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

const template = readFileSync(
  join(__dirname, "..", "..", "templates", "lite-pipeline.yaml"),
  "utf8",
);

function parameterBlock(name: string): string {
  const block = template.match(
    new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[A-Za-z][A-Za-z0-9]*:\\n|\\nConditions:)`),
  )?.[1];
  if (!block) throw new Error(`parameter block ${name} not found`);
  return block;
}

/** Extracts the first install-phase literal command from the embedded buildspec. */
function checkoutScript(): string {
  const block = template.match(/ {16}- \|\n([\s\S]*?)\n {16}- cd repo\n/)?.[1];
  if (!block) throw new Error("Lite checkout command block not found");
  return block.replace(/^ {18}/gm, "");
}

interface FixtureRepo {
  readonly url: string;
  readonly sha: string;
}

function cleanGitEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  ambientEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...ambientEnvironment, ...overrides };
  for (const name of GIT_LOCAL_ENVIRONMENT) Reflect.deleteProperty(env, name);
  return env;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync(GIT_BINARY, args, {
    cwd,
    encoding: "utf8",
    env: cleanGitEnvironment(),
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status ?? "signal"}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function createFixtureRepo(root: string, name: string): FixtureRepo {
  const path = join(root, name);
  mkdirSync(path);
  runGit(path, ["init", "--initial-branch=main"]);
  runGit(path, ["config", "user.name", "TenkaCloud launcher test"]);
  runGit(path, ["config", "user.email", "launcher-test@example.invalid"]);
  writeFileSync(join(path, `${name}.txt`), `${name}\n`);
  runGit(path, ["add", "."]);
  runGit(path, ["commit", "-m", `${name} fixture`]);
  runGit(path, ["tag", FIXTURE_TAG]);
  return {
    url: `file://${path}`,
    sha: runGit(path, ["rev-parse", "HEAD"]),
  };
}

function withFixtureRepos(
  assertion: (root: string, platform: FixtureRepo, catalog: FixtureRepo) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "tenkacloud-lite-release-refs-"));
  try {
    assertion(root, createFixtureRepo(root, "platform"), createFixtureRepo(root, "catalog"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCheckout(
  root: string,
  platform: FixtureRepo,
  catalog: FixtureRepo,
  platformRef: string,
  catalogRef: string,
) {
  const workDir = join(root, "checkout");
  mkdirSync(workDir);
  return {
    workDir,
    result: spawnSync(BASH_BINARY, ["-eu", "-o", "pipefail", "-c", checkoutScript()], {
      cwd: workDir,
      encoding: "utf8",
      env: cleanGitEnvironment({
        REPO_URL: platform.url,
        REPO_REF: platformRef,
        PROBLEMS_REPO_URL: catalog.url,
        PROBLEMS_REPO_REF: catalogRef,
      }),
    }),
  };
}

function combinedOutput(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

describe("Lite launcher immutable release refs", () => {
  it("isolates fixture repositories from a parent Git hook environment", () => {
    const env = cleanGitEnvironment({}, { ...process.env, GIT_DIR: "/parent/repository/.git" });
    expect(env.GIT_DIR).toBeUndefined();
  });

  it("defaults the platform and catalog to the exact candidate commit pair", () => {
    expect(parameterBlock("RepoRef")).toContain(`Default: ${PLATFORM_CANDIDATE_SHA}`);
    expect(parameterBlock("ProblemsRepoRef")).toContain(`Default: ${CATALOG_CANDIDATE_SHA}`);
  });

  it("explains every release classification in both visible ref descriptions", () => {
    for (const name of ["RepoRef", "ProblemsRepoRef"]) {
      const block = parameterBlock(name);
      expect(block).toContain("candidate/unverified");
      expect(block).toContain("development/unreleased");
      expect(block).toContain("custom/unverified");
      expect(block).toContain("main");
    }
  });

  it("exposes the manifest version as the baseline before classifying selected refs", () => {
    const script = checkoutScript();
    expect(template).toMatch(
      new RegExp(`ReleaseManifestVersion:[\\s\\S]*?Value: ${releaseManifest.release.version}`),
    );
    expect(script).toContain(
      `Release manifest version: ${releaseManifest.release.version} (baseline for the exact candidate ref pair)`,
    );
    expect(script.indexOf("Release manifest version:")).toBeLessThan(
      script.indexOf('release_classification="development/unreleased"'),
    );
  });

  it("classifies main before the exact candidate pair and exposes the result as an output", () => {
    const conditions = template.match(/\nConditions:\n([\s\S]*?)\nResources:\n/)?.[1];
    const output = template.match(
      /\n {2}ReleaseClassification:\n([\s\S]*?)\n {2}CodeBuildProjectName:\n/,
    )?.[1];

    expect(conditions).toContain("UsesAnyMainRef: !Or");
    expect(conditions).toContain("!Equals [!Ref RepoRef, main]");
    expect(conditions).toContain("!Equals [!Ref ProblemsRepoRef, main]");
    expect(conditions).toContain(`!Equals [!Ref RepoRef, ${PLATFORM_CANDIDATE_SHA}]`);
    expect(conditions).toContain(`!Equals [!Ref ProblemsRepoRef, ${CATALOG_CANDIDATE_SHA}]`);
    expect(output).toContain("development/unreleased");
    expect(output).toContain("candidate/unverified");
    expect(output).toContain("custom/unverified");
    expect(output).toMatch(
      /Value: !If\s+- UsesAnyMainRef\s+- development\/unreleased\s+- !If \[UsesCandidateReleasePair, candidate\/unverified, custom\/unverified\]/,
    );
  });

  it("prints the same three-way classification before checkout", () => {
    const script = checkoutScript();
    const mainAt = script.indexOf('release_classification="development/unreleased"');
    const candidateAt = script.indexOf('release_classification="candidate/unverified"');
    const customAt = script.indexOf('release_classification="custom/unverified"');
    const checkoutAt = script.indexOf("checkout_repo_ref() {");

    expect(mainAt).toBeGreaterThan(-1);
    expect(candidateAt).toBeGreaterThan(mainAt);
    expect(customAt).toBeGreaterThan(candidateAt);
    expect(checkoutAt).toBeGreaterThan(customAt);
    expect(script).toContain(
      `elif [ "\${REPO_REF}" = "${PLATFORM_CANDIDATE_SHA}" ] && [ "\${PROBLEMS_REPO_REF}" = "${CATALOG_CANDIDATE_SHA}" ]; then`,
    );
    expect(script).toContain(`echo "Release classification: \${release_classification}"`);
  });

  it("routes a full 40-hex SHA through verified fetch, never git clone --branch", () => {
    const script = checkoutScript();
    expect(script).toContain("grep -Eq '^[0-9a-fA-F]{40}$'");
    expect(script).toContain(
      `git -C "\${checkout_destination}" fetch --depth 1 origin "\${checkout_requested_ref}"`,
    );
    expect(script).toContain("rev-parse --verify 'FETCH_HEAD^{commit}'");
    expect(script).toContain(`if [ "\${checkout_resolved_ref}" != "\${checkout_normalized_ref}" ]`);
    expect(script).not.toContain(`git clone --depth 1 --branch "\${REPO_REF}"`);
    expect(script).not.toContain(`git clone --depth 1 --branch "\${PROBLEMS_REPO_REF}"`);
  });

  it.each([
    ["branch", "main", "development/unreleased"],
    ["tag", FIXTURE_TAG, "custom/unverified"],
  ])("checks out a %s ref for both repositories", (_kind, ref, classification) => {
    withFixtureRepos((root, platform, catalog) => {
      const { result, workDir } = runCheckout(root, platform, catalog, ref, ref);
      expect(combinedOutput(result)).toContain(`Release classification: ${classification}`);
      expect(result.status, combinedOutput(result)).toBe(0);
      expect(runGit(join(workDir, "repo"), ["rev-parse", "HEAD"])).toBe(platform.sha);
      expect(runGit(join(workDir, "repo", "problems"), ["rev-parse", "HEAD"])).toBe(catalog.sha);
    });
  });

  it("fixes the old git clone --branch SHA failure seam with detached verified checkouts", () => {
    withFixtureRepos((root, platform, catalog) => {
      const legacy = spawnSync(
        GIT_BINARY,
        [
          "clone",
          "--depth",
          "1",
          "--branch",
          platform.sha,
          platform.url,
          join(root, "legacy-sha-clone"),
        ],
        { encoding: "utf8", env: cleanGitEnvironment() },
      );
      expect(legacy.status).not.toBe(0);
      expect(combinedOutput(legacy)).toMatch(/Remote branch .* not found|not a commit/);

      const { result, workDir } = runCheckout(root, platform, catalog, platform.sha, catalog.sha);
      expect(result.status, combinedOutput(result)).toBe(0);
      expect(runGit(join(workDir, "repo"), ["rev-parse", "HEAD"])).toBe(platform.sha);
      expect(runGit(join(workDir, "repo", "problems"), ["rev-parse", "HEAD"])).toBe(catalog.sha);
    });
  });

  it("fails closed when a requested 40-hex commit cannot be fetched", () => {
    withFixtureRepos((root, platform, catalog) => {
      const missingSha = "f".repeat(40);
      const { result } = runCheckout(root, platform, catalog, missingSha, catalog.sha);
      expect(result.status).not.toBe(0);
      expect(combinedOutput(result)).toContain(
        `Failed to fetch platform commit ${missingSha}; refusing to fall back to another ref.`,
      );
    });
  });
});
