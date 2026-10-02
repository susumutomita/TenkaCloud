import { expect, test } from "bun:test";
import { disruptionFixture, START } from "./disruption-fixture";
import { createOrganizerSession } from "./organizer-fixture";

const one = { scope: "team", targetTeamIds: [] as string[] };

test("key-only organizers retain disruption attribution and reset revokes new requests", async () => {
  const f = await disruptionFixture({ keyOnly: true });
  try {
    expect((await f.api("/feature-flags", "PUT", { key: "audit", enabled: true })).status).toBe(
      200,
    );
    expect((await f.fire()).status).toBe(202);
    const accepted = f.service.disruptions.store.request(f.event.eventId, "fixture-request-1");
    expect(accepted?.firedBy).toBe("host-key");
    expect(accepted?.acceptedAudit?.actor).toEqual({
      kind: "host-key",
      role: "Admin",
      authMethod: "host-key",
    });
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
    expect(f.aws.commands).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("disruption reads use read permission while requests retain the accepting organizer and operation", async () => {
  const f = await disruptionFixture();
  try {
    expect((await f.api("/feature-flags", "PUT", { key: "audit", enabled: true })).status).toBe(
      200,
    );
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
    const acceptedOperation = f.service.disruptions.store.request(
      f.event.eventId,
      "operator-audited-request",
    )?.acceptedAudit;
    expect(acceptedOperation?.actor).toMatchObject({ kind: "organizer", role: "Operator" });
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
    if (acceptedOperation?.actor.kind !== "organizer") throw new Error("Missing accepting actor");
    expect(
      (await f.api(`/host/users/${acceptedOperation.actor.userId}`, "PATCH", { role: "Viewer" }))
        .status,
    ).toBe(200);
    f.aws.invisible = false;
    await f.tick();
    const records = (await f.api("/admin/audit-log")).body.items as {
      action: string;
      actor: string;
      operationId: string;
      outcome: string;
      phase: string;
    }[];
    const disruption = records.filter(
      (row) =>
        (row.action === "disruption.requested" || row.action === "disruption.operation") &&
        row.outcome !== "denied",
    );
    expect(
      records.some((row) => row.action === "disruption.requested" && row.outcome === "denied"),
    ).toBe(true);
    expect(
      disruption.some((row) => row.action === "disruption.requested" && row.outcome === "accepted"),
    ).toBe(true);
    expect(
      disruption.some((row) => row.action === "disruption.operation" && row.outcome === "unknown"),
    ).toBe(true);
    expect(
      disruption.some(
        (row) => row.action === "disruption.operation" && row.outcome === "succeeded",
      ),
    ).toBe(true);
    expect(disruption.every((row) => row.operationId === acceptedOperation?.operationId)).toBe(
      true,
    );
    expect(
      disruption.every(
        (row) =>
          row.actor ===
          (acceptedOperation?.actor.kind === "organizer" ? acceptedOperation.actor.userId : ""),
      ),
    ).toBe(true);
    const afterCancel = (await f.api("/admin/audit-log")).body.items as {
      action: string;
      actor: string;
      outcome: string;
    }[];
    expect(
      afterCancel.some(
        (row) =>
          row.action === "disruption.cancelled" &&
          row.outcome === "succeeded" &&
          row.actor ===
            (acceptedOperation?.actor.kind === "organizer" ? acceptedOperation.actor.userId : ""),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("audit storage failure prevents disruption dispatch, while optional result records never block runtime state", async () => {
  const f = await disruptionFixture();
  try {
    expect((await f.api("/feature-flags", "PUT", { key: "audit", enabled: true })).status).toBe(
      200,
    );
    f.store.database.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(FAIL, 'audit rejected'); END;",
    );
    expect((await f.fire()).status).toBe(503);
    expect(f.rows()).toHaveLength(0);
    expect(f.aws.commands).toHaveLength(0);
    f.store.database.exec("DROP TRIGGER reject_audit");
    expect((await f.fire()).status).toBe(202);
    f.store.database.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(FAIL, 'audit rejected'); END;",
    );
    expect((await f.api(`${f.path}/recurring/fixture-request-1/cancel`, "POST", {})).status).toBe(
      503,
    );
    expect(
      f.service.disruptions.store.request(f.event.eventId, "fixture-request-1")?.cancelled,
    ).toBe(false);
    await f.tick();
    expect(f.rows().every((row) => row.status === "revert_due")).toBe(true);
    expect(f.aws.commands).toHaveLength(2);
    f.store.database.exec("DROP TRIGGER reject_audit");
    const collection = (await f.api("/admin/audit-log")).body.collection as { missed: number };
    expect(collection.missed).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

test("requests accepted with audit off never gain result records when audit is enabled later", async () => {
  const f = await disruptionFixture();
  try {
    expect((await f.fire()).status).toBe(202);
    expect(
      f.service.disruptions.store.request(f.event.eventId, "fixture-request-1")?.acceptedAudit,
    ).toBeUndefined();
    expect((await f.api("/feature-flags", "PUT", { key: "audit", enabled: true })).status).toBe(
      200,
    );
    await f.tick();
    const records = (await f.api("/admin/audit-log")).body.items as { action: string }[];
    expect(records.filter((row) => row.action.startsWith("disruption."))).toEqual([]);
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
