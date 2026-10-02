import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import {
  contentDigest,
  type DeploymentIdentity,
  type DeploymentJob,
  deploymentStackName,
  flagDigest,
} from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../../lib/problem-deploy/control-data/libsql-executor.js";
import { SqlDeploymentWork } from "../../lib/problem-deploy/control-data/sql-deployment-work.js";
import type { SqlExecutor } from "../../lib/problem-deploy/control-data/sql-port.js";
import { sqliteFixture } from "./sql-fixture.js";
import { sqlHttpFixture } from "./sql-http-fixture.js";

const NOW = Date.parse("2026-10-01T09:00:00.000Z");
const AT = new Date(NOW).toISOString();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(path?: string) {
  const f = sqliteFixture(path);
  cleanups.push(f.close);
  const event: EventRecord = {
    eventId: ulid(),
    name: "Synthetic",
    status: "READY",
    teamCount: 1,
    problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    startsAt: AT,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: NOW / 1000 + 86400,
  };
  const team: TeamRecord = {
    eventId: event.eventId,
    teamId: ulid(),
    internalSlug: "one",
    teamLoginKey: "A".repeat(43),
    authVersion: 1,
    accessRevoked: false,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: event.expiresAt,
  };
  const job: DeploymentJob = {
    jobId: ulid(),
    eventId: event.eventId,
    teamId: team.teamId,
    problemId: "hello-world",
    region: "us-east-1",
    awsAccountId: "123456789012",
    status: "PENDING",
    expiresAt: event.expiresAt,
    score: 0,
    attempt: 1,
    revision: 0,
    createdAt: AT,
    updatedAt: AT,
    stackName: deploymentStackName(event.eventId, team.teamId, "hello-world"),
    problemDir: "problems/challenges/hello-world",
    artifactDigest: contentDigest("synthetic-template"),
    parameters: { NamePrefix: "fixture" },
    connection: {
      eventId: event.eventId,
      teamId: team.teamId,
      accountId: "123456789012",
      region: "us-east-1",
      roleArn: "arn:aws:iam::123456789012:role/Fixture",
      externalIdParameter: "arn:aws:ssm:us-east-1:123456789012:parameter/tenkacloud/fixture",
      version: 1,
      verifiedAt: AT,
    },
    scoring: { kind: "flag", points: 100, flagOutputKey: "PrivateFlag", wrongPenalty: 5 },
  };
  f.db.prepare("INSERT INTO cloud_events VALUES (?, ?)").run(event.eventId, JSON.stringify(event));
  f.db
    .prepare("INSERT INTO cloud_teams VALUES (?, ?, ?)")
    .run(event.eventId, team.teamId, JSON.stringify(team));
  f.db
    .prepare("INSERT INTO cloud_connections VALUES (?, ?, ?)")
    .run(event.eventId, team.teamId, JSON.stringify(job.connection));
  const work = new SqlDeploymentWork(f.sql);
  const accept = {
    event,
    team,
    job,
    requestKey: "deploy-1",
    requestHash: contentDigest("request"),
    now: NOW,
  };
  const flag = {
    event,
    team,
    jobId: job.jobId,
    attempt: 1,
    requestKey: "flag-1",
    flag: "correct",
    now: NOW,
  };
  const reference = {
    stackId: `arn:aws:cloudformation:us-east-1:123456789012:stack/${job.stackName}/original`,
    fingerprint: contentDigest("immutable-input"),
  };
  return { ...f, work, event, team, job, accept, flag, reference };
}
function interleave(sql: SqlExecutor, action: () => void): SqlExecutor {
  let pending = true;
  return {
    ...sql,
    batch: async (statements) => {
      if (pending) {
        pending = false;
        action();
      }
      return sql.batch(statements);
    },
  };
}
async function complete(f: ReturnType<typeof fixture>, owner = "worker") {
  await f.work.accept(f.accept);
  await f.work.begin(f.job, owner, AT);
  await f.work.reserveCreation(f.job, owner, NOW);
  await f.work.recordCreation(f.job, owner, f.reference);
  await f.work.finish(
    f.job,
    owner,
    {
      status: "COMPLETE",
      stackId: f.reference.stackId,
      flagDigest: flagDigest("correct"),
      publicOutputs: { Website: "https://example.invalid" },
    },
    AT,
  );
  const job = await f.work.getJob(f.job.jobId);
  if (!job) throw new Error("Missing completed fixture");
  return job;
}
async function close(f: ReturnType<typeof fixture>) {
  await f.work.closeEvent(f.event, AT);
  await f.work.setTeardownExpected(f.event.eventId, 1);
}
function deletion(job: DeploymentIdentity, generation = 1): DeploymentIdentity {
  return { ...job, operation: "delete", generation };
}
async function retryFailedCreation(f: ReturnType<typeof fixture>) {
  await f.work.accept(f.accept);
  await f.work.begin(f.job, "worker", AT);
  await f.work.reserveCreation(f.job, "worker", NOW);
  await f.work.recordCreation(f.job, "worker", f.reference);
  await f.work.finish(
    f.job,
    "worker",
    { status: "FAILED", failureReason: "stack failed", stackId: f.reference.stackId },
    AT,
  );
  const second = { ...f.job, attempt: 2 };
  await f.work.accept({ ...f.accept, job: second, retryOf: 1, requestKey: "retry" });
  return second;
}

