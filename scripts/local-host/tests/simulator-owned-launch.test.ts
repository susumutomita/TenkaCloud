import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareOwnedSimulatorLaunch } from "../simulator-owned-launch";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "owned-launch-"));
  dirs.push(dir);
  const binary = join(dir, "simulator");
  const config = join(dir, "config.json");
  writeFileSync(binary, "synthetic executable", { mode: 0o700 });
  writeFileSync(config, '{"test":true}', { mode: 0o600 });
  const battle = {
    binarySha256: hash("synthetic executable"),
    runtimeConfigPath: config,
    runtimeConfigSha256: hash('{"test":true}'),
  };
  return { dir, binary, config, battle };
}
test("pins retained executable and private snapshot until dispose, no process spawn", () => {
  const f = fixture();
  const launch = prepareOwnedSimulatorLaunch(f.binary, f.battle, f.dir);
  const snapshot = launch.args[0]?.split("=")[1] ?? "";
  expect(launch.command).toBe("/proc/self/fd/4");
  expect(fstatSync(launch.fd).isFile()).toBe(true);
  expect(launch.args[1]).toBe("--battle-clock-proof-fd=3");
  writeFileSync(f.config, "changed");
  expect(readFileSync(snapshot, "utf8")).toBe('{"test":true}');
  launch.closeDescriptor();
  launch.closeDescriptor();
  expect(existsSync(snapshot)).toBe(true);
  launch.dispose();
  launch.dispose();
  expect(existsSync(snapshot)).toBe(false);
});
test("binary hash mismatch leaves no snapshot", () => {
  const f = fixture();
  expect(() =>
    prepareOwnedSimulatorLaunch(f.binary, { ...f.battle, binarySha256: "0".repeat(64) }, f.dir),
  ).toThrow("pin mismatch");
  expect(readdirSync(f.dir).sort()).toEqual(["config.json", "simulator"]);
});
test("config hash mismatch leaves no snapshot", () => {
  const f = fixture();
  expect(() =>
    prepareOwnedSimulatorLaunch(
      f.binary,
      { ...f.battle, runtimeConfigSha256: "0".repeat(64) },
      f.dir,
    ),
  ).toThrow("pin mismatch");
  expect(readdirSync(f.dir).sort()).toEqual(["config.json", "simulator"]);
});
for (const mode of [0o722, 0o600])
  test(`unsafe executable mode ${mode} fails`, () => {
    const f = fixture();
    chmodSync(f.binary, mode);
    expect(() => prepareOwnedSimulatorLaunch(f.binary, f.battle, f.dir)).toThrow();
  });
test("symlink executable and public configuration rejected", () => {
  const f = fixture();
  const link = join(f.dir, "link");
  symlinkSync(f.binary, link);
  expect(() => prepareOwnedSimulatorLaunch(link, f.battle, f.dir)).toThrow();
  chmodSync(f.config, 0o644);
  expect(() => prepareOwnedSimulatorLaunch(f.binary, f.battle, f.dir)).toThrow();
});
test("oversized private config and nonprivate directory rejected", () => {
  const f = fixture();
  writeFileSync(f.config, "x".repeat(65537));
  expect(() => prepareOwnedSimulatorLaunch(f.binary, f.battle, f.dir)).toThrow("size");
  chmodSync(f.dir, 0o755);
  expect(() => prepareOwnedSimulatorLaunch(f.binary, f.battle, f.dir)).toThrow("private");
});
