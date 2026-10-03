import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { assertComposePolicy } from "./container/compose-policy";
import { PROBLEM_SECRET_FILE } from "./container/problem-secrets";
import type { DockerDefinition } from "./docker-catalog";
import { DockerHostingEngine } from "./docker-engine";
import { hasDatabaseState, prepareDatabase, privateDirectory } from "./files";
import { localJobDescription, localRuntimeFailure } from "./local-runtime-report";
import { definitionKind, type HostedEvent, type Job, type SqlDatabase } from "./model";
import { parseOptions } from "./options";
import { removeRuntimeFiles } from "./runtime-directory";
import { HostStore } from "./store";

// Child rows first. Settings, organizer identities/sessions, and account connections are retained.
const HISTORY_TABLES = [
  "host_disruption_executions",
  "host_disruption_requests",
  "host_audit_pending_jobs",
  "host_audit_records",
  "host_audit_status",
  "host_registration_claims",
  "host_registrations",
  "host_problem_completions",
  "host_uptime_observations",
  "host_uptime_endpoints",
  "host_uptime_state",
  "host_notifications",
  "host_requests",
  "host_coordination",
  "host_jobs",
  "host_teams",
  "host_events",
] as const;
const RETAINED_TABLES = [
  "host_schema",
  "host_settings",
  "host_sessions",
  "host_accounts",
  "host_organizer_users",
  "host_organizer_identities",
  "host_saml_config",
  "host_saml_pending",
  "host_saml_request_cache",
  "host_saml_assertions",
  "host_saml_receipts",
  "sqlite_sequence",
];

export interface LocalClearIo {
  write(message: string): void;
  confirm(question: string): Promise<boolean>;
}

const localClearIo: LocalClearIo = {
  write: console.log,
  async confirm(question) {
    if (!process.stdin.isTTY || process.env.CI)
      throw new Error(
        "History clearing requires an interactive terminal, or explicit --yes after reviewing --plan.",
      );
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^(y|yes)$/iu.test((await reader.question(question)).trim());
    } finally {
      reader.close();
    }
  },
};

export function parseLocalClearOptions(args: string[], root: string) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      data: { type: "string" },
      plan: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    ...values,
    directory: parseOptions(values.data ? ["--data", values.data] : [], root, {
      ...process.env,
      TENKACLOUD_HOST_REQUIRE_PUBLIC: undefined,
    }).dataDirectory,
  };
}

function rows<T>(database: SqlDatabase, sql: string): T[] {
  const statement = database.prepare(sql);
  try {
    return statement.all() as T[];
  } finally {
    statement.finalize?.();
  }
}

function tables(database: SqlDatabase): Set<string> {
  // Production schemas use foreign keys, never triggers. A trigger on a history table
  // could delete organizer/settings rows even when every table name is recognized.
  if (rows<unknown>(database, "SELECT 1 FROM sqlite_master WHERE type='trigger' LIMIT 1").length)
    throw new Error("Unexpected database trigger; refusing to clear history or retained settings.");
  const result = new Set(
    rows<{ name: string }>(database, "SELECT name FROM sqlite_master WHERE type='table'").map(
      (row) => row.name,
    ),
  );
  const known = new Set<string>([...HISTORY_TABLES, ...RETAINED_TABLES]);
  if ([...result].some((name) => !known.has(name)))
    throw new Error(
      "Unknown database tables; refusing to clear history without a reviewed cleanup plan.",
    );
  return result;
}

function historyPlan(database: SqlDatabase) {
  const present = tables(database);
  const fingerprint = createHash("sha256");
  for (const table of HISTORY_TABLES) {
    const values = present.has(table)
      ? rows<unknown>(database, `SELECT * FROM ${table} ORDER BY rowid`)
      : [];
    fingerprint.update(JSON.stringify(values));
  }
  const events = rows<{ body: string }>(database, "SELECT body FROM host_events ORDER BY id").map(
    (row) => JSON.parse(row.body) as HostedEvent,
  );
  const jobs = rows<{ body: string }>(database, "SELECT body FROM host_jobs ORDER BY id").map(
    (row) => JSON.parse(row.body) as Job,
  );
  const teams =
    rows<{ count: number }>(database, "SELECT count(*) AS count FROM host_teams")[0]?.count ?? 0;
  for (const job of jobs) {
    const kind = definitionKind(job.definition);
    if (kind === "cloudformation" && job.unit !== null)
      throw new Error(
        `AWS ownership remains for job ${JSON.stringify(job.jobId)}; use the reviewed cloud cleanup workflow before clearing local history.`,
      );
    if (!/^[A-Za-z0-9_-]+$/u.test(job.jobId))
      throw new Error("Unsafe runtime job ID; history retained.");
  }
  return { events, jobs, teams, fingerprint: fingerprint.digest("hex") };
}

function safeRuntimeFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error(`Unsafe runtime file ${JSON.stringify(path)}; history retained.`);
}

