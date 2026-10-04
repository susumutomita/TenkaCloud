import { expect, test } from "bun:test";
import { randomToken } from "../auth";
import { digest, type HostStore } from "../store";
import { participantAccessFixture } from "./participant-access-fixture";

function registrationSnapshot(store: HostStore) {
  return {
    settings: store.statement("SELECT * FROM host_registrations ORDER BY event_id").all(),
    claims: store
      .statement("SELECT * FROM host_registration_claims ORDER BY event_id,team_id")
      .all(),
    flag: store.statement("SELECT value FROM host_settings WHERE key='flag:registration'").get(),
  };
}

test("retired invitation and receipt APIs cannot distribute keys, even with a saved enabled flag", async () => {
  const f = await participantAccessFixture();
  try {
    const event = await f.create(1);
    const team = event.teams[0];
    if (!team) throw new Error("Expected a prepared team");
    const invitation = randomToken();
    const receipt = randomToken();
    f.store
      .statement("INSERT INTO host_settings(key,value) VALUES ('flag:registration','true')")
      .run();
    f.store
      .statement("INSERT INTO host_registrations VALUES (?,1,?,?,?)")
      .run(
        event.eventId,
        digest(invitation),
        new Date(f.now + 60_000).toISOString(),
        JSON.stringify([team.teamId]),
      );
    f.store
      .statement("INSERT INTO host_registration_claims VALUES (?,?,?,?,?)")
      .run(
        event.eventId,
        digest(receipt),
        team.teamId,
        digest(team.teamLoginKey),
        new Date(f.now).toISOString(),
      );
    const saved = f.store.team(team.teamId);
    f.store.putTeam({ ...saved, score: 73, completedProblems: 1 });
    const before = registrationSnapshot(f.store);
    const beforeEvent = f.store.event(event.eventId);
    const beforeTeam = f.store.team(team.teamId);
    const beforeJobs = f.store.jobs(event.eventId);

    for (const operation of ["INSERT", "UPDATE", "DELETE"])
      for (const table of ["host_registrations", "host_registration_claims"])
        f.store.database.exec(
          `CREATE TRIGGER reject_${table}_${operation} BEFORE ${operation} ON ${table}
           BEGIN SELECT RAISE(ABORT, 'retired registration storage must remain untouched'); END;`,
        );

    for (const method of ["GET", "PUT"]) {
      const response = await f.api(
        "admin",
        `/events/${event.eventId}/registration`,
        method,
        method === "PUT"
          ? {
              enabled: true,
              teamIds: [team.teamId],
              closesAt: new Date(f.now + 60_000).toISOString(),
            }
          : undefined,
      );
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty("invitation");
    }
    expect((await f.api("admin", "/feature-flags")).body).toEqual({
      flags: { saml: false, audit: false, challengePrerequisiteGate: false },
    });
    for (const enabled of [true, false])
      expect(
        (await f.api("admin", "/feature-flags", "PUT", { key: "registration", enabled })).status,
      ).toBe(400);
    for (const action of ["info", "claim", "status"])
      for (const token of [invitation, receipt, team.teamLoginKey, ""]) {
        const response = await f.api(
          "participant",
          `/portal/registration/local-host/${event.eventId}/${action}`,
          "POST",
          { receipt },
          token,
        );
        expect(response.status).toBe(404);
        expect(response.body).not.toHaveProperty("teamLoginKey");
      }
    expect(registrationSnapshot(f.store)).toEqual(before);
    expect(f.store.event(event.eventId)).toEqual(beforeEvent);
    expect(f.store.team(team.teamId)).toEqual(beforeTeam);
    expect(f.store.jobs(event.eventId)).toEqual(beforeJobs);

    await f.restart();
    expect(registrationSnapshot(f.store)).toEqual(before);
    expect(f.store.team(team.teamId)).toEqual(beforeTeam);
    expect((await f.api("admin", "/feature-flags")).body.flags).not.toHaveProperty("registration");
    expect(
      (await f.api("participant", "/portal/me", "GET", undefined, team.teamLoginKey)).status,
    ).toBe(200);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("organizers can still distribute and rotate team keys and participants can sign in and set their name", async () => {
  const f = await participantAccessFixture();
  try {
    const event = await f.create(1);
    const team = event.teams[0];
    if (!team) throw new Error("Expected a prepared team");
    const distributed = await f.api<{ teams: { teamId: string; teamLoginKey: string }[] }>(
      "admin",
      `/events/${event.eventId}?withTeamLoginKeys=true`,
    );
    expect(distributed.status).toBe(200);
    expect(distributed.body.teams[0]?.teamLoginKey).toBe(team.teamLoginKey);
    expect(
      (await f.api("participant", "/portal/me", "GET", undefined, team.teamLoginKey)).status,
    ).toBe(200);
    expect(
      (
        await f.api(
          "participant",
          "/portal/me",
          "PATCH",
          { teamName: "Key-only team" },
          team.teamLoginKey,
        )
      ).status,
    ).toBe(200);
    expect(f.store.team(team.teamId).displayName).toBe("Key-only team");
    const rotated = await f.api<{ teamLoginKey: string }>(
      "admin",
      `/events/${event.eventId}/teams/${team.teamId}/rotate-login-key`,
      "POST",
      {},
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.teamLoginKey).not.toBe(team.teamLoginKey);
    expect(
      (await f.api("participant", "/portal/me", "GET", undefined, team.teamLoginKey)).status,
    ).toBe(401);
    expect(
      (await f.api("participant", "/portal/me", "GET", undefined, rotated.body.teamLoginKey))
        .status,
    ).toBe(200);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
