import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPackFiles, computeContentDigest } from "../src/content-digest.js";

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "content-digest-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("canonical catalog content identity", () => {
  it("orders nested relative paths independently of creation order and binds path names", () => {
    const left = temporary();
    const right = temporary();
    for (const [root, paths] of [
      [left, ["b", "nested/a", "nested-z"]],
      [right, ["nested-z", "nested/a", "b"]],
    ] as const) {
      mkdirSync(join(root, "nested"));
      for (const name of paths) writeFileSync(join(root, name), name === "b" ? "y" : "x");
    }
    expect(computeContentDigest(left, true)).toBe(computeContentDigest(right, true));
    expect(
      collectPackFiles(left)
        .map((file) => file.relPath)
        .sort(),
    ).toEqual(["b", "nested-z", "nested/a"]);
    writeFileSync(join(right, "renamed"), "x");
    rmSync(join(right, "nested/a"));
    expect(computeContentDigest(left, true)).not.toBe(computeContentDigest(right, true));
  });

  it("binds hidden and shared runtime files only when full-file snapshots are requested", () => {
    const root = temporary();
    writeFileSync(join(root, "visible"), "same");
    const legacy = computeContentDigest(root);
    for (const directory of [".private-input", "node_modules", "dist", ".git"]) {
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, "shared"), "version1");
    }
    const first = computeContentDigest(root, true);
    expect(computeContentDigest(root)).toBe(legacy);
    expect(first).not.toBe(legacy);
    writeFileSync(join(root, ".private-input", "shared"), "version2");
    expect(computeContentDigest(root, true)).not.toBe(first);
    expect(computeContentDigest(root)).toBe(legacy);
    expect(collectPackFiles(root).map((file) => file.relPath)).toEqual(["visible"]);
  });

  it.each(["file", "directory", "broken"])(
    "never follows %s links and rejects them in full-file snapshots",
    (kind) => {
      const root = temporary();
      const target = join(temporary(), "target");
      if (kind === "file") writeFileSync(target, "outside snapshot");
      if (kind === "directory") mkdirSync(target);
      symlinkSync(target, join(root, "link"));
      expect(collectPackFiles(root)).toEqual([]);
      expect(computeContentDigest(root)).toBe(createHash("sha256").digest("hex"));
      expect(() => computeContentDigest(root, true)).toThrow("symbolic link");
    },
  );

  it("rejects special filesystem entries instead of silently giving them an identity", async () => {
    const root = temporary();
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(join(root, "runtime.sock"), resolve);
    });
    try {
      expect(collectPackFiles(root)).toEqual([]);
      expect(() => computeContentDigest(root, true)).toThrow("Unsupported catalog file");
    } finally {
      await new Promise<void>((resolve, reject) =>
        socket.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("preserves the documented empty identity for a missing root or a non-directory root", () => {
    const root = temporary();
    writeFileSync(join(root, "file"), "not a catalog directory");
    const empty = createHash("sha256").digest("hex");
    expect(computeContentDigest(join(root, "missing"), true)).toBe(empty);
    expect(computeContentDigest(join(root, "file"), true)).toBe(empty);
  });
});