interface RuntimeDirectory {
  readonly jobId: string;
  readonly legacy: boolean;
  readonly files: readonly string[];
}

function verifyLegacyRemainder(path: string, job: Job): void {
  // Failed startup rolled back Docker and cleared its unit before recording FAILED.
  // A crash, retry or teardown can leave that same seed-only remainder in these states.
  const states: readonly Job["status"][] = ["FAILED", "PENDING", "IN_PROGRESS", "DELETING"];
  const definition = JSON.parse(job.definition) as DockerDefinition;
  if (
    !states.includes(job.status) ||
    definition.problem?.problemId !== job.problemId ||
    typeof definition.composeText !== "string" ||
    typeof definition.problem.problemDir !== "string" ||
    typeof definition.problem.composePath !== "string"
  )
    throw new Error(
      `Unverified legacy runtime directory ${JSON.stringify(path)}; history retained.`,
    );
  assertComposePolicy(definition.composeText, definition.problem);
}

function inspectRuntimeDirectory(directory: string, job: Job): RuntimeDirectory {
  const path = privateDirectory(join(directory, "runtimes", job.jobId));
  const marker = join(path, ".tenkacloud-runtime-owner");
  const legacy = !lstatSync(marker, { throwIfNoEntry: false });
  // Preserve established DELETED/unit-backed cleanup; verify only the new rollback states.
  const verifyRemainder = legacy && job.unit === null && job.status !== "DELETED";
  const allowed = new Set([PROBLEM_SECRET_FILE]);
  if (!legacy) {
    safeRuntimeFile(marker);
    if (readFileSync(marker, "utf8") !== `tenkacloud-runtime-v1:${job.jobId}\n`)
      throw new Error(`Runtime ownership changed for ${JSON.stringify(path)}; history retained.`);
    allowed.add(".tenkacloud-runtime-owner");
  } else if (verifyRemainder) verifyLegacyRemainder(path, job);
  // Old teardown and successful startup rollback removed Compose but retained the seed.
  // Other unmarked directories need a durable unit, validated in full by engine.stop.
  if (!legacy || job.unit !== null) allowed.add(`tch-${job.jobId.toLowerCase()}.compose.yml`);
  const files = readdirSync(path).sort((left, right) => left.localeCompare(right));
  for (const file of files) {
    if (!allowed.has(file))
      throw new Error(
        `Unknown runtime file ${JSON.stringify(join(path, file))}; history retained.`,
      );
    safeRuntimeFile(join(path, file));
    if (
      verifyRemainder &&
      file === PROBLEM_SECRET_FILE &&
      !/^[0-9a-f]{64}\n$/u.test(readFileSync(join(path, file), "utf8"))
    )
      throw new Error(
        `Unverified legacy runtime seed ${JSON.stringify(join(path, file))}; history retained.`,
      );
  }
  return { jobId: job.jobId, legacy, files };
}

/** Recognize only marked files or the exact retained legacy job layout; never adopt a directory. */
function runtimeDirectories(directory: string, jobs: readonly Job[]): RuntimeDirectory[] {
  const parent = join(directory, "runtimes");
  if (!lstatSync(parent, { throwIfNoEntry: false })) return [];
  privateDirectory(parent);
  return readdirSync(parent)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const job = jobs.find(
        (candidate) =>
          candidate.jobId === name && definitionKind(candidate.definition) === "compose",
      );
      if (!job)
        throw new Error(
          `Untracked runtime directory ${JSON.stringify(join(parent, name))}; history retained.`,
        );
      return inspectRuntimeDirectory(directory, job);
    });
}

function removeLegacyRuntimeFiles(directory: string, job: Job): void {
  const path = join(directory, "runtimes", job.jobId);
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  const current = inspectRuntimeDirectory(directory, job);
  // engine.stop alone may remove the verified Compose file. Never remove an
  // unverified replacement here, or retrofit a marker to gain deletion authority.
  if (!current.legacy || current.files.some((name) => name !== PROBLEM_SECRET_FILE))
    throw new Error(
      `Legacy runtime cleanup changed for ${JSON.stringify(path)}; history retained.`,
    );
  if (current.files.includes(PROBLEM_SECRET_FILE)) unlinkSync(join(path, PROBLEM_SECRET_FILE));
  rmdirSync(path); // Empty only. The DELETED job/history remains if file cleanup fails.
}

async function removeOwnedJobs(
  store: HostStore,
  owned: Job[],
  engine: Pick<DockerHostingEngine, "stop"> | undefined,
  io: LocalClearIo,
): Promise<void> {
  let failed = 0;
  for (const job of owned) {
    try {
      await engine?.stop(job);
      // Record each successful removal immediately. A partial failure can safely retry.
      store.putJob({
        ...job,
        unit: null,
        status: "DELETED",
        operation: undefined,
        error: undefined,
        resumeAfterLocalDown: undefined,
      });
    } catch (error) {
      failed++;
      io.write(
        `Cleanup failed: ${localJobDescription(job)}; ${localRuntimeFailure(error)}. Ownership and history retained.`,
      );
    }
  }
  if (failed)
    throw new Error(
      `${String(failed)} owned Docker environments could not be removed; all event/history rows are retained. Retry local-clear after resolving the reported failures.`,
    );
}

