import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBattleRuntime, releaseBattleRuntime } from "../simulator-battle-runtime";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const platform = {
  os: process.platform,
  arch: process.arch === "x64" ? "amd64" : process.arch,
};

function bundle(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tc-bundle-"));
  cleanup.push(directory);
  const manifest = {
    ...platform,
    archiveSha256: "a".repeat(64),
    files: [
      { path: "bin/qemu-system-x86_64", size: 1, sha256: "b".repeat(64), executable: true },
      { path: "firmware/bios-256k.bin", size: 1, sha256: "c".repeat(64) },
      { path: "images/al2023-battle.qcow2", size: 1, sha256: "d".repeat(64) },
    ],
    ...overrides,
  };
  const raw = JSON.stringify(manifest);
  writeFileSync(join(directory, "manifest.json"), raw);
  writeFileSync(join(directory, "guest-bundle.tar.gz"), "archive");
  const state = mkdtempSync(join(tmpdir(), "tc-simulator-"));
  cleanup.push(state);
  return { directory, state, raw };
}

test("the runtime configuration pins the bundle, the session image and a wall-clock domain", () => {
  const { directory, state, raw } = bundle();
  const runtime = prepareBattleRuntime(directory, state, () => 1_700_000_000_000);
  cleanup.push(runtime.runtimeDirectory);
  expect(runtime.runtimeDirectory.startsWith(`${realpathSync("/tmp")}/tcb-`)).toBe(true);
  expect(runtime.runtimeDirectory.length).toBeLessThanOrEqual(70);
  expect(statSync(runtime.runtimeDirectory).mode & 0o777).toBe(0o700);
  expect(statSync(runtime.configPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(runtime.configPath, "utf8"))).toEqual({
    bundleManifest: join(directory, "manifest.json"),
    bundleArchive: join(directory, "guest-bundle.tar.gz"),
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
    sessionImageSha256: "d".repeat(64),
    runtimeDirectory: runtime.runtimeDirectory,
    layout: {
      emulator: "bin/qemu-system-x86_64",
      firmware: "firmware/bios-256k.bin",
      baseDisk: "images/al2023-battle.qcow2",
    },
    imageIds: ["ami-0a1b2c3d4e5f60718"],
    lifetimeUntilMs: 1_700_000_000_000 + 23 * 3_600_000,
    clock: {
      domain: "tenkacloud-host-wallclock-1",
      validFromMs: 1_700_000_000_000 - 1000,
      validUntilMs: 1_700_000_000_000 + 23 * 3_600_000,
    },
  });
  // A restart replaces the previous private file.
  const again = prepareBattleRuntime(directory, state, () => 1_700_000_100_000);
  cleanup.push(again.runtimeDirectory);
  expect(again.configPath).toBe(runtime.configPath);
  expect(again.runtimeDirectory).not.toBe(runtime.runtimeDirectory);
});

test("a bundle for another platform, a missing role or a non-file is refused before any directory", () => {
  const other = bundle({ os: platform.os === "linux" ? "darwin" : "linux" });
  expect(() => prepareBattleRuntime(other.directory, other.state)).toThrow("built for");
  const executableDisk = bundle({
    files: [
      { path: "bin/qemu-system-x86_64", size: 1, sha256: "b".repeat(64), executable: true },
      { path: "firmware/bios-256k.bin", size: 1, sha256: "c".repeat(64) },
      { path: "images/al2023-battle.qcow2", size: 1, sha256: "d".repeat(64), executable: true },
    ],
  });
  expect(() => prepareBattleRuntime(executableDisk.directory, executableDisk.state)).toThrow(
    "build_bundle.py",
  );
  const linked = bundle();
  rmSync(join(linked.directory, "guest-bundle.tar.gz"));
  symlinkSync(
    join(linked.directory, "manifest.json"),
    join(linked.directory, "guest-bundle.tar.gz"),
  );
  expect(() => prepareBattleRuntime(linked.directory, linked.state)).toThrow("build_bundle.py");
  const config = bundle();
  mkdirSync(join(config.state, "battle-runtime.json"));
  expect(() => prepareBattleRuntime(config.directory, config.state)).toThrow("regular file");
});

test("guest files are removed only after the Simulator exits cleanly", () => {
  const { directory, state } = bundle();
  const kept = prepareBattleRuntime(directory, state);
  cleanup.push(kept.runtimeDirectory);
  releaseBattleRuntime(kept, 1);
  expect(existsSync(kept.runtimeDirectory)).toBe(true);
  const removed = prepareBattleRuntime(directory, state);
  releaseBattleRuntime(removed, 0);
  expect(existsSync(removed.runtimeDirectory)).toBe(false);
});

test("a missing bundle directory is reported as not found with its path", () => {
  const { state } = bundle();
  const missing = join(state, "absent-bundle");
  expect(() => prepareBattleRuntime(missing, state)).toThrow(`Battle bundle not found: ${missing}`);
});

test("a present but invalid bundle names its path", () => {
  const { directory, state } = bundle();
  rmSync(join(directory, "guest-bundle.tar.gz"));
  expect(() => prepareBattleRuntime(directory, state)).toThrow(directory);
});
