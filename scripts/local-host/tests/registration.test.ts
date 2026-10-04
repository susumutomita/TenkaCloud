import { expect, test } from "bun:test";
import type { RegistrationProgress } from "@tenkacloud/problem-sdk/internal/event-registration";
import { randomToken } from "../auth";
import { digest } from "../store";
import {
  legacyAuditSnapshot,
  rejectLegacyAuditWrites,
  seedLegacyAudit,
} from "./audit-retirement-fixture";
import { type RegistrationSummary, registrationFixture } from "./registration-fixture";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected value");
  return value;
}

test("registration is default off; concurrent claims and retries reserve exactly one ready Battle team", async () => {
  const f = await registrationFixture();
  try {
    const event = await f.create(1);
    expect((await f.open(event)).body).toMatchObject({ error: "feature_disabled" });
    expect((await f.api("admin", "/feature-flags")).body).toEqual({
      flags: {
        saml: false,
        audit: false,
        challengePrerequisiteGate: false,
        registration: false,
      },
    });
    await f.flag(true);
    const opened = await f.open(event),
      invitation = required(opened.body.invitation);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      enabled: true,
      canConfigure: true,
      tenantId: "local-host",
    });
    const receipt = randomToken();
    const repeats = await Promise.all(
      Array.from({ length: 10 }, () =>
        f.public<RegistrationProgress>(event.eventId, "claim", invitation, receipt),
      ),
    );
    expect(repeats.every((r) => r.status === 200)).toBe(true);
    expect(new Set(repeats.map((r) => r.body.teamId)).size).toBe(1);
    expect(repeats[0]?.body.teamLoginKey).toBe(event.teams[0]?.teamLoginKey);
    expect((await f.public(event.eventId, "claim", invitation, randomToken())).body.error).toBe(
      "full",
    );
    expect((await f.public(event.eventId, "info", invitation)).body).toMatchObject({
      state: "full",
      remaining: 0,
    });
    const summary = await f.api<RegistrationSummary>(
      "admin",
      `/events/${event.eventId}/registration`,
    );
    expect(summary.body.claimed).toBe(1);
    expect(summary.body).not.toHaveProperty("invitation");
    const stored =
      JSON.stringify(f.store.statement("SELECT * FROM host_registrations").all()) +
      JSON.stringify(f.store.statement("SELECT * FROM host_registration_claims").all());
    expect(stored).not.toContain(invitation);
    expect(stored).not.toContain(receipt);
    expect(stored).not.toContain(required(event.teams[0]).teamLoginKey);
    expect(stored).toContain(digest(receipt));
  } finally {
    await f.close();
  }
});

