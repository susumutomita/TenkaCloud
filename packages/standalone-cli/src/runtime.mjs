import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cacheRoot(env = process.env) {
  if (env.TENKACLOUD_CACHE_DIR) return path.resolve(env.TENKACLOUD_CACHE_DIR);
  return path.join(env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "tenkacloud");
}

async function packageVersion() {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  return packageJson.version;
}

function resolveBunBinary() {
  try {
    return require.resolve("bun/bin/bun.exe");
  } catch {
    return "bun";
  }
}

export async function prepareRuntime(config, options = {}) {
  const source = options.runtimeSource ?? path.join(packageRoot, "runtime");
  const version = options.version ?? (await packageVersion());
  const destination = options.runtimeDestination ?? path.join(cacheRoot(options.env), "runtime", version);
  const marker = path.join(destination, ".tenkacloud-runtime-version");

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
    await BunWriteFile(marker, `${version}\n`);
  }

  const problemsDestination = path.join(destination, "problems");
  await rm(problemsDestination, { recursive: true, force: true });
  await cp(config.problemsDirectory, problemsDestination, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
  });
  return destination;
}

async function BunWriteFile(file, content) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, content, { mode: 0o600 });
}

export async function runBundledCommand(config, args, options = {}) {
  const runtime = await prepareRuntime(config, options);
  const command = resolveBunBinary();
  const result = spawnSync(command, ["run", "scripts/tenkacloud-lite.ts", ...args], {
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
  return parsed;
}
