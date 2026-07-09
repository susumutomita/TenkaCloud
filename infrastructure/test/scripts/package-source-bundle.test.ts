import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_SCRIPT = resolve(__dirname, "..", "..", "..", "scripts", "package-source-bundle.sh");
const tempDirs: string[] = [];

function write(root: string, path: string, contents = path): void {
  const target = join(root, path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

function makeFixture(): { root: string; workDir: string } {
  const root = mkdtempSync(join(tmpdir(), "tenkacloud-source-bundle-"));
  tempDirs.push(root);
  const workDir = join(root, ".cache", "bundle-test");
  write(root, ".nvmrc", "24\n");
  write(
    root,
    "package.json",
    JSON.stringify({ name: "fixture", workspaces: ["infrastructure", "packages/*"] }),
  );
  write(root, "infrastructure/lib/index.ts");
  write(root, "infrastructure/cdk.out.test/worker/large-generated-file");
  write(root, "infrastructure/coverage/lcov.info");
  write(root, "scripts/runtime.sh");
  write(root, "problems/challenges/demo/metadata.json", "{}");
  write(root, "packages/runtime/src/index.ts");
  write(root, "apps/application-admin-console/dist/index.html");
  write(root, "apps/participant-portal/dist/index.html");
  write(root, "unknown-generated-root/should-not-ship.txt");
  return { root, workDir };
}

// [Problem Packs / #2459 gap 2] Mirrors the real `.tenkacloud/pack-store` layout
// (#2090 install / #2462 activation): a lock file, an activation file, and one
// immutable snapshot tree under `snapshots/<packId>/<version>/...`. Also seeds
// unrelated `.tenkacloud/local/` (Docker local-play, scripts/tenkacloud-local.ts)
// so the "only pack-store ships" scoping decision is pinned by a test, not just
// a comment.
function writePackStoreFixture(root: string): void {
  write(root, ".tenkacloud/pack-store/packs-lock.json", JSON.stringify({ packs: [] }));
  write(root, ".tenkacloud/pack-store/pack-activations.json", JSON.stringify({ tenants: {} }));
  write(
    root,
    ".tenkacloud/pack-store/snapshots/com.example.demo-pack/1.0.0/problems/challenges/demo-pack/metadata.json",
    "{}",
  );
  write(root, ".tenkacloud/local/deployment.json", JSON.stringify({ problemId: "demo" }));
}

function packageFixture(
  root: string,
  workDir: string,
  env: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [PACKAGE_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      SOURCE_BUNDLE_ROOT: root,
      SOURCE_BUNDLE_WORK_DIR: workDir,
      ...env,
    },
  });
}