function announceRuntimeDirectories(
  directory: string,
  directories: RuntimeDirectory[],
  io: LocalClearIo,
): void {
  for (const runtime of directories) {
    const path = join(directory, "runtimes", runtime.jobId);
    io.write(
      `Remove ${runtime.legacy ? "legacy" : "owned"} generated runtime directory: ${JSON.stringify(path)}`,
    );
    for (const file of runtime.files)
      io.write(`  Remove file: ${JSON.stringify(join(path, file))}`);
  }
}

function removeGeneratedRuntimeFiles(
  directory: string,
  directories: RuntimeDirectory[],
  store: HostStore,
): void {
  for (const target of directories) {
    const runtime = join(directory, "runtimes", target.jobId);
    if (!lstatSync(runtime, { throwIfNoEntry: false })) continue;
    if (target.legacy) removeLegacyRuntimeFiles(directory, store.job(target.jobId));
    else
      removeRuntimeFiles(
        directory,
        target.jobId,
        join(runtime, `tch-${target.jobId.toLowerCase()}.compose.yml`),
      );
  }
}

/** Caller holds the stopped controller lock; this function never starts a host or asks for a key. */
export async function clearLocalHistory(
  root: string,
  directory: string,
  options: { plan: boolean; yes: boolean },
  io: LocalClearIo = localClearIo,
  createEngine: () => Pick<DockerHostingEngine, "stop"> = () =>
    new DockerHostingEngine(root, directory),
): Promise<void> {
  const path = join(directory, "hosting.sqlite");
  if (!hasDatabaseState(path)) throw new Error("No existing local host database to clear.");
  const preview = new Database(path, { readonly: true, strict: true });
  let plan: ReturnType<typeof historyPlan>;
  try {
    plan = historyPlan(preview);
  } finally {
    preview.close();
  }
  const plannedDirectories = runtimeDirectories(directory, plan.jobs);
  io.write(
    `Local history database: ${JSON.stringify(path)} (database file and organizer access retained)`,
  );
  io.write(
    `Delete ${String(plan.events.length)} events, ${String(plan.teams)} teams, ${String(plan.jobs.length)} jobs, participant keys, scores, snapshots, submissions, registration, audit, uptime and disruption history.`,
  );
  for (const event of plan.events)
    io.write(`Event ${JSON.stringify(event.eventId)}: ${JSON.stringify(event.name)}`);
  for (const job of plan.jobs.filter(
    (job) => definitionKind(job.definition) === "compose" && job.unit !== null,
  ))
    io.write(`Remove owned Docker environment: ${localJobDescription(job)}`);
  announceRuntimeDirectories(directory, plannedDirectories, io);
  io.write(
    `Compose down --volumes removes the listed projects' containers, writable layers, volumes and networks, including unfinished work. Generated Compose plans and problem seeds in ${JSON.stringify(join(directory, "runtimes"))} are removed only when owned. Organizer keys, settings, account connections, installed problems and cached plugin code are retained. This cannot be undone without a backup.`,
  );
  if (options.plan) return;
  if (
    !options.yes &&
    !(await io.confirm("Clear this local history and owned Docker data? [y/N] "))
  ) {
    io.write("Cancelled; local history and Docker data are unchanged.");
    return;
  }
  prepareDatabase(path);
  const store = new HostStore(new Database(path, { strict: true }));
  try {
    const current = historyPlan(store.database);
    if (JSON.stringify(current) !== JSON.stringify(plan))
      throw new Error(
        "Local state changed while confirming; inspect the new plan and retry. History retained.",
      );
    const directories = runtimeDirectories(directory, current.jobs);
    if (JSON.stringify(directories) !== JSON.stringify(plannedDirectories))
      throw new Error(
        "Runtime file targets changed while confirming; review the new plan and retry. History retained.",
      );
    const owned = current.jobs.filter(
      (job) => definitionKind(job.definition) === "compose" && job.unit !== null,
    );
    const engine = owned.length ? createEngine() : undefined;
    await removeOwnedJobs(store, owned, engine, io);
    removeGeneratedRuntimeFiles(directory, directories, store);
    const present = tables(store.database);
    store.transaction(() => {
      for (const table of HISTORY_TABLES)
        if (present.has(table)) store.database.exec(`DELETE FROM ${table}`);
    });
    io.write(
      "Local event history and owned Docker work data cleared. Organizer access and settings retained. Run make local to create a new event.",
    );
  } finally {
    store.close();
  }
}
