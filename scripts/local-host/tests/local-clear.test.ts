import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DisruptionStore } from "../disruption-store";
import { clearManagedLocal } from "../local";
import { clearLocalHistory, type LocalClearIo, parseLocalClearOptions } from "../local-clear";
import { localRuntimeFailure } from "../local-runtime-report";
import type { Job } from "../model";
import { prepareRuntimeDirectory } from "../runtime-directory";
import { HostStore } from "../store";
import { createLegacyAuditSchema } from "./audit-retirement-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const f = setup();
  try {
    await run(f);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "tenka-clear-synthetic-"));
  const path = join(directory, "hosting.sqlite");
  const store = new HostStore(new Database(path));
  store.putEvent({
    eventId: "event",
    name: "Synthetic clear",
    status: "READY",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    expiresAt: 2_000_000_000,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [],
  });
  store.putTeam({
    eventId: "event",
    teamId: "team",
    internalSlug: "team",
    displayName: "Team",
    loginKey: "fixture-participant-secret",
    snapshot: "fixture-progress",
    score: 9,
    completedProblems: 1,
    scoreEvents: [],
  });
  store.putCoordination("event", "native", JSON.stringify({ progress: 1 }));
  store.putReceipt("team", "nonce", "fingerprint", 200, { solved: true });
  store.statement("INSERT INTO host_settings VALUES('test-setting', 'keep-setting')").run();
  store.ensureLocalOrganizerKey();
  createLegacyAuditSchema(store);
  store.statement("INSERT INTO host_audit_status(id) VALUES (1)").run();
  const disruptions = new DisruptionStore(store);
  expect(disruptions).toBeDefined();
  store.statement("INSERT INTO host_accounts VALUES('fixture-account', '{}')").run();
  store.database.exec(`
    INSERT INTO host_audit_records(occurred_at,operation_id,phase,actor,action,resource_kind,resource_id,outcome,body)
      VALUES(1,'fixture','request','{}','fixture','event','event','succeeded','{}');
    INSERT INTO host_audit_pending_jobs VALUES('first',1,'{}');
    INSERT INTO host_disruption_requests VALUES('event','fixture','{}');
    INSERT INTO host_disruption_executions VALUES('fixture','event','fixture',0,1,'{}');
  `);
  const auth = store.statement("SELECT * FROM host_settings ORDER BY key").all();
  const jobs: Job[] = ["first", "second"].map((jobId) => ({
    jobId,
    eventId: "event",
    teamId: "team",
    problemId: jobId,
    definition: "{}",
    offset: 0,
    status: "FAILED",
    unit: JSON.stringify({ composeProjectName: `tch-${jobId}` }),
  }));
  for (const job of jobs) store.putJob(job);
  store.close();
  writeFileSync(join(directory, "host-key"), "fixture-retained-private-key", { mode: 0o600 });
  const messages: string[] = [];
  const calls: string[] = [];
  const choice = { yes: true, fail: "" };
  const io: LocalClearIo = {
    write: (value) => messages.push(value),
    confirm: async () => choice.yes,
  };
  const engine = () => ({
    async stop(job: Job) {
      calls.push(job.jobId);
      if (choice.fail === job.jobId)
        throw new Error("Docker daemon is unavailable. fixture-sensitive-value");
    },
  });
  const open = () => new HostStore(new Database(path));
  return { directory, path, auth, jobs, messages, calls, choice, io, engine, open };
}

for (const plan of [false, true]) {
  test(`${plan ? "plan" : "declined confirmation"} retains every row and never touches Docker or exposes keys`, async () =>
    fixture(async (f) => {
      const before = readFileSync(f.path);
      f.choice.yes = false;
      await clearLocalHistory(root, f.directory, { plan, yes: false }, f.io, f.engine);
      expect(f.calls).toEqual([]);
      expect(readFileSync(f.path)).toEqual(before);
      expect(f.messages.join("\n")).toContain(f.path);
      expect(f.messages.join("\n")).toContain("writable layers, volumes and networks");
      expect(f.messages.join("\n")).not.toContain("fixture-participant-secret");
    }));
}

