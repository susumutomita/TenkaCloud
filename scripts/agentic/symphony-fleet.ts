#!/usr/bin/env bun

import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const DEFAULT_MANIFEST_PATH = ".symphony/fleet.json";

export interface FleetRepository {
  readonly id: string;
  readonly repository: string;
  readonly workflow: string;
  readonly workspace: string;
  readonly port: number;
}

export interface FleetConfig {
  readonly schemaVersion: 1;
  readonly defaultBinary: string;
  readonly workspaceRootEnv: string;
  readonly logsRootEnv: string;
  readonly repositories: readonly FleetRepository[];
}

export interface CliArguments {
  readonly command: "validate" | "print" | "run";
  readonly repositoryIds: readonly string[];
}

export interface LaunchSpec {
  readonly id: string;
  readonly repository: string;
  readonly command: readonly string[];
  readonly logsRoot: string;
  readonly port: number;
  readonly workspaceRoot: string;
  readonly workspaceRootEnv: string;
}

export class FleetConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FleetConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FleetConfigError(`${context}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function requiredPort(record: Readonly<Record<string, unknown>>, context: string): number {
  const value = record.port;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new FleetConfigError(`${context}.port must be an integer in 1..65535`);
  }
  return value;
}

/** Parse and type-check the JSON manifest before any filesystem or process work. */
export function parseFleetConfig(value: unknown): FleetConfig {
  if (!isRecord(value)) {
    throw new FleetConfigError("fleet manifest must be a JSON object");
  }
  if (value.schemaVersion !== 1) {
    throw new FleetConfigError("fleet manifest schemaVersion must be 1");
  }
  if (!Array.isArray(value.repositories) || value.repositories.length === 0) {
    throw new FleetConfigError("fleet manifest repositories must be a non-empty array");
  }

  const repositories = value.repositories.map((entry, index): FleetRepository => {
    const context = `repositories[${index}]`;
    if (!isRecord(entry)) {
      throw new FleetConfigError(`${context} must be an object`);
    }
    return {
      id: requiredString(entry, "id", context),
      repository: requiredString(entry, "repository", context),
      workflow: requiredString(entry, "workflow", context),
      workspace: requiredString(entry, "workspace", context),
      port: requiredPort(entry, context),
    };
  });

  return {
    schemaVersion: 1,
    defaultBinary: requiredString(value, "defaultBinary", "fleet"),
    workspaceRootEnv: requiredString(value, "workspaceRootEnv", "fleet"),
    logsRootEnv: requiredString(value, "logsRootEnv", "fleet"),
    repositories,
  };
}

/** Read the fleet manifest from a repository checkout. */
export async function loadFleet(
  root: string = REPO_ROOT,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): Promise<FleetConfig> {
  const absolutePath = resolve(root, manifestPath);
  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FleetConfigError(`cannot read fleet manifest ${absolutePath}: ${detail}`);
  }

  try {
    return parseFleetConfig(JSON.parse(source));
  } catch (error) {
    if (error instanceof FleetConfigError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new FleetConfigError(`invalid JSON in ${absolutePath}: ${detail}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requirePattern(source: string, pattern: RegExp, message: string): void {
  if (!pattern.test(source)) throw new FleetConfigError(message);
}

/** Validate the repository-specific safety and dispatch contract in one workflow. */
export function validateWorkflowText(
  config: FleetConfig,
  repository: FleetRepository,
  source: string,
): void {
  const escapedRepository = escapeRegExp(repository.repository);
  const escapedWorkspaceEnv = escapeRegExp(config.workspaceRootEnv);
  const cloneUrl = `git@github.com:${repository.repository}.git`;

  requirePattern(
    source,
    /^\s*kind:\s*github\s*$/m,
    `${repository.id}: tracker.kind must be github`,
  );
  requirePattern(
    source,
    new RegExp(`^\\s*repo:\\s*["']?${escapedRepository}["']?\\s*$`, "m"),
    `${repository.id}: tracker.provider.repo must be ${repository.repository}`,
  );
  requirePattern(
    source,
    /required_labels:\s*\n\s*-\s*agent:ready\s*(?:\n|$)/m,
    `${repository.id}: required_labels must contain agent:ready`,
  );
  requirePattern(
    source,
    /active_states:\s*\n\s*-\s*open\s*(?:\n|$)/m,
    `${repository.id}: active_states must contain open`,
  );
  requirePattern(
    source,
    /terminal_states:\s*\n\s*-\s*closed\s*(?:\n|$)/m,
    `${repository.id}: terminal_states must contain closed`,
  );
  requirePattern(
    source,
    new RegExp(`^\\s*root:\\s*\\$${escapedWorkspaceEnv}\\s*$`, "m"),
    `${repository.id}: workspace root must be $${config.workspaceRootEnv}`,
  );
  requirePattern(
    source,
    new RegExp(`git clone --filter=blob:none --no-tags ${escapeRegExp(cloneUrl)} \\.`),
    `${repository.id}: after_create must clone only ${repository.repository}`,
  );
  requirePattern(
    source,
    /make install_ci/,
    `${repository.id}: after_create must install the frozen dependency graph`,
  );
  requirePattern(
    source,
    /make agent-gate/,
    `${repository.id}: workflow must use make agent-gate`,
  );
  requirePattern(
    source,
    /codex exec review --base origin\/main/,
    `${repository.id}: workflow must run an independent Codex review`,
  );
  requirePattern(
    source,
    /Never run deploy, destroy, release, force-push, or secret-management commands\./,
    `${repository.id}: workflow must contain the destructive-action boundary`,
  );
  requirePattern(
    source,
    /^\s*approval_policy:\s*never\s*$/m,
    `${repository.id}: unattended workflow must declare approval_policy: never`,
  );
  requirePattern(
    source,
    /^\s*thread_sandbox:\s*workspace-write\s*$/m,
    `${repository.id}: Codex must be limited to workspace-write`,
  );
}

function assertUnique(
  seen: Map<string | number, string>,
  value: string | number,
  owner: string,
  field: string,
): void {
  const previous = seen.get(value);
  if (previous !== undefined) {
    throw new FleetConfigError(`${field} ${String(value)} is shared by ${previous} and ${owner}`);
  }
  seen.set(value, owner);
}

/** Validate fleet-wide uniqueness and every referenced workflow file. */
export async function validateFleet(config: FleetConfig, root: string = REPO_ROOT): Promise<void> {
  const ids = new Map<string, string>();
  const repositories = new Map<string, string>();
  const workflows = new Map<string, string>();
  const workspaces = new Map<string, string>();
  const ports = new Map<number, string>();

  for (const repository of config.repositories) {
    if (!/^[a-z][a-z0-9-]*$/.test(repository.id)) {
      throw new FleetConfigError(`${repository.id}: id must use lowercase kebab-case`);
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.repository)) {
      throw new FleetConfigError(`${repository.id}: repository must use owner/name form`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(repository.workspace)) {
      throw new FleetConfigError(`${repository.id}: workspace must use lowercase kebab-case`);
    }

    assertUnique(ids, repository.id, repository.id, "id");
    assertUnique(repositories, repository.repository, repository.id, "repository");
    assertUnique(workflows, repository.workflow, repository.id, "workflow");
    assertUnique(workspaces, repository.workspace, repository.id, "workspace");
    assertUnique(ports, repository.port, repository.id, "port");

    const workflowPath = resolve(root, repository.workflow);
    try {
      await access(workflowPath, constants.R_OK);
    } catch {
      throw new FleetConfigError(`${repository.id}: workflow is not readable: ${workflowPath}`);
    }
    const workflow = await readFile(workflowPath, "utf8");
    validateWorkflowText(config, repository, workflow);
  }
}

/** Parse the small CLI surface without accepting ambiguous positional arguments. */
export function parseCliArguments(argv: readonly string[]): CliArguments {
  const command = argv[0];
  if (command !== "validate" && command !== "print" && command !== "run") {
    throw new FleetConfigError(
      "usage: symphony-fleet.ts <validate|print|run> [--repo <id> | --repo=<id>]...",
    );
  }

  const repositoryIds: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new FleetConfigError("--repo requires a repository id");
      }
      repositoryIds.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--repo=")) {
      const value = argument.slice("--repo=".length);
      if (value.length === 0) throw new FleetConfigError("--repo requires a repository id");
      repositoryIds.push(value);
      continue;
    }
    throw new FleetConfigError(`unknown argument: ${argument}`);
  }

  return { command, repositoryIds };
}