describe("native SQL deployment transactions", () => {
  it("persists acceptance receipts and immutable dispatch across repository/process restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenkacloud-work-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "control.db");
    const f = fixture(path);
    expect(await f.work.accept(f.accept)).toEqual({
      kind: "accepted",
      jobId: f.job.jobId,
      attempt: 1,
    });
    const second = sqliteFixture(path);
    cleanups.push(second.close);
    const restarted = new SqlDeploymentWork(second.sql);
    expect(await restarted.accept(f.accept)).toEqual({
      kind: "replay",
      jobId: f.job.jobId,
      attempt: 1,
    });
    expect(await restarted.getTarget(f.event.eventId, f.team.teamId, f.job.problemId)).toEqual(
      f.job,
    );
    expect(await restarted.listDispatch()).toHaveLength(1);
    expect(await restarted.getCreation(f.job)).toMatchObject({
      state: "NOT_STARTED",
      leaseUntil: 0,
    });
    await expect(restarted.accept({ ...f.accept, requestHash: "changed" })).rejects.toThrow(
      "idempotency_key_reused",
    );
  });
  it("serializes concurrent acceptance and rolls back a competing target in full", async () => {
    const f = fixture();
    const results = await Promise.all([
      f.work.accept(f.accept),
      new SqlDeploymentWork(f.sql).accept(f.accept),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["accepted", "replay"]);
    const other = { ...f.job, jobId: ulid() };
    await expect(f.work.accept({ ...f.accept, job: other, requestKey: "other" })).rejects.toThrow(
      "deployment_acceptance_conflict",
    );
    expect(await f.work.getJob(other.jobId)).toBeUndefined();
    expect(await f.work.getCreation(other)).toBeUndefined();
    expect(await f.sql.all("SELECT * FROM cloud_deployment_receipts")).toHaveLength(1);
  });
  it.each(["team", "event", "connection", "installation"])(
    "rechecks %s changes inside acceptance's write transaction",
    async (kind) => {
      const f = fixture();
      const work = new SqlDeploymentWork(
        interleave(f.sql, () => {
          if (kind === "team")
            f.db.exec("UPDATE cloud_teams SET payload = json_set(payload, '$.authVersion', 2)");
          if (kind === "event")
            f.db.exec(
              "UPDATE cloud_events SET payload = json_set(payload, '$.status', 'TEARDOWN')",
            );
          if (kind === "connection")
            f.db.exec("UPDATE cloud_connections SET payload = json_set(payload, '$.version', 2)");
          if (kind === "installation")
            f.db.exec("INSERT INTO cloud_installation_control VALUES (1, '{}')");
        }),
      );
      await expect(work.accept(f.accept)).rejects.toThrow("deployment_acceptance_conflict");
      for (const table of [
        "cloud_deployments",
        "cloud_deployment_targets",
        "cloud_deployment_receipts",
        "cloud_dispatch",
        "cloud_creations",
        "cloud_team_scores",
      ])
        expect(await f.sql.all(`SELECT * FROM ${table}`)).toEqual([]);
    },
  );
  it("preserves owner, lease, stack and completion digest fences", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    expect(await f.work.begin(f.job, "worker", AT)).toBe("started");
    expect(await f.work.begin(f.job, "worker", AT)).toBe("replay");
    await expect(f.work.begin(f.job, "rival", AT)).rejects.toThrow("deployment_claim_conflict");
    await f.work.reserveCreation(f.job, "worker", NOW);
    expect(await f.work.getCreation(f.job)).toMatchObject({
      state: "REQUESTED",
      owner: "worker",
      leaseUntil: NOW + 120000,
    });
    await expect(f.work.reserveCreation(f.job, "rival", NOW)).rejects.toThrow(
      "creation_owner_changed",
    );
    await f.work.recordCreation(f.job, "worker", f.reference);
    await expect(
      f.work.recordCreation(f.job, "worker", {
        ...f.reference,
        fingerprint: contentDigest("changed"),
      }),
    ).rejects.toThrow("creation_receipt_changed");
    const result = {
      status: "COMPLETE" as const,
      stackId: f.reference.stackId,
      flagDigest: flagDigest("correct"),
    };
    expect(await f.work.finish(f.job, "worker", result, AT)).toBe("updated");
    expect(await f.work.finish(f.job, "worker", result, AT)).toBe("replay");
    await expect(
      f.work.finish(f.job, "worker", { ...result, flagDigest: flagDigest("changed") }, AT),
    ).rejects.toThrow("completion_payload_changed");
    expect(await f.work.listDispatch()).toEqual([]);
  });
  it("blocks new creation after closing, while allowing the already sent creation receipt", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    await f.work.begin(f.job, "worker", AT);
    await f.work.reserveCreation(f.job, "worker", NOW);
    await close(f);
    await expect(f.work.reserveCreation(f.job, "worker", NOW + 1)).rejects.toThrow(
      "creation_closed_or_owner_changed",
    );
    await f.work.recordCreation(f.job, "worker", f.reference);
    expect(await f.work.getCreation(f.job)).toMatchObject({
      state: "ACKNOWLEDGED",
      stackId: f.reference.stackId,
    });
  });
  it("atomically scores concurrent correct flags once and persists replay + ledger + team projection", async () => {
    const f = fixture();
    await complete(f);
    const outcomes = await Promise.all([
      f.work.submitFlag(f.flag),
      new SqlDeploymentWork(f.sql).submitFlag({ ...f.flag, requestKey: "flag-2" }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["already_scored", "ok"]);
    expect(await f.work.submitFlag(f.flag)).toEqual(outcomes[0]);
    const score = await f.sql.get("SELECT payload FROM cloud_team_scores");
    expect(JSON.parse(String(score?.payload))).toMatchObject({ score: 100, completedProblems: 1 });
    expect(await f.work.listScoreEvents(f.event.eventId, f.team.teamId)).toEqual([
      {
        jobId: f.job.jobId,
        problemId: f.job.problemId,
        points: 100,
        source: "flag",
        result: "ok",
        occurredAt: AT,
      },
    ]);
    expect(await f.sql.all("SELECT * FROM cloud_deployment_receipts")).toHaveLength(3);
  });
  it("rolls back score and receipt when a late ledger uniqueness condition fails", async () => {
    const f = fixture();
    await complete(f);
    await f.sql.run("INSERT INTO cloud_score_events VALUES (?, ?, ?, ?, ?, ?)", [
      f.job.jobId,
      contentDigest(f.flag.requestKey),
      f.event.eventId,
      f.team.teamId,
      AT,
      "{}",
    ]);
    await expect(f.work.submitFlag(f.flag)).rejects.toThrow("scoring_scope_or_access_changed");
    expect(await f.work.getJob(f.job.jobId)).toMatchObject({ score: 0, revision: 0 });
    expect(await f.sql.all("SELECT * FROM cloud_deployment_receipts")).toHaveLength(1);
    expect(
      JSON.parse(String((await f.sql.get("SELECT payload FROM cloud_team_scores"))?.payload)),
    ).toMatchObject({ score: 0, completedProblems: 0 });
  });
  it("rechecks scoring authorization both on a new flag and on receipt replay", async () => {
    const f = fixture();
    await complete(f);
    await f.work.submitFlag(f.flag);
    await f.sql.run(
      "UPDATE cloud_teams SET payload = json_set(payload, '$.accessRevoked', json('true'))",
    );
    await expect(f.work.submitFlag(f.flag)).rejects.toThrow("scoring_scope_or_access_changed");
    await expect(f.work.submitFlag({ ...f.flag, requestKey: "another" })).rejects.toThrow(
      "scoring_scope_or_access_changed",
    );
  });
  it("atomically rechecks participant release against current auth, target and acknowledged stack", async () => {
    const f = fixture();
    const job = await complete(f);
    const input = {
      event: f.event,
      team: f.team,
      job,
      fingerprint: f.reference.fingerprint,
      now: NOW,
    };
    await f.work.assertParticipantAccessCurrent(input);
    const work = new SqlDeploymentWork(
      interleave(f.sql, () =>
        f.db.exec(
          "UPDATE cloud_creations SET payload = json_set(payload, '$.fingerprint', 'changed')",
        ),
      ),
    );
    await expect(work.assertParticipantAccessCurrent(input)).rejects.toThrow(
      "participant_access_changed",
    );
  });
  it("propagates database/transport errors instead of reporting a conditional conflict", async () => {
    const f = fixture();
    const error = new Error("transport disconnected");
    const sql = {
      ...f.sql,
      batch: () => {
        throw error;
      },
    };
    await expect(new SqlDeploymentWork(sql).accept(f.accept)).rejects.toBe(error);
  });
});

