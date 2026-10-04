import { expect, test } from "bun:test";
import {
  legacyAuditSnapshot,
  rejectLegacyAuditWrites,
  seedLegacyAudit,
} from "./audit-retirement-fixture";
import { disruptionFixture, START } from "./disruption-fixture";
import { createOrganizerSession } from "./organizer-fixture";

const one = { scope: "team", targetTeamIds: [] as string[] };

test("key-only organizers retain disruption attribution and reset revokes new requests", async () => {
  const f = await disruptionFixture({ keyOnly: true });
  try {
    seedLegacyAudit(f.store);
    rejectLegacyAuditWrites(f.store);
    const legacy = legacyAuditSnapshot(f.store);
    expect((await f.fire()).status).toBe(202);
    const accepted = f.service.disruptions.store.request(f.event.eventId, "fixture-request-1");
    expect(accepted?.firedBy).toBe("host-key");
    expect(accepted?.acceptedAudit).toBeUndefined();
    expect((await f.fire()).status).toBe(202);
    await f.tick();
    expect(f.aws.commands).toHaveLength(2);
    const replacement = f.store.rotateLocalOrganizerKey();
    expect((await f.fire({ requestId: "revoked-session-request" })).status).toBe(401);
    expect(
      f.service.disruptions.store.request(f.event.eventId, "revoked-session-request"),
    ).toBeUndefined();
    const login = await f.api("/host/login", "POST", { key: replacement }, "");
    expect(login.status).toBe(200);
    const history = await f.api(`${f.path}/audit`, "GET", undefined, login.body.idToken);
    expect(history.status).toBe(200);
    expect(history.body.items[0]?.firedBy).toBe("host-key");
    expect(legacyAuditSnapshot(f.store)).toEqual(legacy);
    expect(f.aws.commands).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("disruption reads keep role boundaries and accepting organizer attribution", async () => {
  const f = await disruptionFixture();
  try {
    seedLegacyAudit(f.store);
    rejectLegacyAuditWrites(f.store);
    const legacy = legacyAuditSnapshot(f.store);
    const operator = await createOrganizerSession(
      f.service,
      f.token,
      "disruption-operator",
      "Operator",
    );
    const viewer = await createOrganizerSession(f.service, f.token, "disruption-viewer", "Viewer");
    expect((await f.api(f.path, "GET", undefined, viewer.token)).status).toBe(200);
    expect((await f.api(`${f.path}/audit`, "GET", undefined, viewer.token)).status).toBe(200);
    expect(
      (
        await f.api(
          `${f.path}/fire`,
          "POST",
          {
            problemId: f.problem.problemId,
            disruptionId: "frontend-down",
            scope: "all",
            requestId: "viewer-cannot-fire",
          },
          viewer.token,
        )
      ).status,
    ).toBe(403);
    f.aws.timeoutNext = true;
    f.aws.invisible = true;
    const accepted = await f.api(
      `${f.path}/fire`,
      "POST",
      {
        problemId: f.problem.problemId,
        disruptionId: "frontend-down",
        scope: "team",
        targetTeamIds: [f.teams[0]?.teamId],
        requestId: "operator-audited-request",
      },
      operator.token,
    );
    expect(accepted.status).toBe(202);
    const acceptingUser = f.store.organizerByUsername("disruption-operator");
    if (!acceptingUser) throw new Error("Missing accepting organizer");
    const acceptedRequest = f.service.disruptions.store.request(
      f.event.eventId,
      "operator-audited-request",
    );
    expect(acceptedRequest?.firedBy).toBe(acceptingUser.id);
    expect(acceptedRequest?.acceptedAudit).toBeUndefined();
    await f.tick();
    expect(f.rows()[0]?.status).toBe("inject_unknown");
    expect(
      (
        await f.api(
          `${f.path}/recurring/operator-audited-request/cancel`,
          "POST",
          {},
          operator.token,
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.api(`/host/users/${acceptingUser.id}`, "PATCH", { role: "Viewer" })).status,
    ).toBe(200);
    f.aws.invisible = false;
    await f.tick();
    expect(f.rows()[0]?.status).toBe("revert_due");
    const history = (await f.api(`${f.path}/audit`)).body;
    expect(history.items[0]?.firedBy).toBe(acceptingUser.id);
    expect(history.items[0]?.cancelled).toBe(true);
    expect((await f.api("/admin/audit-log")).status).toBe(404);
    expect(legacyAuditSnapshot(f.store)).toEqual(legacy);
  } finally {
    await f.close();
  }
});

test("disruption acceptance stays atomic and retired audit storage cannot block dispatch or cleanup", async () => {
  const f = await disruptionFixture();
  try {
    seedLegacyAudit(f.store);
    rejectLegacyAuditWrites(f.store);
    const legacy = legacyAuditSnapshot(f.store);
    f.store.database.exec(
      "CREATE TRIGGER reject_execution BEFORE INSERT ON host_disruption_executions BEGIN SELECT RAISE(ABORT, 'test execution persistence failure'); END;",
    );
    expect((await f.fire()).status).toBe(500);
    expect(f.rows()).toHaveLength(0);
    expect(f.service.disruptions.store.requests(f.event.eventId)).toHaveLength(0);
    expect(f.aws.commands).toHaveLength(0);
    f.store.database.exec("DROP TRIGGER reject_execution");
    expect((await f.fire()).status).toBe(202);
    await f.tick();
    expect(f.rows().every((row) => row.status === "revert_due")).toBe(true);
    expect(f.aws.commands).toHaveLength(2);
    expect((await f.api(`${f.path}/recurring/fixture-request-1/cancel`, "POST", {})).status).toBe(
      200,
    );
    expect(
      f.service.disruptions.store.request(f.event.eventId, "fixture-request-1")?.cancelled,
    ).toBe(true);
    f.advance(600_000);
    await f.tick();
    expect(f.rows().every((row) => row.status === "revert_command_completed")).toBe(true);
    expect(legacyAuditSnapshot(f.store)).toEqual(legacy);
  } finally {
    await f.close();
  }
});

test("old accepted audit metadata is preserved but never owns disruption recovery", async () => {
  const f = await disruptionFixture();
  try {
    seedLegacyAudit(f.store);
    rejectLegacyAuditWrites(f.store);
    const legacy = legacyAuditSnapshot(f.store);
    expect((await f.fire()).status).toBe(202);
    const request = f.service.disruptions.store.request(f.event.eventId, "fixture-request-1");
    if (!request) throw new Error("Missing request");
    expect(request.acceptedAudit).toBeUndefined();
    const retained = {
      operationId: "00000000-0000-4000-8000-000000000003",
      actor: { kind: "host-key", role: "Admin", authMethod: "host-key" },
      action: "disruption.requested",
      resource: { kind: "event", id: f.event.eventId },
    };
    f.service.disruptions.store.putRequest({ ...request, acceptedAudit: retained });
    await f.tick();
    await f.restart();
    expect((await f.api(`${f.path}/recurring/fixture-request-1/cancel`, "POST", {})).status).toBe(
      200,
    );
    f.advance(600_000);
    await f.tick();
    expect(f.rows().every((row) => row.status === "revert_command_completed")).toBe(true);
    expect(
      f.service.disruptions.store.request(f.event.eventId, "fixture-request-1")?.acceptedAudit,
    ).toEqual(retained);
    expect(legacyAuditSnapshot(f.store)).toEqual(legacy);
  } finally {
    await f.close();
  }
});

test("HTTP accepts a real pinned declaration, records outcomes and isolates admin access", async () => {
  const f = await disruptionFixture();
  try {
    expect((await f.api(f.path)).body.entries[0].disruption.id).toBe("frontend-down");
    expect((await f.api(f.path, "GET", undefined, f.teams[0]?.loginKey)).status).toBe(401);
    expect((await f.fire({ targetRef: "forged" })).status).toBe(400);
    expect((await f.fire()).status).toBe(202);
    expect((await f.fire()).body.status).toBe("accepted");
    expect(f.rows()).toHaveLength(2);
    expect((await f.fire({ scope: "random-n", randomCount: 1 })).status).toBe(409);
    await f.tick();
    expect(f.aws.commands).toHaveLength(2);
    expect(f.rows().every((row) => row.status === "revert_due")).toBe(true);
    f.advance(600_000);
    await f.tick();
    expect(f.rows().every((row) => row.status === "revert_command_completed")).toBe(true);
    await f.tick();
    expect(f.aws.commands).toHaveLength(4);
    expect(f.aws.attempts.every((attempts) => attempts === 1)).toBe(true);
    expect(f.aws.externalIds.every((value) => value === "fixture-required-external-id")).toBe(true);
    const history = (await f.api(`${f.path}/audit`)).body;
    expect(history.items[0].executions[0].reason).toContain("health has not been verified");
    expect(JSON.stringify(history)).not.toContain("fixture-secret");
    expect(JSON.stringify(history)).not.toContain("systemctl");
  } finally {
    await f.close();
  }
});

test("timed-out inject applies later: never revert first or claim recovery before late effect finishes", async () => {
  const f = await disruptionFixture();
  try {
    f.aws.timeoutNext = true;
    f.aws.injectDelay = 700_000;
    f.aws.invisible = true;
    await f.fire({ ...one, targetTeamIds: [f.teams[0]?.teamId] });
    await f.tick();
    expect(f.rows()[0]?.status).toBe("inject_unknown");
    f.advance(600_000);
    await f.restart();
    await f.tick();
    expect(f.aws.commands).toHaveLength(1);
    expect(f.rows()[0]?.status).toBe("inject_unknown");
    f.advance(100_000);
    expect([...f.aws.running.values()]).toEqual([false]);
    f.aws.invisible = false;
    await f.tick();
    expect(f.aws.commands).toHaveLength(2);
    await f.tick();
    expect([...f.aws.running.values()]).toEqual([true]);
    expect(f.rows()[0]?.status).toBe("revert_command_completed");
  } finally {
    await f.close();
  }
});

test("scheduled requests retain random selection, skip outage backlog, and cancel future ticks", async () => {
  const f = await disruptionFixture();
  try {
    const body = {
      scope: "random-n",
      randomCount: 1,
      timing: "recurring",
      intervalMinutes: 1,
      maxFires: 3,
    };
    const first = await f.fire(body);
    expect((await f.fire(body)).body.affectedTeamIds).toEqual(first.body.affectedTeamIds);
    expect(f.rows().map((row) => row.dueAt)).toEqual([
      START + 60_000,
      START + 120_000,
      START + 180_000,
    ]);
    f.advance(125_000);
    await f.restart();
    await f.tick();
    expect(f.rows().map((row) => row.status)).toEqual(["skipped", "skipped", "queued"]);
    expect(f.aws.commands).toHaveLength(0);
    expect((await f.api(`${f.path}/recurring/fixture-request-1/cancel`, "POST", {})).status).toBe(
      200,
    );
    f.advance(60_000);
    await f.tick();
    expect(f.rows().every((row) => row.status === "skipped")).toBe(true);
    expect(f.aws.commands).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("same-resource conflicts skip; end/cancel race after STS rejects injection and keeps cleanup", async () => {
  const f = await disruptionFixture();
  try {
    await f.fire();
    await f.tick();
    await f.fire({ requestId: "overlapping-request" });
    await f.tick();
    expect(f.rows().filter((row) => row.status === "skipped")).toHaveLength(2);
    f.store.putEvent({ ...f.event, status: "ENDED" });
    f.advance(600_000);
    await f.tick();
    expect(f.rows().filter((row) => row.status === "revert_command_completed")).toHaveLength(2);
    f.store.putEvent(f.event);
    await f.fire({ requestId: "end-race-request" });
    f.aws.beforeSend = () => f.store.putEvent({ ...f.event, status: "ENDED" });
    await f.tick();
    expect(f.aws.commands).toHaveLength(4);
    expect(
      f
        .rows()
        .filter((row) => row.requestId === "end-race-request")
        .every((row) => row.status === "failed" || row.status === "skipped"),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("replacement generation is never targeted by old cleanup", async () => {
  const f = await disruptionFixture();
  try {
    await f.fire({ ...one, targetTeamIds: [f.teams[0]?.teamId] });
    await f.tick();
    const job = f.store.jobs(f.event.eventId)[0];
    if (!job) throw new Error("missing fixture job");
    f.store.putJob({
      ...job,
      unit: job.unit?.replace("stack/fixture/0", "stack/replacement/new") ?? null,
      deployedAt: START + 1,
    });
    f.advance(600_000);
    await f.tick();
    expect(f.rows()[0]?.status).toBe("recovery_required");
    expect(f.aws.commands).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("no-action and unused Lambda declarations fail honestly without accepted executions", async () => {
  const f = await disruptionFixture();
  try {
    for (const action of [
      undefined,
      {
        kind: "lambda-invoke",
        functionRef: "LambdaArn",
        targetRef: "LambdaArn",
        revert: { afterSeconds: 60, paramTemplate: {} },
      },
    ]) {
      const problem = {
        ...f.problem,
        definition: JSON.stringify({
          kind: "cloudformation",
          disruptions: [
            {
              id: "frontend-down",
              name: "Unsupported",
              eventDetailType: "DisruptionFired",
              action,
            },
          ],
        }),
      };
      f.store.putEvent({ ...f.event, problems: [problem] });
      expect((await f.fire()).status).toBe(422);
      expect(f.rows()).toHaveLength(0);
    }
  } finally {
    await f.close();
  }
});

test("crash before send keeps intent unknown, without automatic reinjection", async () => {
  const f = await disruptionFixture();
  try {
    await f.fire({ ...one, targetTeamIds: [f.teams[0]?.teamId] });
    const row = f.rows()[0];
    if (!row) throw new Error("missing request");
    f.service.disruptions.store.putExecution({
      ...row,
      status: "injecting",
      inject: { key: `tc-disrupt-${row.id}-i`, sentAt: START },
      revertAt: START + 600_000,
    });
    await f.restart();
    f.advance(700_000);
    await f.tick();
    expect(f.aws.commands).toHaveLength(0);
    expect(f.rows()[0]?.status).toBe("inject_unknown");
  } finally {
    await f.close();
  }
});

test("crash after send before response save discovers the original; interrupted revert is not repeated", async () => {
  const f = await disruptionFixture();
  try {
    await f.fire({ ...one, targetTeamIds: [f.teams[0]?.teamId] });
    await f.tick();
    const row = f.rows()[0];
    if (!row || !("inject" in row)) throw new Error("missing injection");
    f.service.disruptions.store.putExecution({
      ...row,
      status: "injecting",
      inject: { key: row.inject.key, sentAt: row.inject.sentAt },
    });
    await f.restart();
    f.advance(600_000);
    await f.tick();
    const reverted = f.rows()[0];
    if (!reverted || !("revert" in reverted) || !reverted.revert) throw new Error("missing revert");
    f.service.disruptions.store.putExecution({
      ...reverted,
      status: "reverting",
      revert: { key: reverted.revert.key, sentAt: reverted.revert.sentAt },
    });
    await f.restart();
    await f.tick();
    await f.tick();
    expect(f.rows()[0]?.status).toBe("revert_command_completed");
    expect(f.aws.commands).toHaveLength(2);
    expect([...f.aws.running.values()]).toEqual([true]);
  } finally {
    await f.close();
  }
});

test("SSM discovery binds target, document, parameters and time as well as comment", async () => {
  const f = await disruptionFixture();
  try {
    f.aws.timeoutNext = true;
    f.aws.invisible = true;
    await f.fire({ ...one, targetTeamIds: [f.teams[0]?.teamId] });
    await f.tick();
    const original = f.aws.commands[0];
    if (!original) throw new Error("missing command");
    f.aws.invisible = false;
    for (const override of [
      { InstanceIds: ["i-fffffffffffffffff"] },
      { DocumentName: "ForeignDocument" },
      { Parameters: { commands: ["foreign command"] } },
      { RequestedDateTime: new Date(START - 60_000) },
    ]) {
      f.aws.commands = [{ ...original, ...override }];
      await f.tick();
      expect(f.rows()[0]?.status).toBe("inject_unknown");
    }
    f.aws.commands = [original, { ...original, CommandId: "duplicate-command" }];
    await f.tick();
    expect(f.rows()[0]?.status).toBe("inject_unknown");
    f.aws.commands = [original];
    await f.tick();
    expect(f.rows()[0]?.status).toBe("revert_due");
  } finally {
    await f.close();
  }
});

test("cancellation after the role exchange prevents send; cancellation after inject retains revert", async () => {
  const f = await disruptionFixture();
  try {
    await f.fire({ ...one, targetTeamIds: [f.teams[0]?.teamId] });
    f.aws.beforeSend = () => {
      const row = f.service.disruptions.store.request(f.event.eventId, "fixture-request-1");
      if (row) f.service.disruptions.store.putRequest({ ...row, cancelled: true });
    };
    await f.tick();
    expect(f.aws.commands).toHaveLength(0);
    expect(f.aws.destroyed).toBe(1);
    await f.fire({ ...one, targetTeamIds: [f.teams[0]?.teamId], requestId: "cancel-after-inject" });
    await f.tick();
    await f.api(`${f.path}/recurring/cancel-after-inject/cancel`, "POST", {});
    f.advance(600_000);
    await f.tick();
    expect(f.rows().find((row) => row.requestId === "cancel-after-inject")?.status).toBe(
      "revert_command_completed",
    );
    expect(f.aws.commands).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("score trigger latch and queued executions commit or roll back with the causal score", async () => {
  const f = await disruptionFixture();
  try {
    const original = JSON.parse(f.problem.definition);
    const definition = JSON.stringify({
      ...original,
      disruptions: original.disruptions.map((entry: object) => ({
        ...entry,
        triggers: [{ kind: "team-score-above", threshold: 10 }],
      })),
    });
    const event = { ...f.event, problems: [{ ...f.problem, definition }] };
    f.store.putEvent(event);
    for (const job of f.store.jobs(event.eventId)) f.store.putJob({ ...job, definition });
    const team = f.teams[0];
    if (!team) throw new Error("missing team");
    expect(() =>
      f.store.transaction(() => {
        f.store.putTeam({ ...team, score: 11 });
        f.service.disruptions.captureTriggers(event);
        throw new Error("causal update rolled back");
      }),
    ).toThrow("causal update rolled back");
    expect(f.store.team(team.teamId).score).toBe(0);
    expect(f.rows()).toHaveLength(0);
    f.store.transaction(() => {
      f.store.putTeam({ ...team, score: 11 });
      f.service.disruptions.captureTriggers(event);
    });
    expect(f.rows()).toHaveLength(1);
    await f.restart();
    f.store.transaction(() => f.service.disruptions.captureTriggers(event));
    expect(f.rows()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("after-deploy and phase triggers use pinned successful deploy time and visibly skip late injection", async () => {
  const f = await disruptionFixture();
  try {
    const original = JSON.parse(f.problem.definition);
    const declaration = original.disruptions[0];
    const definition = JSON.stringify({
      ...original,
      phases: [{ name: "attack", afterMinutes: 1 }],
      disruptions: [
        { ...declaration, id: "after", triggers: [{ kind: "after-deploy", afterMinutes: 1 }] },
        { ...declaration, id: "phase", triggers: [{ kind: "phase-entered", phaseName: "attack" }] },
      ],
    });
    const event = { ...f.event, problems: [{ ...f.problem, definition }] };
    f.store.putEvent(event);
    for (const job of f.store.jobs(event.eventId)) f.store.putJob({ ...job, definition });
    await f.tick();
    expect(f.rows()).toHaveLength(0);
    f.advance(100_000);
    await f.restart();
    await f.tick();
    expect(f.rows()).toHaveLength(4);
    expect(f.rows().every((row) => row.dueAt === START + 60_000 && row.status === "skipped")).toBe(
      true,
    );
    expect(f.aws.commands).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("reconfigured problem metadata cannot retarget an existing deployment or roll back its score", async () => {
  const f = await disruptionFixture();
  try {
    const original = JSON.parse(f.problem.definition);
    const definition = JSON.stringify({
      ...original,
      disruptions: original.disruptions.map((entry: object) => ({
        ...entry,
        triggers: [{ kind: "team-score-above", threshold: 10 }],
      })),
    });
    const event = { ...f.event, problems: [{ ...f.problem, definition }] };
    const team = f.teams[0];
    if (!team) throw new Error("missing fixture team");
    f.store.putEvent(event);
    f.store.transaction(() => {
      f.store.putTeam({ ...team, score: 11 });
      f.service.disruptions.captureTriggers(event);
    });
    expect(f.store.team(team.teamId).score).toBe(11);
    expect(f.rows()).toHaveLength(0);
    expect((await f.fire()).status).toBe(409);
  } finally {
    await f.close();
  }
});
