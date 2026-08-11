import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assembleRuntime } from "../scripts/assemble-runtime.mjs";

async function tempDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "tenkacloud-assemble-runtime-"));
}

/**
 * Builds a minimal repository fixture with the same shape that breaks a naive
 * `cp(repositoryRoot/packages, runtimeRoot/packages)`: `runtimeRoot` lives inside
 * `packages/standalone-cli`, which is itself inside the `packages` root being
 * copied.
 */
async function createRepositoryFixture() {
  const repositoryRoot = await tempDirectory();
  await mkdir(path.join(repositoryRoot, "apps", "one"), { recursive: true });
  await writeFile(path.join(repositoryRoot, "apps", "one", "app.txt"), "app");
  await mkdir(path.join(repositoryRoot, "packages", "standalone-cli", "src"), {
    recursive: true,
  });
  await writeFile(
    path.join(repositoryRoot, "packages", "standalone-cli", "src", "cli.mjs"),
    "cli",
  );
  await mkdir(path.join(repositoryRoot, "packages", "standalone-cli", "node_modules", "left"), {
    recursive: true,
  });
  await writeFile(
    path.join(repositoryRoot, "packages", "standalone-cli", "node_modules", "left", "index.js"),
    "left",
  );
  await writeFile(path.join(repositoryRoot, "package.json"), JSON.stringify({ name: "root" }));
  return repositoryRoot;
}

test("assembleRuntime should assemble into a runtimeRoot nested inside a copied root without ERR_FS_CP_EINVAL", async () => {
  const repositoryRoot = await createRepositoryFixture();
  const runtimeRoot = path.join(repositoryRoot, "packages", "standalone-cli", "runtime");

  const result = await assembleRuntime({
    repositoryRoot,
    runtimeRoot,
    roots: ["apps", "packages", "package.json"],
  });

  assert.equal(result, runtimeRoot);
  assert.equal(
    await readFile(path.join(runtimeRoot, "apps", "one", "app.txt"), "utf8"),
    "app",
  );
  assert.equal(
    await readFile(
      path.join(runtimeRoot, "packages", "standalone-cli", "src", "cli.mjs"),
      "utf8",
    ),
    "cli",
  );
  assert.equal(JSON.parse(await readFile(path.join(runtimeRoot, "package.json"), "utf8")).name, "root");
});

test("assembleRuntime should exclude node_modules and its own prior output via the default filter", async () => {
  const repositoryRoot = await createRepositoryFixture();
  const runtimeRoot = path.join(repositoryRoot, "packages", "standalone-cli", "runtime");

  await assembleRuntime({ repositoryRoot, runtimeRoot, roots: ["packages"] });

  await assert.rejects(
    () =>
      readFile(
        path.join(
          runtimeRoot,
          "packages",
          "standalone-cli",
          "node_modules",
          "left",
          "index.js",
        ),
        "utf8",
      ),
    /ENOENT/,
  );
});

test("assembleRuntime should not leave a staging directory behind on success", async () => {
  const repositoryRoot = await createRepositoryFixture();
  const runtimeRoot = path.join(repositoryRoot, "packages", "standalone-cli", "runtime");

  await assembleRuntime({ repositoryRoot, runtimeRoot, roots: ["apps"] });

  const entries = await readdir(repositoryRoot);
  const staging = entries.filter((entry) => entry.startsWith(".tenkacloud-runtime-staging-"));
  assert.deepEqual(staging, []);
});

test("assembleRuntime should be re-runnable, replacing a previously assembled runtime", async () => {
  const repositoryRoot = await createRepositoryFixture();
  const runtimeRoot = path.join(repositoryRoot, "packages", "standalone-cli", "runtime");

  await assembleRuntime({ repositoryRoot, runtimeRoot, roots: ["apps"] });
  await writeFile(path.join(repositoryRoot, "apps", "one", "app.txt"), "changed");
  await assembleRuntime({ repositoryRoot, runtimeRoot, roots: ["apps"] });

  assert.equal(
    await readFile(path.join(runtimeRoot, "apps", "one", "app.txt"), "utf8"),
    "changed",
  );
});

test("assembleRuntime should clean up its staging directory and leave no partial runtime when a root is missing", async () => {
  const repositoryRoot = await createRepositoryFixture();
  const runtimeRoot = path.join(repositoryRoot, "packages", "standalone-cli", "runtime");

  await assert.rejects(
    () =>
      assembleRuntime({
        repositoryRoot,
        runtimeRoot,
        roots: ["apps", "does-not-exist"],
      }),
    /ENOENT/,
  );

  const entries = await readdir(repositoryRoot);
  const staging = entries.filter((entry) => entry.startsWith(".tenkacloud-runtime-staging-"));
  assert.deepEqual(staging, []);
  assert.equal(existsSync(runtimeRoot), false);
});