test("confirmed clear removes all event history and generated problem data, retaining organizer access", async () =>
  fixture(async (f) => {
    const directory = prepareRuntimeDirectory(f.directory, "first", true);
    writeFileSync(join(directory, "problem-secrets.key"), "synthetic-seed");
    writeFileSync(join(directory, "tch-first.compose.yml"), "synthetic-compose");
    await clearLocalHistory(root, f.directory, { plan: false, yes: false }, f.io, f.engine);
    expect(f.calls).toEqual(["first", "second"]);
    expect(existsSync(directory)).toBe(false);
    const store = f.open();
    try {
      expect(store.events()).toEqual([]);
      expect(store.statement("SELECT * FROM host_accounts").all()).toHaveLength(1);
      expect(readFileSync(join(f.directory, "host-key"), "utf8")).toBe(
        "fixture-retained-private-key",
      );
      expect(f.messages.join("\n")).not.toContain("fixture-retained-private-key");
      expect(store.jobs()).toEqual([]);
      expect(store.statement("SELECT * FROM host_settings ORDER BY key").all()).toEqual(f.auth);
      for (const table of [
        "host_teams",
        "host_coordination",
        "host_requests",
        "host_audit_records",
        "host_disruption_requests",
        "host_disruption_executions",
        "host_audit_pending_jobs",
      ])
        expect(store.statement(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
          count: 0,
        });
    } finally {
      store.close();
    }
  }));

test("partial teardown failure retains history and failed ownership; retry removes only the failed job", async () =>
  fixture(async (f) => {
    f.choice.fail = "first";
    await expect(
      clearLocalHistory(root, f.directory, { plan: false, yes: true }, f.io, f.engine),
    ).rejects.toThrow("all event/history rows are retained");
    const store = f.open();
    try {
      expect(store.events()).toHaveLength(1);
      expect(store.team("team").score).toBe(9);
      expect(store.job("first").unit).toBe(f.jobs[0]?.unit ?? "missing");
      expect(store.job("second")).toMatchObject({ unit: null, status: "DELETED" });
    } finally {
      store.close();
    }
    expect(f.messages.join("\n")).toContain('job="first" project="tch-first"');
    expect(f.messages.join("\n")).toContain("Start Docker Desktop");
    expect(f.messages.join("\n")).not.toContain("fixture-sensitive-value");
    f.calls.length = 0;
    f.choice.fail = "";
    await clearLocalHistory(root, f.directory, { plan: false, yes: true }, f.io, f.engine);
    expect(f.calls).toEqual(["first"]);
  }));

