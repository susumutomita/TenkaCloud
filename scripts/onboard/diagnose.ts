/**
 * [Issue #2119] Onboarding diagnosis — detect every prerequisite `make local`
 * needs from a fresh clone, as pure, testable functions.
 *
 * The detection is split from execution/consent so the interpretation logic can
 * be unit-tested without touching the real machine: every check takes an injected
 * {@link CommandRunner} / {@link DiagnoseFs} instead of shelling out directly.
 *
 * Checks (in `make local` preflight order):
 *   1. mise-trust   — `mise.toml` present but not trusted blocks tool activation
 *   2. submodule    — `problems/` (TenkaCloudChallenge) not initialized → no problems
 *   3. bun          — the platform's package manager / script runner
 *   4. docker-cli   — local-play drives `docker compose` directly
 *   5. docker-compose — the compose plugin (`docker compose`)
 *   6. docker-daemon  — the daemon must be running to start containers
 */

export type CheckStatus = "ok" | "missing" | "action-needed" | "skipped";

export interface CheckResult {
  readonly id: CheckId;
  /** Human-readable label, e.g. "Docker daemon". */
  readonly title: string;
  readonly status: CheckStatus;
  /** Why it matters / what was observed (one line, shown to the user). */
  readonly detail: string;
}

export type CheckId =
  | "mise-trust"
  | "submodule"
  | "bun"
  | "docker-cli"
  | "docker-compose"
  | "docker-daemon";

