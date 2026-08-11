import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("release workflow should pass the dispatch tag through env before shell parsing", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "release-cli.yml"),
    "utf8",
  );

  assert.match(
    workflow,
    /TARGET_TAG:\s*\$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}/,
  );
  assert.match(workflow, /TAG="\$TARGET_TAG"/);
  assert.doesNotMatch(
    workflow,
    /TAG="\$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}"/,
  );
  assert.ok(
    workflow.includes('if [[ ! "$TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then'),
    "release tags must be restricted to an exact stable SemVer shape",
  );
});

test("standalone CLI documentation should not claim Bun is bundled", async () => {
  const readme = await readFile(
    path.join(repositoryRoot, "packages", "standalone-cli", "README.md"),
    "utf8",
  );

  assert.doesNotMatch(readme, /Bun binary shipped as an npm dependency/);
  assert.match(readme, /Bun available on `PATH`/);
});