for (const type of [
  "AWS",
  "unknown table",
  "unknown directory",
  "unowned legacy directory",
  "unknown file",
  "symlink",
] as const) {
  test(`${type} refuses before any teardown and keeps DB tracking`, async () =>
    fixture(async (f) => {
      if (type === "AWS" || type === "unknown table") {
        const store = f.open();
        if (type === "AWS")
          store.putJob({
            ...store.job("first"),
            definition: JSON.stringify({ kind: "cloudformation" }),
          });
        else store.database.exec("CREATE TABLE unknown(value TEXT)");
        store.close();
      } else if (type === "unknown directory") {
        mkdirSync(join(f.directory, "runtimes"), { mode: 0o700 });
        mkdirSync(join(f.directory, "runtimes", "not-our-job"), { mode: 0o700 });
      } else {
        const runtime = prepareRuntimeDirectory(
          f.directory,
          "first",
          type !== "unowned legacy directory",
        );
        if (type === "unowned legacy directory") {
          const store = f.open();
          store.putJob({ ...store.job("first"), unit: null });
          store.close();
        }
        if (type === "unknown file") writeFileSync(join(runtime, "keep-user-file"), "unrelated");
        if (type === "symlink") symlinkSync(f.path, join(runtime, "problem-secrets.key"));
      }
      const before = readFileSync(f.path);
      await expect(
        clearLocalHistory(root, f.directory, { plan: false, yes: true }, f.io, f.engine),
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
      expect(readFileSync(f.path)).toEqual(before);
    }));
}

test("state change during confirmation refuses instead of clearing an unreviewed event", async () =>
  fixture(async (f) => {
    f.io.confirm = async () => {
      const store = f.open();
      store.putEvent({ ...store.event("event"), name: "Changed while confirming" });
      store.close();
      return true;
    };
    await expect(
      clearLocalHistory(root, f.directory, { plan: false, yes: false }, f.io, f.engine),
    ).rejects.toThrow("Local state changed");
    expect(f.calls).toEqual([]);
  }));

test("clear CLI validates options, existing directory, and live owners", async () =>
  fixture(async (f) => {
    expect(parseLocalClearOptions(["--data", f.directory, "--plan"], root)).toMatchObject({
      directory: f.directory,
      plan: true,
      yes: false,
    });
    expect(() => parseLocalClearOptions(["--purge"], root)).toThrow();
    await expect(
      clearManagedLocal(root, ["--data", join(f.directory, "missing"), "--yes"]),
    ).rejects.toThrow("No existing");
    expect(existsSync(join(f.directory, "missing"))).toBe(false);
    writeFileSync(
      join(f.directory, "local-session.json"),
      JSON.stringify({
        protocol: 2,
        pid: process.pid,
        port: 12345,
        token: "a".repeat(43),
        sessionId: "b".repeat(43),
      }),
      { mode: 0o600 },
    );
    await expect(clearManagedLocal(root, ["--data", f.directory, "--yes"])).rejects.toThrow(
      "host is running",
    );
  }));

test("cleanup diagnostics describe safe categories rather than arbitrary retained error content", () => {
  expect(localRuntimeFailure("Docker Compose stop failed (exit 1). fixture-secret")).toBe(
    "Docker Compose stop failed (exit 1)",
  );
  expect(localRuntimeFailure("Recorded runtime composition changed; fixture-secret")).toContain(
    "could not be verified",
  );
  expect(localRuntimeFailure(new Error("arbitrary fixture-secret"))).not.toContain(
    "fixture-secret",
  );
});

test("make local-clear previews, requires explicit noninteractive confirmation, then clears", async () =>
  fixture(async (f) => {
    const store = f.open();
    for (const job of store.jobs()) store.putJob({ ...job, unit: null });
    store.close();
    const command = async (args: string) => {
      const child = Bun.spawn(["make", "local-clear", `LOCAL_ARGS=--data ${f.directory} ${args}`], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code: await child.exited, text: (await output).join("\n") };
    };
    const before = readFileSync(f.path);
    const plan = await command("--plan");
    expect(plan.code).toBe(0);
    expect(plan.text).toContain(f.path);
    expect(readFileSync(f.path)).toEqual(before);
    const refused = await command("");
    expect(refused.code).not.toBe(0);
    expect(refused.text).toContain("interactive terminal");
    expect(readFileSync(f.path)).toEqual(before);
    const cleared = await command("--yes");
    expect(cleared.code).toBe(0);
    expect(cleared.text).toContain("Organizer access and settings retained");
    expect(cleared.text).not.toContain("fixture-participant-secret");
    const after = f.open();
    try {
      expect(after.events()).toEqual([]);
    } finally {
      after.close();
    }
  }));

test("an unexpected history trigger cannot erase retained settings or touch Docker", async () =>
  fixture(async (f) => {
    const database = f.open();
    database.database.exec(`
      CREATE TRIGGER erase_settings AFTER DELETE ON host_events
      BEGIN DELETE FROM host_settings; END;
    `);
    database.close();
    const before = readFileSync(f.path);
    await expect(
      clearLocalHistory(root, f.directory, { plan: false, yes: true }, f.io, f.engine),
    ).rejects.toThrow("Unexpected database trigger");
    expect(f.calls).toEqual([]);
    expect(readFileSync(f.path)).toEqual(before);
    const after = f.open();
    try {
      expect(after.events()).toHaveLength(1);
      expect(after.statement("SELECT * FROM host_settings ORDER BY key").all()).toEqual(f.auth);
    } finally {
      after.close();
    }
  }));

test("a history delete failure rolls back rows while completed Docker removals survive for retry", async () =>
  fixture(async (f) => {
    const database = f.open();
    // Synthetic retained-table FK makes the final event delete fail after child rows
    // were deleted; no trigger or Docker daemon is involved in this rehearsal.
    database.database.exec(`
      ALTER TABLE host_accounts ADD COLUMN protected_event TEXT REFERENCES host_events(id);
      UPDATE host_accounts SET protected_event='event';
    `);
    database.close();
    await expect(
      clearLocalHistory(root, f.directory, { plan: false, yes: true }, f.io, f.engine),
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    expect(f.calls).toEqual(["first", "second"]);
    const after = f.open();
    try {
      expect(after.events()).toHaveLength(1);
      expect(after.team("team").score).toBe(9);
      expect(after.jobs()).toHaveLength(2);
      expect(after.jobs().every((job) => job.unit === null && job.status === "DELETED")).toBe(true);
      for (const table of [
        "host_requests",
        "host_coordination",
        "host_audit_records",
        "host_disruption_requests",
      ])
        expect(after.statement(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
          count: 1,
        });
      expect(after.statement("SELECT * FROM host_settings ORDER BY key").all()).toEqual(f.auth);
      after.database.exec("UPDATE host_accounts SET protected_event=NULL");
    } finally {
      after.close();
    }
    f.calls.length = 0;
    await clearLocalHistory(root, f.directory, { plan: false, yes: true }, f.io, f.engine);
    expect(f.calls).toEqual([]);
    const retried = f.open();
    try {
      expect(retried.events()).toEqual([]);
      expect(retried.jobs()).toEqual([]);
    } finally {
      retried.close();
    }
  }));