describe("SQL historical teardown and generation fences", () => {
  it("cancels a never-started target, completes the event exactly once and archives it", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    await close(f);
    expect(await f.work.requestTeardown(f.job, AT)).toBe("enqueued");
    expect(await f.work.requestTeardown(f.job, AT)).toBe("skipped");
    expect(await f.work.getJob(f.job.jobId)).toMatchObject({
      status: "DELETED",
      teardownStatus: "DELETED",
    });
    expect(await f.work.listDispatch()).toEqual([]);
    const event = JSON.parse(
      String((await f.sql.get("SELECT payload FROM cloud_events"))?.payload),
    );
    expect(event).toMatchObject({ status: "ARCHIVED", teardownExpected: 1, teardownCompleted: 1 });
  });
  it("preserves failed attempt history and proves pristine historical attempts before dispatching current cleanup", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    await f.work.failPending(f.job, "artifact missing", AT);
    const second = { ...f.job, attempt: 2 };
    await f.work.accept({ ...f.accept, job: second, retryOf: 1, requestKey: "retry" });
    await close(f);
    expect(await f.work.requestTeardown(second, AT)).toBe("enqueued");
    expect(await f.work.getTeardown(second)).toMatchObject({
      status: "PENDING",
      historyExpected: 1,
      historyCompleted: 1,
    });
    expect(await f.work.getTeardown(f.job)).toMatchObject({ status: "DELETED", parentAttempt: 2 });
    expect(await f.work.listDispatch(25, { deletesOnly: true })).toMatchObject([
      { attempt: 2, generation: 1, operation: "delete" },
    ]);
    const identity = deletion(second);
    await f.work.beginTeardown(identity, "cleanup", AT);
    expect(await f.work.prepareDeletion(identity, "cleanup", NOW)).toBe(true);
    expect(await f.work.finishTeardown(identity, "cleanup", { status: "DELETED" }, AT)).toBe(
      "updated",
    );
    expect(await f.work.finishTeardown(identity, "cleanup", { status: "DELETED" }, AT)).toBe(
      "replay",
    );
    expect(
      JSON.parse(String((await f.sql.get("SELECT payload FROM cloud_events"))?.payload)),
    ).toMatchObject({ status: "ARCHIVED", teardownCompleted: 1 });
  });
  it("waits for a creation lease, cleans older account resources and releases root only once", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    await f.work.begin(f.job, "worker", AT);
    await f.work.reserveCreation(f.job, "worker", NOW);
    await f.work.recordCreation(f.job, "worker", f.reference);
    await f.work.finish(
      f.job,
      "worker",
      { status: "FAILED", failureReason: "stack failed", stackId: f.reference.stackId },
      AT,
    );
    const second = { ...f.job, attempt: 2 };
    await f.work.accept({ ...f.accept, job: second, retryOf: 1, requestKey: "retry" });
    await close(f);
    await f.work.requestTeardown(second, AT);
    expect(await f.work.getTeardown(second)).toMatchObject({ historyCompleted: 0 });
    await expect(f.work.beginTeardown(deletion(second), "root", AT)).rejects.toThrow(
      "teardown_history_not_ready",
    );
    const historical = deletion(f.job);
    await f.work.beginTeardown(historical, "cleanup", AT);
    expect(await f.work.prepareDeletion(historical, "cleanup", NOW + 1000)).toBe(false);
    expect(await f.work.prepareDeletion(historical, "cleanup", NOW + 120001)).toBe(true);
    await f.work.recordTeardownReference(historical, "cleanup", f.reference);
    expect(
      await f.work.finishTeardown(
        historical,
        "cleanup",
        { status: "DELETED", stackId: f.reference.stackId },
        AT,
      ),
    ).toBe("updated");
    expect(
      await f.work.finishTeardown(
        historical,
        "cleanup",
        { status: "DELETED", stackId: f.reference.stackId },
        AT,
      ),
    ).toBe("replay");
    expect(await f.work.getTeardown(second)).toMatchObject({ historyCompleted: 1 });
    expect(await f.work.listDispatch(25, { deletesOnly: true })).toMatchObject([{ attempt: 2 }]);
    expect((await f.work.getDeletionJob(f.job)).job).toMatchObject({
      status: "FAILED",
      attempt: 1,
      stackId: f.reference.stackId,
    });
  });
  it("resumes failed cleanup with a new generation while stale owners cannot finish", async () => {
    const f = fixture();
    await complete(f);
    await close(f);
    await f.work.requestTeardown(f.job, AT);
    const first = deletion(f.job);
    await f.work.beginTeardown(first, "first", AT);
    await f.work.prepareDeletion(first, "first", NOW + 120001);
    await f.work.recordTeardownReference(first, "first", f.reference);
    await f.work.finishTeardown(
      first,
      "first",
      { status: "FAILED", failureReason: "AWS busy" },
      AT,
    );
    await f.work.requestTeardown(f.job, AT);
    await expect(f.work.finishTeardown(first, "first", { status: "DELETED" }, AT)).rejects.toThrow(
      "teardown_scope_or_generation_changed",
    );
    const second = deletion(f.job, 2);
    await f.work.beginTeardown(second, "second", AT);
    await f.work.prepareDeletion(second, "second", NOW + 120001);
    await f.work.finishTeardown(
      second,
      "second",
      { status: "DELETED", stackId: f.reference.stackId },
      AT,
    );
    expect(
      JSON.parse(String((await f.sql.get("SELECT payload FROM cloud_events"))?.payload)),
    ).toMatchObject({ status: "ARCHIVED", teardownCompleted: 1 });
  });
  it("keeps unknown remote creation an explicit cleanup blocker", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    await f.work.begin(f.job, "worker", AT);
    await f.work.reserveCreation(f.job, "worker", NOW);
    await f.work.finish(
      f.job,
      "worker",
      { status: "FAILED", failureReason: "connection lost" },
      AT,
    );
    await close(f);
    await f.work.requestTeardown(f.job, AT);
    const identity = deletion(f.job);
    await f.work.beginTeardown(identity, "cleanup", AT);
    await f.work.prepareDeletion(identity, "cleanup", NOW + 120001);
    await expect(
      f.work.finishTeardown(identity, "cleanup", { status: "DELETED" }, AT),
    ).rejects.toThrow("teardown_absence_unconfirmed");
    expect(await f.work.getTeardown(identity)).toMatchObject({ status: "IN_PROGRESS" });
  });
});