test("distinct concurrent receipts cannot take the same last slot and a lost response recovers after real SQLite restart", async () => {
  const f = await registrationFixture();
  try {
    const event = await f.create(1);
    await f.flag(true);
    const invitation = required((await f.open(event)).body.invitation);
    const receipts = Array.from({ length: 8 }, () => randomToken());
    const results = await Promise.all(
      receipts.map((receipt) =>
        f.public<RegistrationProgress>(event.eventId, "claim", invitation, receipt),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const index = results.findIndex((r) => r.status === 200),
      receipt = required(receipts[index]);
    await f.restart();
    expect((await f.public(event.eventId, "status", receipt)).body).toEqual(
      required(results[index]).body,
    );
    expect((await f.public(event.eventId, "claim", invitation, receipt)).body).toEqual(
      required(results[index]).body,
    );
    expect(
      (await f.api<RegistrationSummary>("admin", `/events/${event.eventId}/registration`)).body
        .claimed,
    ).toBe(1);
  } finally {
    await f.close();
  }
});

test("closing and flag OFF stop new claims but preserve receipt delivery and ordinary team access", async () => {
  const f = await registrationFixture();
  try {
    const event = await f.create();
    await f.flag(true);
    let invitation = required((await f.open(event)).body.invitation);
    const receipt = randomToken();
    const first = await f.public<RegistrationProgress>(event.eventId, "claim", invitation, receipt);
    await f.api("admin", `/events/${event.eventId}/registration`, "PUT", { enabled: false });
    expect((await f.public(event.eventId, "claim", invitation, randomToken())).body.error).toBe(
      "closed",
    );
    expect((await f.public(event.eventId, "status", receipt)).body).toEqual(first.body);
    invitation = required((await f.open(event)).body.invitation);
    await f.flag(false);
    expect((await f.public(event.eventId, "info", invitation)).body.state).toBe("closed");
    expect((await f.public(event.eventId, "claim", invitation, randomToken())).body.error).toBe(
      "feature_disabled",
    );
    expect((await f.public(event.eventId, "claim", invitation, receipt)).body).toEqual(first.body);
    expect((await f.public(event.eventId, "status", receipt)).body).toEqual(first.body);
    expect(
      (await f.api("participant", "/portal/me", "GET", undefined, first.body.teamLoginKey)).status,
    ).toBe(200);
    expect(
      (await f.api("admin", `/events/${event.eventId}/registration`, "PUT", { enabled: false }))
        .body.error,
    ).toBe("feature_disabled");
    await f.restart();
    expect((await f.public(event.eventId, "status", receipt)).body).toEqual(first.body);
    await f.flag(true);
    f.advance(60_001);
    expect((await f.public(event.eventId, "claim", invitation, randomToken())).body.error).toBe(
      "closed",
    );
    expect((await f.public(event.eventId, "status", receipt)).body).toEqual(first.body);
    expect((await f.public(event.eventId, "claim", invitation, receipt)).body).toEqual(first.body);
  } finally {
    await f.close();
  }
});

test("key rotation revokes the receipt without revealing the new key; other slots and events stay isolated", async () => {
  const f = await registrationFixture();
  try {
    const event = await f.create(),
      other = await f.create();
    await f.flag(true);
    const invitation = required((await f.open(event)).body.invitation),
      otherInvite = required((await f.open(other)).body.invitation),
      receipt = randomToken();
    const first = await f.public<RegistrationProgress>(event.eventId, "claim", invitation, receipt);
    const rotated = await f.api<{ teamLoginKey: string }>(
      "admin",
      `/events/${event.eventId}/teams/${first.body.teamId}/rotate-login-key`,
      "POST",
      {},
    );
    expect(rotated.status).toBe(200);
    for (const action of ["claim", "status"] as const) {
      const result = await f.public(
        event.eventId,
        action,
        action === "claim" ? invitation : receipt,
        action === "claim" ? receipt : undefined,
      );
      expect(result.body.error).toBe("receipt_revoked");
      expect(JSON.stringify(result.body)).not.toContain(rotated.body.teamLoginKey);
    }
    await f.flag(false);
    expect((await f.public(event.eventId, "status", receipt)).body.error).toBe("receipt_revoked");
    await f.flag(true);
    const next = await f.public<RegistrationProgress>(
      event.eventId,
      "claim",
      invitation,
      randomToken(),
    );
    expect(next.status).toBe(200);
    expect(next.body.teamId).not.toBe(first.body.teamId);
    expect((await f.public(other.eventId, "status", receipt)).status).toBe(404);
    expect((await f.public(other.eventId, "claim", invitation, randomToken())).status).toBe(404);
    expect((await f.public(other.eventId, "claim", otherInvite, receipt)).status).toBe(200);
    expect(
      (
        await f.api(
          "participant",
          `/portal/registration/foreign/${event.eventId}/info`,
          "POST",
          {},
          invitation,
        )
      ).status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});

test("current readiness is checked on every claim and retrieval, including operations and changed definitions", async () => {
  const f = await registrationFixture();
  try {
    const event = await f.create();
    await f.flag(true);
    const invitation = required((await f.open(event)).body.invitation);
    const jobs = f.store.jobs(event.eventId);
    for (const job of jobs) f.store.putJob({ ...job, status: "STOPPED" });
    expect((await f.public(event.eventId, "claim", invitation, randomToken())).body.error).toBe(
      "not_ready",
    );
    expect((await f.open(event)).body).toMatchObject({ error: "not_ready" });
    const job = required(jobs[0]);
    f.store.putJob(job);
    const receipt = randomToken();
    const first = await f.public<RegistrationProgress>(event.eventId, "claim", invitation, receipt);
    expect(first.body.teamId).toBe(job.teamId);
    f.store.putJob({ ...job, operation: "restart" });
    const preparing = await f.public(event.eventId, "status", receipt);
    expect(preparing.body.state).toBe("preparing");
    expect(preparing.body).not.toHaveProperty("teamLoginKey");
    f.store.putJob({ ...job, definition: `${job.definition} ` });
    const changed = await f.public(event.eventId, "status", receipt);
    expect(changed.body.state).toBe("failed");
    expect(changed.body).not.toHaveProperty("teamLoginKey");
  } finally {
    await f.close();
  }
});

test("ended and expired event access cannot be recovered with receipts", async () => {
  const f = await registrationFixture();
  try {
    await f.flag(true);
    for (const mode of ["end", "expiry"] as const) {
      const event = await f.create(1),
        invitation = required((await f.open(event)).body.invitation),
        receipt = randomToken();
      expect((await f.public(event.eventId, "claim", invitation, receipt)).status).toBe(200);
      if (mode === "end")
        expect((await f.api("admin", `/events/${event.eventId}/end`, "POST", {})).status).toBe(200);
      else {
        const current = f.store.event(event.eventId);
        f.store.putEvent({ ...current, expiresAt: Math.floor(f.now / 1000) });
      }
      expect((await f.public(event.eventId, "status", receipt)).body.error).toBe("closed");
      expect((await f.public(event.eventId, "claim", invitation, receipt)).body.error).toBe(
        "closed",
      );
    }
  } finally {
    await f.close();
  }
});

test("configuration validates event ownership and retained claims; malformed requests and corrupt settings fail closed", async () => {
  const f = await registrationFixture();
  try {
    const event = await f.create(),
      other = await f.create(1);
    await f.flag(true);
    expect((await f.open(event, [required(other.teams[0]).teamId])).body).toMatchObject({
      error: "invalid_pool",
    });
    const teamId = required(event.teams[0]).teamId;
    expect((await f.open(event, [teamId, teamId])).body).toMatchObject({ error: "invalid_pool" });
    const invitation = required((await f.open(event)).body.invitation),
      receipt = randomToken();
    await f.public(event.eventId, "claim", invitation, receipt);
    expect((await f.open(event, [required(event.teams[1]).teamId])).body).toMatchObject({
      error: "invalid_pool",
    });
    const path = `/portal/registration/local-host/${event.eventId}/claim`;
    expect((await f.api("participant", path, "POST", { receipt, teamId }, invitation)).status).toBe(
      400,
    );
    expect(
      (await f.api("participant", path, "POST", { receipt: "short" }, invitation)).status,
    ).toBe(400);
    expect(
      (await f.api("participant", path, "POST", { receipt, padding: "x".repeat(1024) }, invitation))
        .status,
    ).toBe(413);
    expect((await f.api("admin", path, "POST", { receipt }, invitation)).status).toBe(404);
    f.store
      .statement("UPDATE host_registrations SET pool=? WHERE event_id=?")
      .run("{", event.eventId);
    expect((await f.public(event.eventId, "claim", invitation, randomToken())).body.error).toBe(
      "registration_unavailable",
    );
    expect(
      f.store
        .statement("SELECT COUNT(*) AS count FROM host_registration_claims WHERE event_id=?")
        .get(event.eventId),
    ).toEqual({ count: 1 });
  } finally {
    await f.close();
  }
});

test("registration claims roll back failed persistence and retries allocate exactly once", async () => {
  const f = await registrationFixture();
  try {
    const event = await f.create(1);
    await f.flag(true);
    const invitation = required((await f.open(event)).body.invitation);
    const receipt = randomToken();
    f.store.database.exec(
      "CREATE TRIGGER reject_claim AFTER INSERT ON host_registration_claims BEGIN SELECT RAISE(ABORT, 'test claim persistence failure'); END;",
    );
    expect((await f.public(event.eventId, "claim", invitation, receipt)).status).toBe(500);
    expect(
      (await f.api<RegistrationSummary>("admin", `/events/${event.eventId}/registration`)).body
        .claimed,
    ).toBe(0);
    f.store.database.exec("DROP TRIGGER reject_claim");
    expect((await f.public(event.eventId, "claim", invitation, receipt)).status).toBe(200);
    expect((await f.public(event.eventId, "claim", invitation, receipt)).status).toBe(200);
    expect(
      f.store.statement("SELECT COUNT(*) AS count FROM host_registration_claims").get(),
    ).toEqual({ count: 1 });
    const claims = JSON.stringify(
      f.store.statement("SELECT * FROM host_registration_claims").all(),
    );
    expect(claims).not.toContain(receipt);
    expect(claims).not.toContain(invitation);
  } finally {
    await f.close();
  }
});

test("registration settings and claims work with retired audit rows unchanged across restart", async () => {
  const f = await registrationFixture();
  try {
    seedLegacyAudit(f.store);
    rejectLegacyAuditWrites(f.store);
    const legacy = legacyAuditSnapshot(f.store);
    const event = await f.create(2);
    expect((await f.flag(true)).status).toBe(200);
    const opened = await f.open(event);
    expect(opened.status).toBe(200);
    const invitation = required(opened.body.invitation);
    const receipt = randomToken();
    expect((await f.public(event.eventId, "claim", invitation, receipt)).status).toBe(200);
    expect((await f.public(event.eventId, "claim", invitation, receipt)).status).toBe(200);
    expect(
      (await f.api("admin", `/events/${event.eventId}/registration`, "PUT", { enabled: false }))
        .status,
    ).toBe(200);
    expect(
      (await f.api<RegistrationSummary>("admin", `/events/${event.eventId}/registration`)).body
        .enabled,
    ).toBe(false);
    await f.restart();
    expect(
      (await f.api<RegistrationSummary>("admin", `/events/${event.eventId}/registration`)).body
        .claimed,
    ).toBe(1);
    expect(legacyAuditSnapshot(f.store)).toEqual(legacy);
  } finally {
    await f.close();
  }
});

test("cloud readiness follows the current team's account binding; Docker readiness does not require AWS", async () => {
  const f = await registrationFixture();
  try {
    await f.flag(true);
    const event = await f.create(1),
      original = f.store.event(event.eventId),
      team = required(event.teams[0]),
      job = required(f.store.jobs(event.eventId)[0]);
    const definition = JSON.stringify({ kind: "cloudformation" });
    f.store.putEvent({
      ...original,
      problems: original.problems.map((p) => ({ ...p, definition, runtime: "cloudformation" })),
    });
    f.store.putTeam({
      ...f.store.team(team.teamId),
      aws: { accountId: "111111111111", roleName: "CompetitorRole" },
    });
    f.store.putJob({
      ...job,
      definition,
      unit: JSON.stringify({
        kind: "cloudformation",
        accountId: "111111111111",
        roleArn: "arn:aws:iam::111111111111:role/CompetitorRole",
      }),
    });
    const invitation = required((await f.open(event)).body.invitation),
      receipt = randomToken();
    expect((await f.public(event.eventId, "claim", invitation, receipt)).status).toBe(200);
    f.store.putTeam({
      ...f.store.team(team.teamId),
      aws: { accountId: "222222222222", roleName: "CompetitorRole" },
    });
    const stale = await f.public(event.eventId, "status", receipt);
    expect(stale.body.state).toBe("failed");
    expect(stale.body).not.toHaveProperty("teamLoginKey");
    f.store.putTeam({ ...f.store.team(team.teamId), aws: undefined });
    f.store.putEvent({
      ...original,
      problems: original.problems.map((p) => ({ ...p, runtime: "docker" })),
    });
    f.store.putJob(job);
    expect((await f.public(event.eventId, "status", receipt)).body.state).toBe("ready");
  } finally {
    await f.close();
  }
});
