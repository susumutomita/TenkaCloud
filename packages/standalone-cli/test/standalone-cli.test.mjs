import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, saveConfig } from "../src/config.mjs";
import { validateProblemsDirectory } from "../src/problems.mjs";
import { assertAwsIdentity, normalizeAwsPrincipalArn, prepareRuntime } from "../src/runtime.mjs";

async function tempDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "tenkacloud-cli-"));
}

async function createProblem(root, id) {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "metadata.json"), JSON.stringify({ id }));
  return directory;
}

const operatorConfig = {
  awsAccountId: "123456789012",
  allowedRoleArn: "arn:aws:iam::123456789012:role/TenkaCloudOperator",
};

test("saveConfig should persist a normalized private configuration", async () => {
  const root = await tempDirectory();
  const file = path.join(root, "config.json");
  await saveConfig(
    {
      problemsDirectory: "./problems",
      awsAccountId: "123456789012",
      allowedRoleArn: "arn:aws:iam::123456789012:role/TenkaCloudOperator",
      awsRegion: "ap-northeast-1",
      environment: "development",
    },
    { file },
  );
  const loaded = await loadConfig({ file });
  assert.equal(loaded.awsAccountId, "123456789012");
  assert.equal(loaded.allowedRoleArn, "arn:aws:iam::123456789012:role/TenkaCloudOperator");
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

test("validateProblemsDirectory should reject top-level symbolic links", async () => {
  const root = await tempDirectory();
  const target = await tempDirectory();
  await createProblem(target, "outside");
  await symlink(path.join(target, "outside"), path.join(root, "outside"));
  await assert.rejects(() => validateProblemsDirectory(root), /Symbolic links are not allowed/);
});

test("validateProblemsDirectory should reject nested symbolic links", async () => {
  const root = await tempDirectory();
  const problem = await createProblem(root, "nested-link");
  const assets = path.join(problem, "assets");
  await mkdir(assets);
  await symlink(path.join(problem, "metadata.json"), path.join(assets, "metadata-link.json"));
  await assert.rejects(() => validateProblemsDirectory(root), /Symbolic links are not allowed/);
});

test("normalizeAwsPrincipalArn should preserve role paths and discard the session name", () => {
  assert.equal(
    normalizeAwsPrincipalArn(
      "arn:aws:sts::123456789012:assumed-role/platform/TenkaCloudOperator/alice-session",
    ),
    "arn:aws:iam::123456789012:role/platform/TenkaCloudOperator",
  );
});

test("assertAwsIdentity should accept the configured role with any session name", () => {
  const identity = assertAwsIdentity(operatorConfig, () => ({
    status: 0,
    stdout: JSON.stringify({
      Account: "123456789012",
      Arn: "arn:aws:sts::123456789012:assumed-role/TenkaCloudOperator/session-123",
    }),
    stderr: "",
  }));
  assert.equal(identity.RoleArn, operatorConfig.allowedRoleArn);
});

test("assertAwsIdentity should fail closed on an account mismatch", () => {
  assert.throws(
    () =>
      assertAwsIdentity(operatorConfig, () => ({
        status: 0,
        stdout: JSON.stringify({
          Account: "999999999999",
          Arn: "arn:aws:sts::999999999999:assumed-role/TenkaCloudOperator/x",
        }),
        stderr: "",
      })),
    /AWS account mismatch/,
  );
});

test("assertAwsIdentity should fail closed on a role mismatch", () => {
  assert.throws(
    () =>
      assertAwsIdentity(operatorConfig, () => ({
        status: 0,
        stdout: JSON.stringify({
          Account: "123456789012",
          Arn: "arn:aws:sts::123456789012:assumed-role/AdministratorAccess/x",
        }),
        stderr: "",
      })),
    /AWS role mismatch/,
  );
});

test("assertAwsIdentity should reject IAM users", () => {
  assert.throws(
    () =>
      assertAwsIdentity(operatorConfig, () => ({
        status: 0,
        stdout: JSON.stringify({
          Account: "123456789012",
          Arn: "arn:aws:iam::123456789012:user/alice",
        }),
        stderr: "",
      })),
    /must be an assumed IAM role/,
  );
});

test("validateProblemsDirectory should reject a symlinked problems root", async () => {
  // Reached by its own message rather than by the directory check, which is what
  // tells the operator the path is a link instead of claiming it is missing.
  const target = await tempDirectory();
  await createProblem(target, "real");
  const link = path.join(await tempDirectory(), "problems-link");
  await symlink(target, link);
  await assert.rejects(
    () => validateProblemsDirectory(link),
    /Problems directory must not be a symbolic link/,
  );
});

test("validateProblemsDirectory should reject FIFOs and other non-regular files", async () => {
  const root = await tempDirectory();
  const problem = await createProblem(root, "special-file");
  const created = spawnSync("mkfifo", [path.join(problem, "queue")]);
  assert.equal(created.status, 0, `mkfifo failed: ${created.stderr ?? created.error?.message}`);
  await assert.rejects(
    () => validateProblemsDirectory(root),
    /Only regular files and directories are allowed/,
  );
});

test("prepareRuntime should keep the validated tree when a later sync is refused", async () => {
  const workspace = await tempDirectory();
  const runtimeSource = path.join(workspace, "source");
  const runtimeDestination = path.join(workspace, "runtime");
  const problemsDirectory = path.join(workspace, "problems");
  await mkdir(runtimeSource, { recursive: true });
  await createProblem(problemsDirectory, "hello-world");

  // Stand the runtime up as already-current so the sync is the only step that
  // runs: no bundled-runtime copy and no dependency install to reach out for.
  await mkdir(runtimeDestination, { recursive: true });
  await writeFile(path.join(runtimeDestination, ".tenkacloud-runtime-version"), "test\n");
  await writeFile(path.join(runtimeDestination, ".tenkacloud-dependencies-ready"), "ready\n");

  const config = { ...operatorConfig, problemsDirectory, awsRegion: "ap-northeast-1" };
  const options = { runtimeSource, runtimeDestination, version: "test" };
  await prepareRuntime(config, options);
  const synced = path.join(runtimeDestination, "problems", "hello-world", "metadata.json");
  assert.equal(JSON.parse(await readFile(synced, "utf8")).id, "hello-world");

  // Now point a link at the caller's home directory, the way an escape would be
  // staged between two runs, and ask for the runtime again.
  await symlink(os.homedir(), path.join(problemsDirectory, "hello-world", "escape"));
  await assert.rejects(() => prepareRuntime(config, options), /Symbolic links are not allowed/);

  // The refusal must not have cost the operator the tree that was already
  // validated. This holds because the source is scanned before anything is
  // copied — which also means these two assertions do not exercise the catch
  // block's staging cleanup, since on this path no staging directory is ever
  // created. Reaching that block needs the source to pass and the copy to fail,
  // which is the TOCTOU race it exists for and not a state a test can stage.
  assert.equal(JSON.parse(await readFile(synced, "utf8")).id, "hello-world");
  const leftovers = (await readdir(runtimeDestination)).filter((entry) =>
    entry.startsWith(".problems-staging-"),
  );
  assert.deepEqual(leftovers, []);
});
