import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLocalHost } from "../application";
import { runManagedLocal } from "../local";
import { readSimulatorToken } from "../simulator-hosting";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "tc-simulator-startup-"));
  directories.push(path);
  return path;
}

function withoutProxy() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(http|https|all)_proxy$/iu.test(key)),
  );
}

const endpoint = "http://127.0.0.1:4566";
function flags(tokenFile: string) {
  return [
    "--simulator-endpoint",
    endpoint,
    "--simulator-token-file",
    tokenFile,
    "--simulator-region",
    "ap-northeast-1",
  ];
}

test("a missing token explains the host-relative path instead of claiming unsafe permissions", () => {
  const missing = join(directory(), "synthetic-private-path");
  expect(() => readSimulatorToken(missing)).toThrow("Simulator token file was not found");
  expect(() => readSimulatorToken(missing)).toThrow("relative to the host working directory");
  expect(() => readSimulatorToken(missing)).not.toThrow("synthetic-private-path");
});

test("wrong relative token path fails before catalog acquisition; the sibling's absolute path passes", () => {
  const root = directory();
  const host = join(root, "TenkaCloud");
  const simulator = join(root, "TenkaCloudSimulator");
  mkdirSync(host);
  mkdirSync(simulator);
  const tokenFile = join(simulator, "simulator-token");
  const syntheticToken = "synthetic-private-token-".repeat(3);
  writeFileSync(tokenFile, `${syntheticToken}\n`, { mode: 0o600 });
  const command = fileURLToPath(new URL("../local.ts", import.meta.url));
  const invoke = (path: string) => {
    const result = Bun.spawnSync([process.execPath, command, "start", ...flags(path)], {
      cwd: host,
      // Never inherit CI's selected catalog: valid credentials must reach a deterministic
      // local import failure, without downloading or starting a real host.
      env: { ...withoutProxy(), CATALOG_SOURCES: join(host, "missing-catalog-sources.json") },
    });
    expect(result.exitCode).toBe(1);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output).not.toContain(syntheticToken);
    expect(existsSync(join(host, "simulator-token"))).toBe(false);
    expect(existsSync(join(host, ".tenkacloud"))).toBe(false);
    return output;
  };
  expect(invoke("./simulator-token")).toContain("Simulator token file was not found");
  expect(invoke(tokenFile)).toContain("Catalog import failed; startup/build stopped.");
  expect(readSimulatorToken(tokenFile)).toBe(syntheticToken);
});

for (const noBuild of [[], ["--no-build"]]) {
  test(`invalid token stops the launcher and direct host before catalog/build/state ${noBuild.join(" ")}`, async () => {
    const root = directory();
    const tokenFile = join(root, "simulator-token");
    writeFileSync(tokenFile, "x".repeat(64), { mode: 0o600 });
    chmodSync(tokenFile, 0o644);
    const args = [...flags(tokenFile), ...noBuild];
    const saved = { ...process.env };
    try {
      process.env = withoutProxy();
      await expect(runManagedLocal(root, args)).rejects.toThrow("owner-only");
      await expect(runLocalHost(args, { repositoryRoot: root })).rejects.toThrow("owner-only");
      expect(existsSync(join(root, ".tenkacloud"))).toBe(false);
    } finally {
      process.env = saved;
    }
  });
}

test("simulator help never requires a token file", async () => {
  const root = directory();
  const args = [...flags(join(root, "missing")), "--help"];
  await expect(runManagedLocal(root, args)).resolves.toBe(0);
  expect(existsSync(join(root, ".tenkacloud"))).toBe(false);
});
