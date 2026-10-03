import { expect, test } from "bun:test";
import { type RegistrationSummary, registrationFixture } from "./registration-fixture";

test("only the current Admin can configure registration and its feature flag", async () => {
  const fixture = await registrationFixture();
  try {
    const event = await fixture.create(1);
    const path = `/events/${event.eventId}/registration`;
    for (const role of ["Operator", "Viewer"] as const) {
      const username = `registration-${role.toLowerCase()}`;
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Test-only account in a fresh local host data directory.
      const password = "Registration-role-test-only-2026!";
      expect(
        (await fixture.api("admin", "/host/users", "POST", { username, password, role })).status,
      ).toBe(201);
      const login = await fixture.api<{ idToken: string }>("admin", "/host/login", "POST", {
        username,
        password,
      });
      expect(login.status).toBe(200);
      const token = login.body.idToken;
      const read = await fixture.api<RegistrationSummary>("admin", path, "GET", undefined, token);
      expect(read.status).toBe(200);
      expect(read.body.canConfigure).toBe(false);
      expect(read.body.featureEnabled).toBe(false);
      expect(
        (
          await fixture.api(
            "admin",
            "/feature-flags",
            "PUT",
            { key: "registration", enabled: true },
            token,
          )
        ).status,
      ).toBe(403);
      expect((await fixture.api("admin", path, "PUT", { enabled: false }, token)).status).toBe(403);
      expect(
        (await fixture.api("admin", path, "GET", undefined, event.teams[0]?.teamLoginKey)).status,
      ).toBe(401);
    }

    expect((await fixture.flag(true)).status).toBe(200);
    expect((await fixture.open(event)).status).toBe(200);
    expect((await fixture.flag(false)).status).toBe(200);
    const retained = await fixture.api<RegistrationSummary>("admin", path);
    expect(retained.status).toBe(200);
    expect(retained.body.canConfigure).toBe(true);
    expect(retained.body.teamIds).toEqual(event.teams.map((team) => team.teamId));
  } finally {
    await fixture.close();
  }
});
