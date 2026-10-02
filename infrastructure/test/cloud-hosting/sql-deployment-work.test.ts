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
