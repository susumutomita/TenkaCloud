import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeDirectory, removeRuntimeFiles } from "../runtime-directory";
import {
  createTemporaryDirectory,
  inspectTemporaryDirectories,
  removeTemporaryDirectory,
} from "../temporary-directory";

const roots: string[] = [];
afterEach(() => {
  // These roots and every contained fixture were created only by this test.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "tenka-cleanup-synthetic-"));
  roots.push(path);
  return path;
}
function runtime(data = root()) {
  const directory = prepareRuntimeDirectory(data, "synthetic-job", true);
  const compose = join(directory, "tch-synthetic-job.compose.yml");
  const seed = join(directory, "problem-secrets.key");
  writeFileSync(compose, "services: {}\n", { mode: 0o600 });
  writeFileSync(seed, `${"a".repeat(64)}\n`, { mode: 0o600 });
  return { data, directory, compose, seed };
}

test("explicit successful teardown removes only the marked runtime's generated files", () => {
  const f = runtime();
  writeFileSync(join(f.data, "hosting.sqlite"), "synthetic saved scores");
  writeFileSync(join(f.data, "host-key"), "synthetic participant-key protection");
  const other = prepareRuntimeDirectory(f.data, "other-job", true);
  writeFileSync(join(other, "problem-secrets.key"), "retained other runtime");
  removeRuntimeFiles(f.data, "synthetic-job", f.compose);
  expect(existsSync(f.directory)).toBe(false);
  expect(readFileSync(join(f.data, "hosting.sqlite"), "utf8")).toBe("synthetic saved scores");
  expect(existsSync(join(f.data, "host-key"))).toBe(true);
  expect(existsSync(join(other, "problem-secrets.key"))).toBe(true);
});

test("unmarked legacy runtimes are never adopted and retain seeds or unknown files", () => {
  const data = root();
  const directory = prepareRuntimeDirectory(data, "legacy-job", false);
  prepareRuntimeDirectory(data, "legacy-job", true);
  const compose = join(directory, "tch-legacy-job.compose.yml");
  writeFileSync(compose, "services: {}\n");
  writeFileSync(join(directory, "problem-secrets.key"), "retained legacy seed");
  writeFileSync(join(directory, "user-notes.txt"), "unowned");
  removeRuntimeFiles(data, "legacy-job", compose);
  expect(readdirSync(directory).sort()).toEqual(["problem-secrets.key", "user-notes.txt"]);
});

for (const damage of ["unknown-file", "marker", "symlink", "dangling-marker"] as const) {
  test(`runtime cleanup retains everything on ${damage}`, () => {
    const f = runtime();
    const marker = join(f.directory, ".tenkacloud-runtime-owner");
    const outside = join(f.data, "keep.txt");
    writeFileSync(outside, "unrelated");
    if (damage === "unknown-file") writeFileSync(join(f.directory, "notes.txt"), "unknown");
    else if (damage === "marker") writeFileSync(marker, "different ownership");
    else if (damage === "symlink") {
      rmSync(f.seed);
      symlinkSync(outside, f.seed);
    } else {
      rmSync(marker);
      symlinkSync(join(f.data, "absent-marker"), marker);
    }
    expect(() => removeRuntimeFiles(f.data, "synthetic-job", f.compose)).toThrow();
    expect(existsSync(f.compose)).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("unrelated");
  });
}

test("runtime paths cannot escape through job IDs or a symlinked runtimes parent", () => {
  const data = root();
  const outside = root();
  expect(() => prepareRuntimeDirectory(data, "../outside", true)).toThrow("job ID");
  symlinkSync(outside, join(data, "runtimes"));
  expect(() => prepareRuntimeDirectory(data, "job", true)).toThrow("symlink");
  expect(readdirSync(outside)).toEqual([]);
});

test("temporary fixture data stays in one private marked root and disposes idempotently", () => {
  const repository = root();
  const directory = createTemporaryDirectory(repository, "fixture-");
  expect(directory.startsWith(join(repository, ".tenkacloud/cache/tmp/fixture-"))).toBe(true);
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  mkdirSync(join(directory, "nested"));
  writeFileSync(join(directory, "nested", "synthetic.sqlite"), "synthetic");
  expect(inspectTemporaryDirectories(repository)).toEqual([
    {
      directory,
      owned: true,
      ownerRunning: true,
      ownerPid: process.pid,
      createdAt: expect.any(Number),
    },
  ]);
  removeTemporaryDirectory(repository, directory);
  removeTemporaryDirectory(repository, directory);
  expect(existsSync(directory)).toBe(false);
});

for (const damage of [
  "other-live-pid",
  "dead-pid",
  "reused-pid",
  "unknown-owner",
  "symlink",
] as const) {
  test(`temporary cleanup retains ${damage} instead of guessing ownership`, () => {
    const repository = root();
    const directory = createTemporaryDirectory(repository, "fixture-");
    const marker = join(directory, ".tenkacloud-temporary-owner.json");
    const value = JSON.parse(readFileSync(marker, "utf8")) as {
      pid: number;
      session: string;
      kind: string;
    };
    if (damage === "other-live-pid") value.pid = process.ppid;
    else if (damage === "dead-pid") value.pid = 2_147_483_647;
    else if (damage === "reused-pid") value.session = "00000000-0000-4000-8000-000000000000";
    else if (damage === "unknown-owner") value.kind = "unknown";
    else symlinkSync(root(), join(directory, "external"));
    writeFileSync(marker, JSON.stringify(value));
    writeFileSync(join(directory, "keep.txt"), "synthetic retained data");
    expect(() => removeTemporaryDirectory(repository, directory)).toThrow();
    expect(existsSync(join(directory, "keep.txt"))).toBe(true);
    expect(existsSync(directory)).toBe(true);
  });
}

test("temporary cleanup rejects unmarked paths, symlinked roots and boundary escapes", () => {
  const repository = root();
  const directory = createTemporaryDirectory(repository, "fixture-");
  const unknown = join(directory, "..", "unmarked");
  mkdirSync(unknown, { mode: 0o700 });
  expect(() => removeTemporaryDirectory(repository, unknown)).toThrow();
  expect(() => removeTemporaryDirectory(repository, root())).toThrow("outside");
  expect(
    inspectTemporaryDirectories(repository).some(
      (item) => item.directory.endsWith("/unmarked") && !item.owned,
    ),
  ).toBe(true);
  const linkedRepository = root();
  symlinkSync(root(), join(linkedRepository, ".tenkacloud"));
  expect(() => createTemporaryDirectory(linkedRepository, "fixture-")).toThrow("Unsafe");
});