/** Select repositories explicitly, failing instead of silently ignoring a typo. */
export function selectRepositories(
  config: FleetConfig,
  repositoryIds: readonly string[],
): readonly FleetRepository[] {
  if (repositoryIds.length === 0) return config.repositories;

  const byId = new Map(config.repositories.map((repository) => [repository.id, repository]));
  const selected: FleetRepository[] = [];
  const seen = new Set<string>();
  for (const id of repositoryIds) {
    if (seen.has(id)) throw new FleetConfigError(`repository was selected more than once: ${id}`);
    const repository = byId.get(id);
    if (repository === undefined) throw new FleetConfigError(`unknown repository id: ${id}`);
    seen.add(id);
    selected.push(repository);
  }
  return selected;
}

export type WhichCommand = (command: string) => string | null | undefined;

/** Return prerequisite names only; never include secret values in diagnostics. */
export function findMissingPrerequisites(
  config: FleetConfig,
  environment: Readonly<Record<string, string | undefined>>,
  which: WhichCommand,
): readonly string[] {
  const missing: string[] = [];
  const workspaceRoot = environment[config.workspaceRootEnv]?.trim();
  const logsRoot = environment[config.logsRootEnv]?.trim();
  const binary = environment.SYMPHONY_BIN?.trim() || config.defaultBinary;

  if (!environment.GITHUB_TOKEN?.trim()) missing.push("GITHUB_TOKEN");
  if (!workspaceRoot) {
    missing.push(config.workspaceRootEnv);
  } else if (!isAbsolute(workspaceRoot)) {
    missing.push(`${config.workspaceRootEnv} (must be absolute)`);
  }
  if (logsRoot && !isAbsolute(logsRoot)) {
    missing.push(`${config.logsRootEnv} (must be absolute)`);
  }

  for (const command of [binary, "codex", "git", "ssh"]) {
    const executable = which(command);
    if (executable === null || executable === undefined) missing.push(`command:${command}`);
  }
  return missing;
}

