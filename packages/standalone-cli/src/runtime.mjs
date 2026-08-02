import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateProblemsDirectory } from "./problems.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cacheRoot(env = process.env) {
  if (env.TENKACLOUD_CACHE_DIR) return path.resolve(env.TENKACLOUD_CACHE_DIR);
  return path.join(env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "tenkacloud");
}

async function packageVersion() {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  return packageJson.version;
}

/**
 * The bundled runtime is TypeScript, so running it needs Bun.
 *
 * This package deliberately does not depend on the `bun` npm package. That
 * package ships a stub and downloads the real binary from a `postinstall`, so
 * in any checkout installed with `--ignore-scripts` the stub stays a stub. It
 * also puts that stub on `node_modules/.bin`, which shadows the real toolchain
 * for every `#!/usr/bin/env bun` script in the monorepo, and it registers a new
 * install-time script that `scripts/security/audit-dependencies.ts` is written
 * to reject. Resolving from PATH keeps the dependency graph free of
 * install-time scripts and says so plainly when Bun is missing.
 */
export function resolveBunBinary(env = process.env) {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8", env });
  if (probe.error || (probe.status ?? 1) !== 0) {
    throw new Error(
      "Bun is required to run the bundled TenkaCloud runtime, but no 'bun' was found on PATH.\n" +
        "Install it with 'npm install -g bun' or from https://bun.sh, then run this command again.",
    );
  }
  return "bun";
}

function run(command, args, cwd, stdio = "inherit") {
  const result = spawnSync(command, args, { cwd, stdio, env: process.env });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}.`);
  }
}

/**
 * Reduce an STS assumed-role ARN to the IAM role ARN behind it.
 *
 * STS reports `assumed-role/<role-name>/<session-name>` — the role *name* only,
 * never the role's IAM path. Neither segment can contain a slash, so both are
 * matched as such.
 */
export function normalizeAwsPrincipalArn(arn) {
  if (typeof arn !== "string") return undefined;
  const assumedRole =
    /^arn:(aws|aws-us-gov|aws-cn):sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(arn);
  if (!assumedRole) return undefined;
  return `arn:${assumedRole[1]}:iam::${assumedRole[2]}:role/${assumedRole[3]}`;
}

/**
 * Reduce the configured role ARN to the same shape.
 *
 * An operator may legitimately configure a role that carries an IAM path, such
 * as `arn:aws:iam::123456789012:role/platform/TenkaCloudOperator`. STS never
 * echoes that path back, so comparing the two verbatim refuses a correctly
 * configured operator with "AWS role mismatch" every time. Dropping the path
 * loses no authority: IAM role names are unique within an account, so partition
 * plus account plus name identifies exactly one role.
 */
export function normalizeAllowedRoleArn(arn) {
  if (typeof arn !== "string") return undefined;
  const role = /^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/(.+)$/.exec(arn);
  if (!role) return undefined;
  const name = role[3].split("/").filter(Boolean).pop();
  if (!name) return undefined;
  return `arn:${role[1]}:iam::${role[2]}:role/${name}`;
}

async function syncProblems(config, destination) {
  await validateProblemsDirectory(config.problemsDirectory);
  const problemsDestination = path.join(destination, "problems");
  const staging = path.join(
    destination,
    `.problems-staging-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    await cp(config.problemsDirectory, staging, {
      recursive: true,
      dereference: false,
      errorOnExist: false,
    });
    await validateProblemsDirectory(staging);
    await rm(problemsDestination, { recursive: true, force: true });
    await rename(staging, problemsDestination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareRuntime(config, options = {}) {
  const source = options.runtimeSource ?? path.join(packageRoot, "runtime");
  const version = options.version ?? (await packageVersion());
  const destination =
    options.runtimeDestination ?? path.join(cacheRoot(options.env), "runtime", version);
  const marker = path.join(destination, ".tenkacloud-runtime-version");
  const dependenciesMarker = path.join(destination, ".tenkacloud-dependencies-ready");

  let currentVersion;
  try {
    currentVersion = (await readFile(marker, "utf8")).trim();
  } catch {
    currentVersion = undefined;
  }
  if (currentVersion !== version) {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, dereference: false });
    await writeFile(marker, `${version}\n`, { mode: 0o600 });
  }

  try {
    await readFile(dependenciesMarker, "utf8");
  } catch {
    run(resolveBunBinary(), ["install", "--frozen-lockfile", "--ignore-scripts"], destination);
    await writeFile(dependenciesMarker, "ready\n", { mode: 0o600 });
  }

  await syncProblems(config, destination);
  return destination;
}

export async function runBundledCommand(config, args, options = {}) {
  const runtime = await prepareRuntime(config, options);
  const result = spawnSync(resolveBunBinary(), ["run", "scripts/tenkacloud-lite.ts", ...args], {
    cwd: runtime,
    stdio: "inherit",
    env: {
      ...process.env,
      AWS_REGION: config.awsRegion,
      AWS_DEFAULT_REGION: config.awsRegion,
      AWS_ACCOUNT_ID: config.awsAccountId,
      CDK_PARAM_ENVIRONMENT: config.environment,
    },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runAws(args, options = {}) {
  const result = spawnSync("aws", args, {
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export function assertAwsIdentity(config, runner = runAws) {
  const identity = runner(["sts", "get-caller-identity", "--output", "json"]);
  if (identity.status !== 0) {
    throw new Error(`AWS credentials are unavailable. Run 'aws login' first.\n${identity.stderr.trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(identity.stdout);
  } catch {
    throw new Error("AWS CLI returned an invalid sts get-caller-identity response.");
  }
  if (parsed.Account !== config.awsAccountId) {
    throw new Error(
      `AWS account mismatch. Configured=${config.awsAccountId}, logged-in=${parsed.Account}. No resources were modified.`,
    );
  }
  const principalRoleArn = normalizeAwsPrincipalArn(parsed.Arn);
  if (!principalRoleArn) {
    throw new Error(
      `AWS principal must be an assumed IAM role. Received=${parsed.Arn ?? "unknown"}. No resources were modified.`,
    );
  }
  const allowedRoleArn = normalizeAllowedRoleArn(config.allowedRoleArn);
  if (!allowedRoleArn) {
    throw new Error(
      `Configured allowedRoleArn is not an IAM role ARN: ${config.allowedRoleArn ?? "unset"}. No resources were modified.`,
    );
  }
  if (principalRoleArn !== allowedRoleArn) {
    throw new Error(
      `AWS role mismatch. Configured=${config.allowedRoleArn}, logged-in=${principalRoleArn}. No resources were modified.`,
    );
  }
  return { ...parsed, RoleArn: principalRoleArn };
}