describe("SQL workflow late races and libSQL production executor", () => {
  it("uses the actual libSQL HTTP client for lifecycle, scoring and conditional rollback", async () => {
    const base = fixture();
    const http = sqlHttpFixture();
    cleanups.push(http.close);
    await initializeControlDataSchema(http.client);
    const sql = new LibsqlExecutor(http.client);
    await sql.run("INSERT INTO cloud_events VALUES (?, ?)", [
      base.event.eventId,
      JSON.stringify(base.event),
    ]);
    await sql.run("INSERT INTO cloud_teams VALUES (?, ?, ?)", [
      base.event.eventId,
      base.team.teamId,
      JSON.stringify(base.team),
    ]);
    await sql.run("INSERT INTO cloud_connections VALUES (?, ?, ?)", [
      base.event.eventId,
      base.team.teamId,
      JSON.stringify(base.job.connection),
    ]);
    const f = { ...base, db: http.db, sql, work: new SqlDeploymentWork(sql) };
    await complete(f);
    expect(await f.work.submitFlag(f.flag)).toEqual({
      kind: "ok",
      scoreDelta: 100,
      totalScore: 100,
    });
    expect(await f.work.submitFlag(f.flag)).toEqual({
      kind: "ok",
      scoreDelta: 100,
      totalScore: 100,
    });
    const other = { ...f.job, jobId: ulid() };
    await expect(
      f.work.accept({ ...f.accept, job: other, requestKey: "duplicate-target" }),
    ).rejects.toThrow("deployment_acceptance_conflict");
    expect(await f.work.getJob(other.jobId)).toBeUndefined();
    expect(http.requests.some((request) => request.type === "batch")).toBe(true);
  });
  it("rechecks the registered competitor revision immediately before acceptance", async () => {
    const f = fixture();
    const registrationId = ulid();
    const record = {
      awsAccountId: f.job.awsAccountId,
      region: f.job.region,
      competitorRoleName: "Fixture",
      verified: true,
      verifiedAt: AT,
      createdAt: AT,
      updatedAt: AT,
      createdBy: "organizer",
      registrationId,
      revision: 2,
    };
    await f.sql.run("INSERT INTO cloud_competitor_accounts VALUES (?, ?)", [
      record.awsAccountId,
      JSON.stringify(record),
    ]);
    const connection = {
      ...f.job.connection,
      registrationId,
      bindingId: `account-${registrationId.toLowerCase()}`,
    };
    await f.sql.run("UPDATE cloud_connections SET payload = ?", [JSON.stringify(connection)]);
    const work = new SqlDeploymentWork(
      interleave(f.sql, () =>
        f.db.exec(
          "UPDATE cloud_competitor_accounts SET payload = json_set(payload, '$.revision', 3, '$.verified', json('false'))",
        ),
      ),
    );
    await expect(work.accept({ ...f.accept, job: { ...f.job, connection } })).rejects.toThrow(
      "deployment_acceptance_conflict",
    );
    expect(await f.work.getJob(f.job.jobId)).toBeUndefined();
  });
  it("rolls back the immutable retry snapshot if the failed source changes", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    await f.work.failPending(f.job, "missing artifact", AT);
    const work = new SqlDeploymentWork(
      interleave(f.sql, () =>
        f.db.exec("UPDATE cloud_deployments SET payload = json_set(payload, '$.revision', 8)"),
      ),
    );
    await expect(
      work.accept({ ...f.accept, job: { ...f.job, attempt: 2 }, retryOf: 1, requestKey: "retry" }),
    ).rejects.toThrow("deployment_acceptance_conflict");
    expect(await f.sql.all("SELECT * FROM cloud_deployment_attempts")).toEqual([]);
    expect(await f.work.getJob(f.job.jobId)).toMatchObject({ attempt: 1, revision: 8 });
  });
  it("checks an expired creation lease again before deleting", async () => {
    const f = fixture();
    await complete(f);
    await close(f);
    await f.work.requestTeardown(f.job, AT);
    const identity = deletion(f.job);
    await f.work.beginTeardown(identity, "cleanup", AT);
    const work = new SqlDeploymentWork(
      interleave(f.sql, () =>
        f.db
          .prepare("UPDATE cloud_creations SET payload = json_set(payload, '$.leaseUntil', ?)")
          .run(NOW + 999999),
      ),
    );
    await expect(work.prepareDeletion(identity, "cleanup", NOW + 120001)).rejects.toThrow(
      "teardown_prepare_conflict",
    );
    expect(await f.work.getJob(f.job.jobId)).toMatchObject({ status: "COMPLETE" });
  });
  it("increments event cleanup once under concurrent terminal delivery", async () => {
    const f = fixture();
    await complete(f);
    await close(f);
    await f.work.requestTeardown(f.job, AT);
    const identity = deletion(f.job);
    await f.work.beginTeardown(identity, "cleanup", AT);
    await f.work.prepareDeletion(identity, "cleanup", NOW + 120001);
    await f.work.recordTeardownReference(identity, "cleanup", f.reference);
    const results = await Promise.all([
      f.work.finishTeardown(identity, "cleanup", { status: "DELETED" }, AT),
      new SqlDeploymentWork(f.sql).finishTeardown(identity, "cleanup", { status: "DELETED" }, AT),
    ]);
    expect(results.sort()).toEqual(["replay", "updated"]);
    expect(
      JSON.parse(String((await f.sql.get("SELECT payload FROM cloud_events"))?.payload)),
    ).toMatchObject({ status: "ARCHIVED", teardownCompleted: 1 });
  });
  it("rejects malformed numeric booleans in a persisted authorization gate", async () => {
    const f = fixture();
    await f.sql.run("UPDATE cloud_teams SET payload = json_set(payload, '$.accessRevoked', 0)");
    await expect(f.work.accept(f.accept)).rejects.toThrow("deployment_acceptance_conflict");
    expect(await f.work.getJob(f.job.jobId)).toBeUndefined();
  });
  it("keeps batch planning idempotent and rejects changes after the first receipt", async () => {
    const f = fixture();
    const plan = { jobs: [f.job.jobId] };
    expect(await f.work.pinRequest(f.event.eventId, "plan", "hash", plan)).toEqual(plan);
    expect(await f.work.pinRequest(f.event.eventId, "plan", "hash", { jobs: [] })).toEqual(plan);
    await expect(f.work.pinRequest(f.event.eventId, "plan", "changed", plan)).rejects.toThrow(
      "idempotency_key_reused",
    );
  });
  it("serializes schedule changes without reopening a closing event", async () => {
    const f = fixture();
    const later = new Date(NOW + 1000).toISOString();
    await f.work.setSchedule(f.event, { scoringLocked: true }, later);
    await expect(f.work.setSchedule(f.event, { scoringLocked: false }, AT)).rejects.toThrow(
      "event_schedule_changed",
    );
    await f.work.closeEvent({ ...f.event, updatedAt: later }, AT);
    await expect(
      f.work.setSchedule({ ...f.event, updatedAt: AT }, { scoringLocked: false }, AT),
    ).rejects.toThrow("event_schedule_changed");
  });
});