/** Build concrete process invocations after prerequisites have been checked. */
export function buildLaunchSpecs(
  config: FleetConfig,
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  repositoryIds: readonly string[] = [],
): readonly LaunchSpec[] {
  const fleetWorkspaceRoot = environment[config.workspaceRootEnv]?.trim();
  if (!fleetWorkspaceRoot || !isAbsolute(fleetWorkspaceRoot)) {
    throw new FleetConfigError(`${config.workspaceRootEnv} must be an absolute path`);
  }
  const configuredLogsRoot = environment[config.logsRootEnv]?.trim();
  if (configuredLogsRoot && !isAbsolute(configuredLogsRoot)) {
    throw new FleetConfigError(`${config.logsRootEnv} must be an absolute path`);
  }
  const logsRoot = configuredLogsRoot || resolve(fleetWorkspaceRoot, "../logs");
  const binary = environment.SYMPHONY_BIN?.trim() || config.defaultBinary;

  return selectRepositories(config, repositoryIds).map((repository) => {
    const repositoryLogsRoot = resolve(logsRoot, repository.id);
    return {
      id: repository.id,
      repository: repository.repository,
      logsRoot: repositoryLogsRoot,
      port: repository.port,
      workspaceRoot: resolve(fleetWorkspaceRoot, repository.workspace),
      workspaceRootEnv: config.workspaceRootEnv,
      command: [
        binary,
        resolve(root, repository.workflow),
        "--port",
        String(repository.port),
        "--logs-root",
        repositoryLogsRoot,
      ],
    };
  });
}

