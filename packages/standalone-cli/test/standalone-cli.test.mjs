import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, saveConfig } from "../src/config.mjs";
import { validateProblemsDirectory } from "../src/problems.mjs";
import { assertAwsIdentity } from "../src/runtime.mjs";

async function tempDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "tenkacloud-cli-"));
}

async function createProblem(root, id) {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "metadata.json"), JSON.stringify({ id }));
}

test("saveConfig should persist a normalized private configuration", async () => {
  const root = await tempDirectory();
  const file = path.join(root, "config.json");
  await saveConfig(
    {
      problemsDirectory: "./problems",
      awsAccountId: "123456789012",
      awsRegion: "ap-northeast-1",
      environment: "development",
    },
    { file },
  );
  const loaded = await loadConfig({ file });
  assert.equal(loaded.awsAccountId, "123456789012");
  assert.equal(JSON.parse(await readFile(file, "utf8")).environment, "development");
});

test("validateProblemsDirectory should accept regular problem directories", async () => {
  const root = await tempDirectory();
  await createProblem(root, "hello-world");
  await createProblem(root, "sqli-demo");
  const result = await validateProblemsDirectory(root);
  assert.deepEqual(
    result.problems.map((problem) => problem.id),
    ["hello-world", "sqli-demo"],
  );
});

test("validateProblemsDirectory should reject symbolic links", async () => {
  const root = await tempDirectory();
  const target = await tempDirectory();
  await createProblem(target, "outside");
  await symlink(path.join(target, "outside"), path.join(root, "outside"));
  await assert.rejects(() => validateProblemsDirectory(root), /Symbolic links are not allowed/);
});

test("assertAwsIdentity should fail closed on an account mismatch", () => {
  const config = { awsAccountId: "123456789012" };
  assert.throws(
    () =>
      assertAwsIdentity(config, () => ({
        status: 0,
        stdout: JSON.stringify({ Account: "999999999999", Arn: "arn:aws:iam::999999999999:user/x" }),
        stderr: "",
      })),
    /AWS account mismatch/,
  );
});