export interface CommandOutcome {
  /** Process exit code, or `null` when the executable was not found on PATH. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): CommandOutcome;
}

export interface DiagnoseFs {
  existsSync(path: string): boolean;
}

export interface DiagnoseInput {
  readonly repoRoot: string;
  readonly run: CommandRunner;
  readonly fs: DiagnoseFs;
}

const NOT_FOUND: CommandOutcome = { code: null, stdout: "", stderr: "" };

/** True when the executable exists and exited cleanly. */
function ran(outcome: CommandOutcome): boolean {
  return outcome.code === 0;
}

/** True when the executable was not found on PATH (vs. found-but-failed). */
function notInstalled(outcome: CommandOutcome): boolean {
  return outcome.code === null;
}

function join(repoRoot: string, ...parts: string[]): string {
  return [repoRoot.replace(/\/$/, ""), ...parts].join("/");
}

/**
 * mise activates tool versions from `mise.toml`, but refuses until the file is
 * trusted ("Config files ... are not trusted"). If there is no `mise.toml` or
 * mise itself is not installed, the check is `skipped` (mise is optional —
 * `make local` works with a system bun too).
 */
export function checkMiseTrust(input: DiagnoseInput): CheckResult {
  const base = { id: "mise-trust" as const, title: "mise config trust" };
  if (!input.fs.existsSync(join(input.repoRoot, "mise.toml"))) {
    return { ...base, status: "skipped", detail: "no mise.toml in this repo — skipping" };
  }
  const mise = input.run.run("mise", ["--version"]);
  if (notInstalled(mise)) {
    return {
      ...base,
      status: "skipped",
      detail: "mise is not installed — skipping (a system bun also works)",
    };
  }
  // Robust across mise versions: when a config is untrusted, mise prints
  // "Config files ... are not trusted" to stderr on any config-reading command.
  // We key off that message rather than a version-specific `--flag`.
  const listed = input.run.run("mise", ["ls"]);
  const untrusted = /not trusted/i.test(`${listed.stdout}\n${listed.stderr}`);
  return untrusted
    ? { ...base, status: "action-needed", detail: "mise.toml is present but not trusted" }
    : { ...base, status: "ok", detail: "mise.toml is trusted" };
}

/**
 * The `problems/` git submodule (TenkaCloudChallenge) holds every problem. A
 * plain `git clone` (no `--recurse-submodules`) leaves it empty, so the default
 * problem is "not found". Detect via the presence of a category directory's
 * metadata, which only exists once the submodule is checked out.
 */
export function checkSubmodule(input: DiagnoseInput): CheckResult {
  const base = { id: "submodule" as const, title: "problems/ submodule" };
  const markers = [
    join(input.repoRoot, "problems", "challenges"),
    join(input.repoRoot, "problems", "battles"),
  ];
  const present = markers.some((dir) => input.fs.existsSync(dir));
  return present
    ? { ...base, status: "ok", detail: "problems/ is initialized" }
    : {
        ...base,
        status: "action-needed",
        detail: "problems/ submodule is not initialized (empty after a plain clone)",
      };
}

function versionLine(outcome: CommandOutcome): string {
  return (outcome.stdout || outcome.stderr).split("\n")[0]?.trim() ?? "";
}

/** Bun runs every platform script and installs dependencies. */
export function checkBun(input: DiagnoseInput): CheckResult {
  const base = { id: "bun" as const, title: "Bun" };
  const out = input.run.run("bun", ["--version"]);
  if (ran(out)) return { ...base, status: "ok", detail: `bun ${versionLine(out)}` };
  return {
    ...base,
    status: "missing",
    detail: "bun is not installed (runs every platform script)",
  };
}

/** Docker CLI — local-play shells out to `docker compose`. */
export function checkDockerCli(input: DiagnoseInput): CheckResult {
  const base = { id: "docker-cli" as const, title: "Docker CLI" };
  const out = input.run.run("docker", ["--version"]);
  if (ran(out)) return { ...base, status: "ok", detail: versionLine(out) };
  return { ...base, status: "missing", detail: "docker CLI is not installed" };
}

/**
 * The compose plugin (`docker compose version`). Only meaningful when the CLI is
 * present; otherwise it is `skipped` (the CLI check already reports the gap).
 */
export function checkDockerCompose(input: DiagnoseInput): CheckResult {
  const base = { id: "docker-compose" as const, title: "Docker Compose plugin" };
  if (!ran(input.run.run("docker", ["--version"]))) {
    return { ...base, status: "skipped", detail: "needs the Docker CLI first" };
  }
  const out = input.run.run("docker", ["compose", "version"]);
  if (ran(out)) return { ...base, status: "ok", detail: versionLine(out) };
  return {
    ...base,
    status: "missing",
    detail: "the `docker compose` plugin is not available",
  };
}

/**
 * The daemon must be reachable (`docker info`). Distinguished from a missing CLI
 * (`skipped`) so the user gets a "start the daemon" path, not a "install docker"
 * one. CLI-present-but-daemon-down is the most common fresh-machine state.
 */
export function checkDockerDaemon(input: DiagnoseInput): CheckResult {
  const base = { id: "docker-daemon" as const, title: "Docker daemon" };
  if (!ran(input.run.run("docker", ["--version"]))) {
    return { ...base, status: "skipped", detail: "needs the Docker CLI first" };
  }
  const out = input.run.run("docker", ["info"]);
  if (ran(out)) return { ...base, status: "ok", detail: "daemon is running" };
  return {
    ...base,
    status: "action-needed",
    detail: "the Docker CLI is installed but the daemon is not reachable",
  };
}

export interface Diagnosis {
  readonly checks: readonly CheckResult[];
}

/** Run every check in preflight order and collect the results. */
export function diagnose(input: DiagnoseInput): Diagnosis {
  return {
    checks: [
      checkMiseTrust(input),
      checkSubmodule(input),
      checkBun(input),
      checkDockerCli(input),
      checkDockerCompose(input),
      checkDockerDaemon(input),
    ],
  };
}

/** A check that blocks `make local` (anything not ok / skipped). */
export function blockingChecks(diagnosis: Diagnosis): readonly CheckResult[] {
  return diagnosis.checks.filter((c) => c.status !== "ok" && c.status !== "skipped");
}

/** True when nothing blocks startup. */
export function isReady(diagnosis: Diagnosis): boolean {
  return blockingChecks(diagnosis).length === 0;
}

export { NOT_FOUND };