/** Build a child environment without leaking JavaScript undefined values to spawn. */
export function buildChildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  spec: LaunchSpec,
): Record<string, string> {
  const childEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) childEnvironment[key] = value;
  }
  childEnvironment[spec.workspaceRootEnv] = spec.workspaceRoot;
  return childEnvironment;
}

/** Render a reviewable launch plan without requiring auth, Codex, or Symphony. */
export function renderLaunchPlan(
  config: FleetConfig,
  root: string,
  repositoryIds: readonly string[] = [],
): string {
  const repositories = selectRepositories(config, repositoryIds);
  const lines = [
    `fleet workspace root: $${config.workspaceRootEnv}`,
    `logs root: $${config.logsRootEnv} (optional; defaults beside the fleet workspace root)`,
    `binary: \${SYMPHONY_BIN:-${config.defaultBinary}}`,
    "",
  ];
  for (const repository of repositories) {
    lines.push(
      `[${repository.id}] ${repository.repository}`,
      `  workflow: ${resolve(root, repository.workflow)}`,
      `  port: ${repository.port}`,
      `  child $${config.workspaceRootEnv}: $${config.workspaceRootEnv}/${repository.workspace}`,
      `  logs: $${config.logsRootEnv}/${repository.id}`,
    );
  }
  return lines.join("\n");
}

function processEnvironment(): Record<string, string | undefined> {
  return { ...process.env };
}

/** Start selected long-running Symphony processes and shut down the fleet together. */
export async function runFleet(
  specs: readonly LaunchSpec[],
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  if (specs.length === 0) throw new FleetConfigError("cannot run an empty Symphony fleet");
  for (const spec of specs) {
    await mkdir(spec.logsRoot, { recursive: true });
    await mkdir(spec.workspaceRoot, { recursive: true });
  }

  const children = specs.map((spec) => {
    console.log(`starting ${spec.id} (${spec.repository}) on port ${spec.port}`);
    return Bun.spawn([...spec.command], {
      cwd: root,
      env: buildChildEnvironment(environment, spec),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
  });

  let stopping = false;
  const stopChildren = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      try {
        child.kill(signal);
      } catch {
        // A process may have exited between Promise.race and shutdown.
      }
    }
  };
  const onInterrupt = (): void => stopChildren("SIGINT");
  const onTerminate = (): void => stopChildren("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    const firstExit = await Promise.race(
      children.map(async (child, index) => ({ index, code: await child.exited })),
    );
    const spec = specs[firstExit.index];
    console.error(`${spec?.id ?? "unknown"} exited with code ${firstExit.code}; stopping fleet`);
    stopChildren("SIGTERM");
    await Promise.allSettled(children.map((child) => child.exited));
    return firstExit.code === 0 ? 1 : firstExit.code;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

async function main(): Promise<void> {
  const arguments_ = parseCliArguments(process.argv.slice(2));
  const config = await loadFleet();
  await validateFleet(config);

  if (arguments_.command === "validate") {
    selectRepositories(config, arguments_.repositoryIds);
    const count = arguments_.repositoryIds.length || config.repositories.length;
    console.log(`validated ${count} workflow(s)`);
    return;
  }
  if (arguments_.command === "print") {
    console.log(renderLaunchPlan(config, REPO_ROOT, arguments_.repositoryIds));
    return;
  }

  const environment = processEnvironment();
  const missing = findMissingPrerequisites(config, environment, Bun.which);
  if (missing.length > 0) {
    throw new FleetConfigError(`missing run prerequisites: ${missing.join(", ")}`);
  }
  const specs = buildLaunchSpecs(config, REPO_ROOT, environment, arguments_.repositoryIds);
  process.exitCode = await runFleet(specs, REPO_ROOT, environment);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`symphony-fleet: ${message}`);
    process.exitCode = 1;
  });
}