describe("SQL connection and participant isolation", () => {
  it("persists connection registration, rejects stale replacement and fences draining installations", async () => {
    const f = fixture();
    await f.sql.run("DELETE FROM cloud_connections");
    expect(await f.work.getConnection(f.event.eventId, f.team.teamId)).toBeUndefined();
    await f.work.saveVerifiedConnection(f.job.connection);
    expect(await f.work.getConnection(f.event.eventId, f.team.teamId)).toEqual(f.job.connection);
    const replacement = { ...f.job.connection, version: 2, region: "us-west-2" };
    await f.work.saveVerifiedConnection(replacement, 1);
    await expect(f.work.saveVerifiedConnection(f.job.connection)).rejects.toThrow(
      "connection_changed",
    );
    await expect(
      f.work.saveVerifiedConnection({ ...replacement, region: "eu-west-1" }, 1),
    ).rejects.toThrow("connection_changed");
    await expect(f.work.saveVerifiedConnection(replacement, 2)).rejects.toThrow(
      "Invalid connection version",
    );
    expect(await f.work.getConnection(f.event.eventId, f.team.teamId)).toEqual(replacement);
    expect(await f.work.acceptingNewDeployments()).toBe(true);
    await f.sql.run("INSERT INTO cloud_installation_control VALUES (1, '{}')");
    expect(await f.work.acceptingNewDeployments()).toBe(false);
    await expect(f.work.saveVerifiedConnection({ ...replacement, version: 3 }, 2)).rejects.toThrow(
      "connection_changed",
    );
    expect(await f.work.getConnection(f.event.eventId, f.team.teamId)).toEqual(replacement);
  });

  it("rejects corrupted deployment, connection, target and creation ownership", async () => {
    const f = fixture();
    expect(await f.work.getTarget(f.event.eventId, f.team.teamId, f.job.problemId)).toBeUndefined();
    await f.work.accept(f.accept);
    await f.sql.run("UPDATE cloud_deployments SET payload = json_set(payload, '$.jobId', ?)", [
      ulid(),
    ]);
    await expect(f.work.getJob(f.job.jobId)).rejects.toThrow("Deployment scope mismatch");
    await f.sql.run("UPDATE cloud_deployments SET payload = ?", [JSON.stringify(f.job)]);
    await f.sql.run("UPDATE cloud_deployment_targets SET attempt = 2");
    await expect(f.work.getTarget(f.event.eventId, f.team.teamId, f.job.problemId)).rejects.toThrow(
      "Corrupt deployment target ownership",
    );
    await f.sql.run("UPDATE cloud_connections SET payload = json_set(payload, '$.teamId', ?)", [
      ulid(),
    ]);
    await expect(f.work.getConnection(f.event.eventId, f.team.teamId)).rejects.toThrow(
      "Connection scope mismatch",
    );
    await f.sql.run("UPDATE cloud_creations SET payload = json_set(payload, '$.eventId', ?)", [
      ulid(),
    ]);
    await expect(f.work.getCreation(f.job)).rejects.toThrow("creation_scope_changed");
    await expect(f.work.begin({ ...f.job, teamId: ulid() }, "worker", AT)).rejects.toThrow(
      "deployment_scope_or_attempt_changed",
    );
  });

  it("keeps invalid initial state and retries from writing receipts or historical attempts", async () => {
    const f = fixture();
    await expect(
      f.work.accept({ ...f.accept, job: { ...f.job, region: "us-west-2" } }),
    ).rejects.toThrow("Invalid deployment acceptance ownership");
    await expect(f.work.accept({ ...f.accept, requestKey: "" })).rejects.toThrow("Request key");
    await expect(
      f.work.accept({ ...f.accept, job: { ...f.job, attempt: 2 }, retryOf: 1 }),
    ).rejects.toThrow("retry_attempt_changed");
    await f.work.accept(f.accept);
    await expect(
      f.work.accept({
        ...f.accept,
        job: { ...f.job, attempt: 2 },
        retryOf: 1,
        requestKey: "retry",
      }),
    ).rejects.toThrow("deployment_acceptance_conflict");
    expect(await f.sql.all("SELECT * FROM cloud_deployment_attempts")).toEqual([]);
    expect(await f.sql.all("SELECT * FROM cloud_deployment_receipts")).toHaveLength(1);
    expect(await f.work.getJob(f.job.jobId)).toEqual(f.job);
  });

  it("denies participant release for mismatched ownership, failed jobs and locked scoring", async () => {
    const f = fixture();
    const job = await complete(f);
    const input = {
      event: f.event,
      team: f.team,
      job,
      fingerprint: f.reference.fingerprint,
      now: NOW,
    };
    for (const change of [
      { team: { ...f.team, teamId: ulid() } },
      { job: { ...job, status: "FAILED" as const } },
      { fingerprint: "invalid" },
      { event: { ...f.event, scoringLocked: true } },
    ])
      await expect(f.work.assertParticipantAccessCurrent({ ...input, ...change })).rejects.toThrow(
        "participant_access_changed",
      );
    expect(await f.work.getJob(f.job.jobId)).toEqual(job);
  });
});

