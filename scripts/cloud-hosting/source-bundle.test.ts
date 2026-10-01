import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseBundleEnvironment } from "./cli";

const directories: string[] = [];
const script = resolve(import.meta.dirname, "package-source-bundle.sh");
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cloud-source-bundle-"));
  directories.push(root);
  function file(path: string, content = "fixture") {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  for (const path of [
    "infrastructure/lib/source.ts",
    "scripts/deploy-battles.sh",
    "problems/aws/example/metadata.json",
    "packages/example/src/index.ts",
    "apps/application-admin-console/dist/index.html",
    "apps/participant-portal/dist/index.html",
    ".nvmrc",
  ])
    file(path);
  file("package.json", JSON.stringify({ workspaces: ["infrastructure", "apps/*", "packages/*"] }));
  return { root, file, work: join(root, ".cache", "source-bundle") };
}
function pack(root: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      SOURCE_BUNDLE_ROOT: root,
      SOURCE_BUNDLE_WORK_DIR: join(root, ".cache", "source-bundle"),
      ...extra,
    },
  });
}

describe("restored cloud source-bundle contract using temporary synthetic files", () => {
  it("packages only deployment inputs and both SPAs, excluding secrets and generated dependencies", () => {
    const f = fixture();
    f.file("scripts/.env", "must-not-ship");
    f.file("scripts/.env.local", "must-not-ship");
    f.file("packages/example/node_modules/secret.txt", "must-not-ship");
    f.file("infrastructure/cdk.out/secret.txt", "must-not-ship");
    f.file("unrelated-private/data.txt", "must-not-ship");
    const result = pack(f.root);
    expect(result.status).toBe(0);
    const archive = join(f.work, "source.zip");
    const listing = spawnSync("/usr/bin/unzip", ["-Z1", archive], { encoding: "utf8" });
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain("cdk/lib/source.ts");
    expect(listing.stdout).toContain("problems/aws/example/metadata.json");
    expect(listing.stdout).toContain("apps/application-admin-console/dist/index.html");
    expect(listing.stdout).toContain("apps/participant-portal/dist/index.html");
    expect(listing.stdout).not.toContain("apps/admin-console/");
    expect(listing.stdout).not.toContain(".env");
    expect(listing.stdout).not.toContain("node_modules");
    expect(listing.stdout).not.toContain("secret.txt");
    expect(listing.stdout).not.toContain("unrelated-private");
    const manifest = JSON.parse(readFileSync(join(f.work, "staging/package.json"), "utf8")) as {
      workspaces: string[];
    };
    expect(manifest.workspaces).toEqual(["cdk", "apps/*", "packages/*"]);
  });
  it("fails instead of shipping a missing catalog or unbuilt frontend", () => {
    const f = fixture();
    rmSync(join(f.root, "problems"), { recursive: true, force: true });
    mkdirSync(join(f.root, "problems"));
    expect(pack(f.root).status).not.toBe(0);
    f.file("problems/aws/example/metadata.json");
    rmSync(join(f.root, "apps/participant-portal/dist"), { recursive: true, force: true });
    expect(pack(f.root).status).not.toBe(0);
  });
  it("resolves environment-isolated source identity without issuing AWS commands", () => {
    const result = spawnSync(
      "/bin/bash",
      [resolve(import.meta.dirname, "prepare-source-bundle.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY: "1",
          REGION: "us-east-1",
          ACCOUNT_ID: "123456789012",
          ENV: "test",
        },
      },
    );
    expect(result.status).toBe(0);
    const resolved = parseBundleEnvironment(result.stdout);
    expect(resolved.CDK_PARAM_S3_BUCKET_NAME).toMatch(
      /^tenkacloud-source-123456789012-us-east-1-[a-f0-9]{8}$/u,
    );
  });
  it("never cleans an arbitrary existing directory or adopts an unmarked nonempty cache", () => {
    const f = fixture();
    const unrelated = join(f.root, "private-work");
    f.file("private-work/keep.txt", "private fixture");
    expect(pack(f.root, { SOURCE_BUNDLE_WORK_DIR: unrelated }).status).not.toBe(0);
    expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("private fixture");
    f.file(".cache/source-bundle/keep.txt", "unowned fixture");
    expect(pack(f.root).status).not.toBe(0);
    expect(readFileSync(join(f.work, "keep.txt"), "utf8")).toBe("unowned fixture");
  });
  it.each(["problems/aws/example/escape.txt", "apps/participant-portal/dist/escape.txt"])(
    "rejects outside-root synthetic secret symlinks before archiving: %s",
    (path) => {
      const f = fixture();
      const outside = mkdtempSync(join(tmpdir(), "cloud-outside-secret-"));
      directories.push(outside);
      const secret = join(outside, "secret.txt");
      writeFileSync(secret, "SYNTHETIC-SECRET-NOT-REAL");
      symlinkSync(secret, join(f.root, path));
      const result = pack(f.root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("symlinks are not supported");
      expect(existsSync(join(f.work, "source.zip"))).toBe(false);
    },
  );
  it("can refresh only its marked directory and preserves the marker", () => {
    const f = fixture();
    expect(pack(f.root).status).toBe(0);
    expect(pack(f.root).status).toBe(0);
    expect(readFileSync(join(f.work, ".tenkacloud-bundle-owner"), "utf8")).toContain(f.root);
  });
  it("rejects unsafe work paths before deleting anything", () => {
    const f = fixture();
    expect(pack(f.root, { SOURCE_BUNDLE_WORK_DIR: f.root }).status).not.toBe(0);
    expect(pack(f.root, { SOURCE_BUNDLE_WORK_DIR: "/" }).status).not.toBe(0);
    expect(pack(f.root, { SOURCE_BUNDLE_WORK_DIR: `${f.root}/.` }).status).not.toBe(0);
    expect(readFileSync(join(f.root, "package.json"), "utf8")).toContain("workspaces");
  });
});