function listArchive(archive: string): string[] {
  const result = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim().split("\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("scripts/package-source-bundle.sh (#1552)", () => {
  // bash + zip を spawn する実 I/O テスト。単体では ~2s だが全 suite 並列時は
  // fork 飽和で default 5s を超え flake するため、明示 timeout を持つ。
  it("should package allowlisted source roots without AWS credentials", { timeout: 30_000 }, () => {
    const { root, workDir } = makeFixture();

    const result = packageFixture(root, workDir, {
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
    });

    expect(result.status, result.stderr).toBe(0);
    const archive = join(workDir, "source.zip");
    expect(existsSync(archive)).toBe(true);
    const files = listArchive(archive);
    expect(files).toContain("cdk/lib/index.ts");
    expect(files).toContain("scripts/runtime.sh");
    expect(files).toContain("problems/challenges/demo/metadata.json");
    expect(files).toContain("packages/runtime/src/index.ts");
    expect(files).toContain("apps/application-admin-console/dist/index.html");
    expect(files).toContain("apps/participant-portal/dist/index.html");
    expect(files.some((file) => file.includes("cdk.out"))).toBe(false);
    expect(files.some((file) => file.includes("coverage"))).toBe(false);
    expect(files.some((file) => file.includes("unknown-generated-root"))).toBe(false);
    // No `.tenkacloud/pack-store` on disk (packs are optional) → bundle unchanged.
    expect(files.some((file) => file.includes(".tenkacloud"))).toBe(false);

    const packageJson = spawnSync("unzip", ["-p", archive, "package.json"], {
      encoding: "utf8",
    });
    expect(packageJson.status).toBe(0);
    expect(JSON.parse(packageJson.stdout).workspaces).toEqual(["cdk", "packages/*"]);
  });

  it("should include .tenkacloud/pack-store in the bundle when installed packs exist", () => {
    const { root, workDir } = makeFixture();
    writePackStoreFixture(root);

    const result = packageFixture(root, workDir, {
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
    });

    expect(result.status, result.stderr).toBe(0);
    const archive = join(workDir, "source.zip");
    const files = listArchive(archive);
    expect(files).toContain(".tenkacloud/pack-store/packs-lock.json");
    expect(files).toContain(".tenkacloud/pack-store/pack-activations.json");
    expect(files).toContain(
      ".tenkacloud/pack-store/snapshots/com.example.demo-pack/1.0.0/problems/challenges/demo-pack/metadata.json",
    );
    // `.tenkacloud/local/` (Docker local-play state) is a different feature and
    // must not ride along — only `pack-store` is in the copy allowlist.
    expect(files.some((file) => file.startsWith(".tenkacloud/local"))).toBe(false);
  });

  it("should build the bundle without .tenkacloud when no pack store is installed", () => {
    const { root, workDir } = makeFixture();
    // No .tenkacloud/ directory at all — the common case for a fresh checkout
    // that never ran `pack-cli install` / `activate`.
    expect(existsSync(join(root, ".tenkacloud"))).toBe(false);

    const result = packageFixture(root, workDir, {
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "no .tenkacloud/pack-store found, skipping",
    );
    const files = listArchive(join(workDir, "source.zip"));
    expect(files.some((file) => file.includes(".tenkacloud"))).toBe(false);
  });

  it("should fail loudly when the problems catalog submodule is not checked out", () => {
    const { root, workDir } = makeFixture();
    // Simulate an uninitialised `problems` submodule: the mount point exists but
    // is empty. Without a guard this ships an empty catalog and every per-team
    // deploy later aborts at deploy-battles.sh's "template not found" check
    // BEFORE any CloudFormation request (the "deploy never reaches CFn" regression).
    rmSync(join(root, "problems"), { force: true, recursive: true });
    mkdirSync(join(root, "problems"), { recursive: true });

    const result = packageFixture(root, workDir);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "problem catalog submodule is not checked out",
    );
    expect(existsSync(join(workDir, "source.zip"))).toBe(false);
  });

  it("should fail before archiving when staged files exceed the configured limit", () => {
    const { root, workDir } = makeFixture();
    writeFileSync(join(root, "infrastructure", "lib", "large.bin"), Buffer.alloc(2 * 1024 * 1024));

    const result = packageFixture(root, workDir, {
      SOURCE_BUNDLE_MAX_STAGING_MB: "1",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("staged bundle exceeds limit");
    expect(existsSync(join(workDir, "source.zip"))).toBe(false);
  });

  it("should fail before upload when the archive exceeds the configured limit", () => {
    const { root, workDir } = makeFixture();
    writeFileSync(join(root, "infrastructure", "lib", "large.bin"), randomBytes(2 * 1024 * 1024));

    const result = packageFixture(root, workDir, {
      SOURCE_BUNDLE_MAX_ARCHIVE_MB: "1",
      SOURCE_BUNDLE_MAX_STAGING_MB: "4",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("archive exceeds upload limit");
  });

  it("should reject archive paths outside the cleaned work directory", () => {
    const { root, workDir } = makeFixture();

    const result = packageFixture(root, workDir, {
      SOURCE_BUNDLE_ARCHIVE_PATH: join(root, "outside.zip"),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "archive path must stay inside work directory",
    );
    expect(existsSync(join(root, "outside.zip"))).toBe(false);
  });
});