describe("SQL delivery retries and scoring boundaries", () => {
  it("replays a concurrent completion but rejects changed ownership and a late transition", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    await f.work.begin(f.job, "worker", AT);
    const result = { status: "FAILED" as const, failureReason: "artifact unavailable" };
    await expect(f.work.finish(f.job, "other", result, AT)).rejects.toThrow(
      "deployment_owner_changed",
    );
    const outcomes = await Promise.all([
      f.work.finish(f.job, "worker", result, AT),
      new SqlDeploymentWork(f.sql).finish(f.job, "worker", result, AT),
    ]);
    expect(outcomes.sort()).toEqual(["replay", "updated"]);
    await expect(
      f.work.finish(
        f.job,
        "worker",
        { status: "COMPLETE", stackId: f.reference.stackId, flagDigest: flagDigest("correct") },
        AT,
      ),
    ).rejects.toThrow("deployment_transition_conflict");
    expect(await f.work.getJob(f.job.jobId)).toMatchObject(result);
  });

  it("does not let pending-dispatch failure overwrite a claimed deployment", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    await expect(f.work.begin(f.job, "", AT)).rejects.toThrow("immutable workflow owner");
    await expect(f.work.failPending(f.job, "", AT)).rejects.toThrow("bounded failure reason");
    await f.work.begin(f.job, "worker", AT);
    await expect(f.work.failPending(f.job, "late dispatcher failure", AT)).rejects.toThrow(
      "pending_failure_conflict",
    );
    expect(await f.work.getJob(f.job.jobId)).toMatchObject({
      status: "IN_PROGRESS",
      owner: "worker",
    });
  });

  it("records wrong answers once, floors penalties at zero and rejects altered replay payloads", async () => {
    const f = fixture();
    await complete(f);
    const wrong = { ...f.flag, flag: "incorrect" };
    expect(await f.work.submitFlag(wrong)).toEqual({ kind: "wrong", scoreDelta: 0, totalScore: 0 });
    expect(await f.work.submitFlag(wrong)).toEqual({ kind: "wrong", scoreDelta: 0, totalScore: 0 });
    await expect(f.work.submitFlag(f.flag)).rejects.toThrow("idempotency_key_reused");
    expect(await f.work.submitFlag({ ...f.flag, requestKey: "correct", now: NOW + 1000 })).toEqual({
      kind: "ok",
      scoreDelta: 100,
      totalScore: 100,
    });
    expect(await f.work.listScoreEvents(f.event.eventId, f.team.teamId, 1)).toMatchObject([
      { source: "flag", points: 100 },
    ]);
    expect(await f.work.listScoreEvents(f.event.eventId, f.team.teamId)).toMatchObject([
      { source: "flag" },
      { source: "flag-wrong", points: 0 },
    ]);
    expect(await f.work.listScoreEvents(f.event.eventId, ulid())).toEqual([]);
    await f.sql.run("UPDATE cloud_score_events SET payload = json_set(payload, '$.teamId', ?)", [
      ulid(),
    ]);
    await expect(f.work.listScoreEvents(f.event.eventId, f.team.teamId)).rejects.toThrow(
      "Score history ownership mismatch",
    );
  });

  it("rejects invalid, premature and closed scoring without producing receipts", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    await expect(f.work.submitFlag(f.flag)).rejects.toThrow("deployment_not_ready");
    await expect(f.work.submitFlag({ ...f.flag, attempt: 0 })).rejects.toThrow(
      "invalid_scoring_scope_or_request",
    );
    await expect(
      f.work.submitFlag({ ...f.flag, event: { ...f.event, scoringLocked: true } }),
    ).rejects.toThrow("scoring_locked");
    expect(await f.sql.all("SELECT * FROM cloud_score_events")).toEqual([]);
    expect(await f.sql.all("SELECT * FROM cloud_deployment_receipts")).toHaveLength(1);
    await expect(f.work.listScoreEvents(f.event.eventId, f.team.teamId, 101)).rejects.toThrow(
      "Invalid history limit",
    );
    await expect(f.work.listDispatch(0)).rejects.toThrow("Invalid dispatch limit");
  });

  it("pins a concurrent batch winner and bounds its persisted plan size", async () => {
    const f = fixture();
    const plans = [{ jobs: ["one"] }, { jobs: ["two"] }];
    const results = await Promise.all(
      plans.map((plan) =>
        new SqlDeploymentWork(f.sql).pinRequest(f.event.eventId, "batch", "hash", plan),
      ),
    );
    expect(results[0]).toEqual(results[1]);
    expect(plans).toContainEqual(results[0]);
    await expect(
      f.work.pinRequest(f.event.eventId, "oversized", "hash", "界".repeat(45_000)),
    ).rejects.toThrow("Deployment plan exceeds bounds");
    expect(await f.sql.all("SELECT * FROM cloud_deployment_receipts")).toHaveLength(1);
  });

  it("handles a stale event-close delivery without reopening or changing its target count", async () => {
    const f = fixture();
    await f.work.setSchedule(f.event, { scoringLocked: true }, new Date(NOW + 1).toISOString());
    await expect(f.work.closeEvent(f.event, AT)).rejects.toThrow("event_teardown_conflict");
    const current = { ...f.event, updatedAt: new Date(NOW + 1).toISOString() };
    expect(await f.work.closeEvent(current, AT)).toBe("closing");
    expect(await f.work.closeEvent(current, AT)).toBe("closing");
    expect(await f.work.closeEvent({ ...current, status: "TEARDOWN" }, AT)).toBe("closing");
    await f.work.setTeardownExpected(f.event.eventId, 0);
    expect(await f.work.archiveTeardown(f.event.eventId)).toBe(true);
    expect(await f.work.closeEvent(current, AT)).toBe("archived");
    expect(await f.work.closeEvent({ ...current, status: "ARCHIVED" }, AT)).toBe("archived");
    await f.work.setTeardownExpected(f.event.eventId, 0);
    await expect(f.work.setTeardownExpected(f.event.eventId, 1)).rejects.toThrow(
      "teardown_target_set_changed",
    );
    await expect(f.work.setTeardownExpected(f.event.eventId, -1)).rejects.toThrow(
      "Invalid teardown target count",
    );
  });
});

