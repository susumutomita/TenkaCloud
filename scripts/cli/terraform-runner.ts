import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readBundle, sha256, TerraformInputError } from "./terraform-bundle";

interface Scope {
  tenant: string;
  event: string;
  team: string;
  problem: string;
  generation: string;
}
interface Journal {
  scope: Scope;
  phase: string;
  bundle: string;
  binary: string;
  binarySha: string;
  endpoint?: string;
  kintone: boolean;
  planSha?: string;
  principalSha?: string;
}
export type TerraformExecutor = (
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) => number;
const execute: TerraformExecutor = (binary, args, cwd, env) => {
  const result = spawnSync(binary, args, {
    cwd,
    env,
    stdio: "pipe",
    timeout: 300_000,
    maxBuffer: 1024 * 1024,
  });
  // Raw diagnostics may contain secrets. Only retained inside the private deployment directory.
  write(
    join(cwd, `diagnostic-${args[0]}-${Date.now()}.log`),
    Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]),
  );
  return result.status ?? 1;
};
function privateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(path) !== path
  )
    throw new TerraformInputError("State directory must be private and symlink-free");
}
function file(path: string): Buffer {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new TerraformInputError("Expected regular file");
  return readFileSync(path);
}
function write(path: string, data: string | Buffer): void {
  writeFileSync(path, data, { mode: 0o600, flag: "wx" });
}
function endpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new TerraformInputError("Expected HTTPS tenant origin");
  return url.origin;
}
function options(args: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !key?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      Object.hasOwn(result, key.slice(2))
    )
      throw new TerraformInputError("Invalid arguments");
    result[key.slice(2)] = value;
  }
  return result;
}
interface Context {
  opts: Record<string, string>;
  scope: Scope;
  directory: string;
  journalPath: string;
  env: NodeJS.ProcessEnv;
  run: TerraformExecutor;
  log: (line: string) => void;
}
function saveJournal(journalPath: string, journal: Journal): void {
  const temp = join(dirname(journalPath), "journal.next");
  write(temp, JSON.stringify(journal));
  renameSync(temp, journalPath);
}
function prepareOperation(context: Context): void {
  const { opts, scope, directory, journalPath, log } = context;
  const save = (journal: Journal): void => saveJournal(journalPath, journal);

  if (existsSync(journalPath) || existsSync(join(directory, "bundle")))
    throw new TerraformInputError("Scope already prepared; never overwrite state");
  if (
    !opts.bundle ||
    !opts.binary ||
    !isAbsolute(opts.binary) ||
    !/^[a-f0-9]{64}$/.test(opts["binary-sha"] ?? "")
  )
    throw new TerraformInputError("Reviewed binary path and SHA required");
  const bundle = readBundle(resolve(opts.bundle));
  if (bundle.digest !== opts["reviewed-sha"] || sha256(file(opts.binary)) !== opts["binary-sha"])
    throw new TerraformInputError("Review digest mismatch");
  const origin = bundle.kintone ? endpoint(opts.endpoint ?? "") : undefined;
  const bundleDir = join(directory, "bundle");
  privateDirectory(bundleDir);
  for (const [name, data] of bundle.files) {
    const target = join(bundleDir, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    write(target, data);
    if (name.startsWith("mirror/") && !name.endsWith(".zip")) chmodSync(target, 0o700);
  }
  const work = join(directory, "work");
  privateDirectory(work);
  for (const name of ["main.tf.json", ".terraform.lock.hcl"])
    write(join(work, name), bundle.files.get(name) ?? "");
  privateDirectory(join(directory, "home"));
  privateDirectory(join(bundleDir, "mirror"));
  write(
    join(directory, "terraform.rc"),
    `disable_checkpoint = true\nprovider_installation {\n filesystem_mirror { path = ${JSON.stringify(join(bundleDir, "mirror"))} }\n}\n`,
  );
  save({
    scope,
    phase: "prepared",
    bundle: bundle.digest,
    binary: opts.binary,
    binarySha: opts["binary-sha"],
    endpoint: origin,
    kintone: bundle.kintone,
  });
  log("Prepared private scope; no resources created.");
}
function verifyOperation(context: Context, journal: Journal): string {
  const { scope, directory } = context;

  if (JSON.stringify(journal.scope) !== JSON.stringify(scope))
    throw new TerraformInputError("Scope mismatch");
  if (
    sha256(file(journal.binary)) !== journal.binarySha ||
    readBundle(join(directory, "bundle")).digest !== journal.bundle
  )
    throw new TerraformInputError("Reviewed artifact changed");
  const work = join(directory, "work");
  privateDirectory(work);
  for (const name of readdirSync(work)) {
    if (
      (name.endsWith(".tf") || name.endsWith(".tf.json") || name.includes(".tfvars")) &&
      name !== "main.tf.json"
    )
      throw new TerraformInputError("Unexpected working configuration");
    if (lstatSync(join(work, name)).isSymbolicLink())
      throw new TerraformInputError("Unexpected working symlink");
  }
  const expectedRc = `disable_checkpoint = true\nprovider_installation {\n filesystem_mirror { path = ${JSON.stringify(join(directory, "bundle", "mirror"))} }\n}\n`;
  if (file(join(directory, "terraform.rc")).toString() !== expectedRc)
    throw new TerraformInputError("CLI configuration changed");
  for (const name of ["main.tf.json", ".terraform.lock.hcl"])
    if (!file(join(work, name)).equals(file(join(directory, "bundle", name))))
      throw new TerraformInputError("Working configuration changed");

  return work;
}
function childEnvironment(context: Context, journal: Journal, work: string): NodeJS.ProcessEnv {
  const { directory, env } = context;
  // No ambient TF_* flags, cloud credentials, proxy settings, PATH or user CLI configuration.
  const childEnv: NodeJS.ProcessEnv = {
    HOME: join(directory, "home"),
    TF_CLI_CONFIG_FILE: join(directory, "terraform.rc"),
    TF_DATA_DIR: join(work, ".terraform"),
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    CHECKPOINT_DISABLE: "1",
  };
  if (journal.kintone) {
    if (
      endpoint(env.KINTONE_BASE_URL ?? "") !== journal.endpoint ||
      !env.KINTONE_USERNAME ||
      !env.KINTONE_PASSWORD
    )
      throw new TerraformInputError("Credentials must match the prepared tenant endpoint");
    childEnv.KINTONE_BASE_URL = journal.endpoint;
    childEnv.KINTONE_USERNAME = env.KINTONE_USERNAME;
    childEnv.KINTONE_PASSWORD = env.KINTONE_PASSWORD;
  }

  return childEnv;
}
interface Execution {
  journal: Journal;
  work: string;
  invoke: (argv: string[]) => void;
  save: (journal: Journal) => void;
}
function planOperation(context: Context, execution: Execution): void {
  const { env, log } = context;
  const { journal, work, invoke, save } = execution;

  if (!["prepared", "planned", "plan_failed"].includes(journal.phase))
    throw new TerraformInputError("Phase requires manual investigation; automatic replay refused");
  journal.principalSha = journal.kintone ? sha256(env.KINTONE_USERNAME ?? "") : undefined;
  journal.phase = "planning";
  delete journal.planSha;
  save(journal);
  try {
    invoke(["init", "-input=false", "-lockfile=readonly", "-no-color"]);
    invoke(["validate", "-no-color"]);
    invoke(["plan", "-input=false", "-no-color", "-out=approved.tfplan"]);
    journal.planSha = sha256(file(join(work, "approved.tfplan")));
    journal.phase = "planned";
    save(journal);
    log(`Plan saved privately. Review locally, then approve SHA: ${journal.planSha}`);
  } catch {
    journal.phase = "plan_failed";
    save(journal);
    throw new TerraformInputError("Plan failed; private artifacts retained; no apply performed");
  }
}
function applyOperation(context: Context, execution: Execution): void {
  const { env, opts, log } = context;
  const { journal, work, invoke, save } = execution;

  if (
    (journal.kintone && journal.principalSha !== sha256(env.KINTONE_USERNAME ?? "")) ||
    journal.phase !== "planned" ||
    !journal.planSha ||
    opts["approve-plan"] !== journal.planSha ||
    sha256(file(join(work, "approved.tfplan"))) !== journal.planSha
  )
    throw new TerraformInputError("Exact saved plan approval required; replay refused");
  journal.phase = "applying";
  save(journal);
  try {
    // Revalidate installed provider checksums against the reviewed read-only lockfile.
    invoke(["init", "-input=false", "-lockfile=readonly", "-no-color"]);
    invoke(["apply", "-input=false", "-no-color", "approved.tfplan"]);
    journal.phase = "applied";
    save(journal);
    log("Applied saved plan. State retained privately.");
  } catch {
    journal.phase = "apply_failed";
    save(journal);
    throw new TerraformInputError(
      "Apply failed or outcome uncertain; state retained. Do not retry or discard state.",
    );
  }
}
function lockedOperation(command: string, context: Context): void {
  const lock = join(context.directory, "operation.lock");
  closeSync(openSync(lock, "wx", 0o600));
  try {
    if (command === "prepare") {
      prepareOperation(context);
      return;
    }
    const journal = JSON.parse(file(context.journalPath).toString()) as Journal;
    const work = verifyOperation(context, journal);
    const childEnv = childEnvironment(context, journal, work);
    const invoke = (argv: string[]): void => {
      if (context.run(journal.binary, argv, work, childEnv) !== 0)
        throw new TerraformInputError(
          "Terraform failed; private state retained. Inspect locally with care.",
        );
    };
    const execution = {
      journal,
      work,
      invoke,
      save: (value: Journal): void => saveJournal(context.journalPath, value),
    };
    if (command === "plan") planOperation(context, execution);
    else applyOperation(context, execution);
  } finally {
    unlinkSync(lock);
  }
}
function scopedDirectory(opts: Record<string, string>): {
  scope: Scope;
  directory: string;
  journalPath: string;
} {
  const scope: Scope = { tenant: "", event: "", team: "", problem: "", generation: "" };
  for (const key of ["tenant", "event", "team", "problem", "generation"] as const) {
    if (!opts[key] || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(opts[key]))
      throw new TerraformInputError("Explicit safe scope required");
    scope[key] = opts[key];
  }
  if (!opts.root || !isAbsolute(opts.root))
    throw new TerraformInputError("Absolute private state root required");
  const root = resolve(opts.root);
  privateDirectory(root);
  const directory = join(root, sha256(JSON.stringify(scope)));
  privateDirectory(directory);
  const journalPath = join(directory, "journal.json");
  return { scope, directory, journalPath };
}
function commandOptions(command: string, args: readonly string[]): Record<string, string> {
  const opts = options(args.slice(1));
  let allowed = ["root", "tenant", "event", "team", "problem", "generation"];
  if (command === "digest") allowed = ["bundle"];
  if (command === "prepare")
    allowed.push("bundle", "reviewed-sha", "binary", "binary-sha", "endpoint");
  if (command === "apply") allowed.push("approve-plan");
  if (Object.keys(opts).some((key) => !allowed.includes(key)))
    throw new TerraformInputError("Unknown option");
  return opts;
}
/** Trusted organizer only: this is not an untrusted Terraform sandbox. */
export function runTerraformCommand(
  args: readonly string[],
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  run: TerraformExecutor = execute,
): number {
  try {
    const command = args[0];
    if (!command || command === "help" || command === "--help") {
      log(
        "Usage: tenkacloud terraform digest|prepare|plan|apply|status (see docs/terraform-exercises.md)",
      );
      return 0;
    }
    if (!["digest", "prepare", "plan", "apply", "status"].includes(command))
      throw new TerraformInputError("Unsupported command");
    const opts = commandOptions(command, args);
    if (command === "digest") {
      log(readBundle(resolve(opts.bundle ?? "")).digest);
      return 0;
    }
    const paths = scopedDirectory(opts);
    if (command === "status") {
      const journal = JSON.parse(file(paths.journalPath).toString()) as Journal;
      log(
        JSON.stringify({
          scopeId: sha256(JSON.stringify(paths.scope)),
          scope: journal.scope,
          phase: journal.phase,
          planSha: journal.planSha,
        }),
      );
      return 0;
    }
    lockedOperation(command, { ...paths, opts, env, run, log });
    return 0;
  } catch (error) {
    // Paths, provider diagnostics, state and credential values must never reach shared CLI logs.
    log(
      error instanceof TerraformInputError
        ? error.message
        : "Terraform operation refused or failed (filesystem, configuration, or process error). Inspect private artifacts and docs/terraform-exercises.md; preserve state.",
    );
    return 1;
  }
}