describe("SQL historical cleanup recovery and integrity", () => {
  it("recovers a lost historical dispatch, retries failure and releases current cleanup only after owned history is deleted", async () => {
    const f = fixture();
    const second = await retryFailedCreation(f);
    expect(await f.work.listTargetJobs(f.event.eventId, f.team.teamId)).toMatchObject([
      { attempt: 2 },
    ]);
    expect(await f.work.listTargetJobs(f.event.eventId, ulid())).toEqual([]);
    await close(f);
    await f.work.requestTeardown(second, AT);
    const first = deletion(f.job);
    await f.sql.run("DELETE FROM cloud_dispatch WHERE operation = 'delete'");
    expect(await f.work.requestTeardown(second, AT)).toBe("skipped");
    expect(await f.work.listDispatch(25, { deletesOnly: true })).toMatchObject([
      { attempt: 1, generation: 1 },
    ]);
    expect(
      await f.work.finishTeardown(
        first,
        undefined,
        { status: "FAILED", failureReason: "dispatcher unavailable" },
        AT,
      ),
    ).toBe("updated");
    expect(await f.work.getJob(f.job.jobId)).toMatchObject({
      attempt: 2,
      teardownStatus: "FAILED",
      teardownFailureReason: "historical_attempt_1: dispatcher unavailable",
    });
    expect(await f.work.listDispatch(25, { deletesOnly: true })).toEqual([]);
    expect(await f.work.requestTeardown(second, AT)).toBe("enqueued");
    const retry = deletion(f.job, 2);
    await expect(f.work.beginTeardown(first, "stale", AT)).rejects.toThrow(
      "teardown_scope_or_generation_changed",
    );
    expect(await f.work.beginTeardown(retry, "cleanup", AT)).toBe("started");
    expect(await f.work.beginTeardown(retry, "cleanup", AT)).toBe("replay");
    await expect(f.work.beginTeardown(retry, "other", AT)).rejects.toThrow(
      "teardown_claim_conflict",
    );
    expect(await f.work.prepareDeletion(retry, "cleanup", NOW + 120001)).toBe(true);
    await expect(
      f.work.recordTeardownReference(retry, "cleanup", {
        ...f.reference,
        fingerprint: contentDigest("another-resource"),
      }),
    ).rejects.toThrow("teardown_reference_changed");
    await f.work.recordTeardownReference(retry, "cleanup", f.reference);
    await f.work.finishTeardown(
      retry,
      "cleanup",
      { status: "DELETED", stackId: f.reference.stackId },
      AT,
    );
    expect(
      (await f.work.listDispatch()).filter((intent) => intent.operation === undefined),
    ).toMatchObject([{ jobId: f.job.jobId, attempt: 2, createdAt: AT }]);
    expect(await f.work.requestTeardown(second, AT)).toBe("skipped");
    const root = deletion(second);
    await f.work.beginTeardown(root, "root", AT);
    expect(await f.work.prepareDeletion(root, "root", NOW + 120001)).toBe(true);
    const outcomes = await Promise.all([
      f.work.finishTeardown(root, "root", { status: "DELETED" }, AT),
      new SqlDeploymentWork(f.sql).finishTeardown(root, "root", { status: "DELETED" }, AT),
    ]);
    expect(outcomes.sort()).toEqual(["replay", "updated"]);
    expect(await f.work.finishTeardown(root, "root", { status: "DELETED" }, AT)).toBe("replay");
    expect(await f.work.listDispatch()).toEqual([]);
    expect(
      JSON.parse(String((await f.sql.get("SELECT payload FROM cloud_events"))?.payload)),
    ).toMatchObject({ status: "ARCHIVED", teardownCompleted: 1 });
  });

  it.each(["creation-fingerprint", "cleanup-owner"])(
    "revalidates %s historical proof before deleting the current target",
    async (proof) => {
      const f = fixture();
      const second = await retryFailedCreation(f);
      await close(f);
      await f.work.requestTeardown(second, AT);
      const historical = deletion(f.job);
      await f.work.beginTeardown(historical, "cleanup", AT);
      await f.work.prepareDeletion(historical, "cleanup", NOW + 120001);
      await f.work.recordTeardownReference(historical, "cleanup", f.reference);
      await f.work.finishTeardown(historical, "cleanup", { status: "DELETED" }, AT);
      if (proof === "creation-fingerprint")
        await f.sql.run(
          "UPDATE cloud_creations SET payload = json_set(payload, '$.fingerprint', ?) WHERE attempt = 1",
          [contentDigest("changed-physical-resource")],
        );
      else
        await f.sql.run(
          "UPDATE cloud_teardowns SET payload = json_remove(payload, '$.owner') WHERE source_attempt = 1",
        );
      const root = deletion(second);
      await f.work.beginTeardown(root, "root", AT);
      await expect(f.work.prepareDeletion(root, "root", NOW + 120001)).rejects.toThrow(
        "historical_attempt_resources_unresolved",
      );
      expect(await f.work.getJob(f.job.jobId)).toMatchObject({ attempt: 2, status: "PENDING" });
      expect(
        JSON.parse(String((await f.sql.get("SELECT payload FROM cloud_events"))?.payload)),
      ).toMatchObject({ status: "TEARDOWN", teardownCompleted: 0 });
    },
  );

  it.each(["missing", "malformed", "wrong-team", "wrong-attempt"])(
    "blocks cleanup with %s historical evidence before creating any teardown work",
    async (corruption) => {
      const f = fixture();
      const second = await retryFailedCreation(f);
      if (corruption === "missing") await f.sql.run("DELETE FROM cloud_deployment_attempts");
      if (corruption === "malformed")
        await f.sql.run("UPDATE cloud_deployment_attempts SET payload = '{}'");
      if (corruption === "wrong-team")
        await f.sql.run(
          "UPDATE cloud_deployment_attempts SET payload = json_set(payload, '$.teamId', ?)",
          [ulid()],
        );
      if (corruption === "wrong-attempt")
        await f.sql.run(
          "UPDATE cloud_deployment_attempts SET payload = json_set(payload, '$.attempt', 2)",
        );
      await close(f);
      await expect(f.work.listTargetJobs(f.event.eventId, f.team.teamId)).rejects.toThrow(
        corruption === "missing"
          ? "historical_attempt_history_incomplete"
          : "historical_attempt_record_invalid",
      );
      await expect(f.work.requestTeardown(second, AT)).rejects.toThrow();
      expect(await f.sql.all("SELECT * FROM cloud_teardowns")).toEqual([]);
      expect(await f.work.listDispatch(25, { deletesOnly: true })).toEqual([]);
    },
  );

  it("rejects missing or mismatched historical jobs and teardown parents", async () => {
    const f = fixture();
    const second = await retryFailedCreation(f);
    await expect(f.work.getDeletionJob({ ...f.job, attempt: 3 })).rejects.toThrow(
      "deployment_scope_or_attempt_changed",
    );
    await f.sql.run(
      "UPDATE cloud_deployment_attempts SET payload = json_set(payload, '$.teamId', ?)",
      [ulid()],
    );
    await expect(f.work.getDeletionJob(f.job)).rejects.toThrow("historical_attempt_record_invalid");
    await f.sql.run("UPDATE cloud_deployment_attempts SET payload = ?", [
      JSON.stringify({ ...f.job, status: "FAILED", owner: "worker", stackId: f.reference.stackId }),
    ]);
    await close(f);
    await f.work.requestTeardown(second, AT);
    await f.sql.run(
      "UPDATE cloud_teardowns SET payload = json_set(payload, '$.parentAttempt', 3) WHERE source_attempt = 1",
    );
    await expect(f.work.getTeardown(f.job)).rejects.toThrow("teardown_history_scope_changed");
    await f.sql.run("DELETE FROM cloud_teardowns WHERE source_attempt = 1");
    await expect(f.work.getTeardown(f.job)).rejects.toThrow("teardown_scope_or_generation_changed");
  });

  it("requires teardown identity, owner and immutable resource reference before finishing", async () => {
    const f = fixture();
    await complete(f);
    const identity = deletion(f.job);
    await expect(f.work.beginTeardown(f.job, "cleanup", AT)).rejects.toThrow(
      "invalid_teardown_identity",
    );
    await expect(f.work.beginTeardown(identity, "cleanup", AT)).rejects.toThrow("teardown_missing");
    await close(f);
    await f.work.requestTeardown(f.job, AT);
    await expect(f.work.beginTeardown(identity, "", AT)).rejects.toThrow(
      "immutable teardown owner",
    );
    await f.work.beginTeardown(identity, "cleanup", AT);
    await expect(
      f.work.finishTeardown(identity, undefined, { status: "DELETED" }, AT),
    ).rejects.toThrow("teardown_owner_required");
    await expect(
      f.work.finishTeardown(identity, "cleanup", { status: "FAILED", failureReason: "" }, AT),
    ).rejects.toThrow("bounded teardown failure reason");
    await expect(
      f.work.finishTeardown(identity, "other", { status: "DELETED" }, AT),
    ).rejects.toThrow("teardown_owner_changed");
    await expect(
      f.work.finishTeardown(identity, "cleanup", { status: "DELETED" }, AT),
    ).rejects.toThrow("teardown_not_deleting");
    await expect(f.work.prepareDeletion(identity, "other", NOW + 120001)).rejects.toThrow(
      "teardown_prepare_conflict",
    );
    await f.work.prepareDeletion(identity, "cleanup", NOW + 120001);
    await expect(f.work.recordTeardownReference(identity, "other", f.reference)).rejects.toThrow(
      "teardown_reference_changed",
    );
    await f.work.recordTeardownReference(identity, "cleanup", f.reference);
    await expect(
      f.work.finishTeardown(
        identity,
        "cleanup",
        { status: "DELETED", stackId: `${f.reference.stackId}-other` },
        AT,
      ),
    ).rejects.toThrow("teardown_reference_changed");
    expect(await f.work.getTeardown(identity)).toMatchObject({
      status: "IN_PROGRESS",
      stackId: f.reference.stackId,
    });
  });

  it("rechecks creation and teardown references inside their writes", async () => {
    const f = fixture();
    await f.work.accept(f.accept);
    await f.work.begin(f.job, "worker", AT);
    await f.work.reserveCreation(f.job, "worker", NOW);
    const work = new SqlDeploymentWork(
      interleave(f.sql, () =>
        f.db.exec("UPDATE cloud_creations SET payload = json_set(payload, '$.owner', 'other')"),
      ),
    );
    await expect(work.recordCreation(f.job, "worker", f.reference)).rejects.toThrow(
      "creation_receipt_changed",
    );
    expect(await f.work.getCreation(f.job)).toMatchObject({ state: "REQUESTED", owner: "other" });
    await f.sql.run("UPDATE cloud_creations SET payload = json_set(payload, '$.owner', 'worker')");
    await f.work.recordCreation(f.job, "worker", f.reference);
    await f.work.reserveCreation(f.job, "worker", NOW + 1);
    expect(await f.work.getCreation(f.job)).toMatchObject({
      state: "ACKNOWLEDGED",
      stackId: f.reference.stackId,
      leaseUntil: NOW + 120001,
    });
    await f.work.finish(
      f.job,
      "worker",
      { status: "FAILED", failureReason: "stack failed", stackId: f.reference.stackId },
      AT,
    );
    await close(f);
    await f.work.requestTeardown(f.job, AT);
    const identity = deletion(f.job);
    await f.work.beginTeardown(identity, "cleanup", AT);
    const teardown = new SqlDeploymentWork(
      interleave(f.sql, () =>
        f.db.exec("UPDATE cloud_teardowns SET payload = json_set(payload, '$.owner', 'other')"),
      ),
    );
    await expect(
      teardown.recordTeardownReference(identity, "cleanup", f.reference),
    ).rejects.toThrow("teardown_reference_changed");
    expect(await f.work.getTeardown(identity)).toMatchObject({ owner: "other" });
    expect((await f.work.getTeardown(identity))?.stackId).toBeUndefined();
  });
});
