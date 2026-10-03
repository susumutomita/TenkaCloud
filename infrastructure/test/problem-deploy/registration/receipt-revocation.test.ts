import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureRegistration,
  registrationDigest,
} from "../../../lib/problem-deploy/handlers/shared/event-registration";
import { participantRateLimiter } from "../../../lib/problem-deploy/handlers/shared/rate-limiter";
import { fixtureEventId, fixtureTenantId, registrationHttpFixture } from "./http-fixture";

const base = `/portal/registration/${fixtureTenantId}/${fixtureEventId}`;
const receipt = "r".repeat(43);
const request = (token: string, body: object = {}) => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
beforeEach(() => participantRateLimiter.reset());
afterEach(() => vi.restoreAllMocks());

async function readyClaimFixture() {
  const { app, deps, invitation } = await registrationHttpFixture();
  const reserved = await app.request(`${base}/claim`, request(invitation, { receipt }));
  expect(reserved.status).toBe(200);
  const { teamId } = await reserved.json();
  const team = await deps.teams.getTeam(fixtureTenantId, fixtureEventId, teamId);
  const jobs = (
    await deps.deployments.listByTenantAndEvent(fixtureTenantId, fixtureEventId)
  ).filter((job) => job.teamId === teamId);
  if (!team?.teamLoginKey || !jobs.length) throw new Error("Missing fixture team");
  for (const job of jobs)
    await deps.deployments.putDeployment({
      ...job,
      status: "COMPLETE",
      teamLoginKey: team.teamLoginKey,
    });
  expect(await (await app.request(`${base}/status`, request(receipt))).json()).toMatchObject({
    state: "ready",
    teamLoginKey: team.teamLoginKey,
  });
  const event = await deps.events.getEvent(fixtureTenantId, fixtureEventId);
  if (!event?.registration) throw new Error("Missing registration");
  expect(event.registration.claims[0]?.teamLoginKeyHash).toBe(
    registrationDigest(team.teamLoginKey),
  );
  expect(JSON.stringify(event)).not.toContain(team.teamLoginKey);
  return { app, deps, invitation, team, teamId, jobs, registration: event.registration };
}

describe("registration receipt credential revocation through persistent API", () => {
  it.each(["open", "closed", "reissued"])(
    "rejects a rotated credential when registration is %s",
    async (mode) => {
      const { app, deps, invitation, team, teamId, jobs, registration } = await readyClaimFixture();

      let currentInvitation = invitation;
      if (mode === "closed")
        await configureRegistration(deps, fixtureTenantId, fixtureEventId, { enabled: false });
      if (mode === "reissued") {
        const reopened = await configureRegistration(deps, fixtureTenantId, fixtureEventId, {
          enabled: true,
          teamIds: [...registration.teamIds],
          closesAt: registration.closesAt,
        });
        if (!("invitation" in reopened) || !reopened.invitation)
          throw new Error("Missing invitation");
        currentInvitation = reopened.invitation;
        // Reissuing only the invitation does not revoke an unchanged team credential.
        expect((await app.request(`${base}/status`, request(receipt))).status).toBe(200);
      }
      const newLoginKey = "n".repeat(43);
      expect(
        await deps.teams.rotateLoginKey({
          tenantId: fixtureTenantId,
          eventId: fixtureEventId,
          teamId,
          newLoginKey,
          expectedUpdatedAt: team.updatedAt,
          updatedAt: new Date(Date.now() + 1000).toISOString(),
          deployments: jobs.map(({ jobId, createdAt }) => ({ jobId, createdAt })),
        }),
      ).toEqual({ outcome: "updated" });
      expect(await deps.deployments.listByTeamLoginKey(newLoginKey)).toHaveLength(jobs.length);
      expect(await deps.deployments.listByTeamLoginKey(team.teamLoginKey)).toHaveLength(0);
      for (const [action, token] of [
        ["status", receipt],
        ["claim", currentInvitation],
      ]) {
        const denied = await app.request(`${base}/${action}`, request(token, { receipt }));
        expect(denied.status).toBe(409);
        expect(await denied.json()).toEqual({ error: "receipt_revoked" });
      }
      expect(
        (await deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.claims,
      ).toEqual(registration.claims);
      if (mode !== "closed") {
        // Revoking one team does not block a different representative's unused slot.
        expect(
          (
            await app.request(
              `${base}/claim`,
              request(currentInvitation, { receipt: "s".repeat(43) }),
            )
          ).status,
        ).toBe(200);
      }
    },
  );

  it("rejects legacy unbound receipts without binding them to the current key", async () => {
    const { app, deps, invitation } = await registrationHttpFixture();
    await app.request(`${base}/claim`, request(invitation, { receipt }));
    const event = await deps.events.getEvent(fixtureTenantId, fixtureEventId);
    if (!event?.registration) throw new Error("Missing registration");
    await deps.events.putEvent({
      ...event,
      registration: {
        ...event.registration,
        claims: event.registration.claims.map(({ receiptHash, teamId, claimedAt }) => ({
          receiptHash,
          teamId,
          claimedAt,
        })),
      },
    });
    for (const [action, token] of [
      ["status", receipt],
      ["claim", invitation],
    ]) {
      const denied = await app.request(`${base}/${action}`, request(token, { receipt }));
      expect(denied.status).toBe(409);
      expect(await denied.json()).toEqual({ error: "receipt_revoked" });
    }
    expect(
      (await deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.claims[0],
    ).not.toHaveProperty("teamLoginKeyHash");
  });

  it("fails closed if the team key rotates between reading the slot and committing its claim", async () => {
    const { app, deps, invitation } = await registrationHttpFixture();
    const update = deps.events.updateRegistration.bind(deps.events);
    vi.spyOn(deps.events, "updateRegistration").mockImplementationOnce(async (input) => {
      const teamId = input.registration.claims[0]?.teamId;
      if (!teamId) throw new Error("Missing claim");
      const team = await deps.teams.getTeam(fixtureTenantId, fixtureEventId, teamId);
      if (!team) throw new Error("Missing team");
      await deps.teams.putTeam({ ...team, teamLoginKey: "n".repeat(43) });
      return update(input);
    });
    const denied = await app.request(`${base}/claim`, request(invitation, { receipt }));
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "receipt_revoked" });
    expect(
      (await deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.claims[0]
        ?.teamLoginKeyHash,
    ).toBe(registrationDigest("1".repeat(43)));
  });

  it.each([undefined, ""])(
    "does not reserve a slot when its team credential is missing (%s)",
    async (key) => {
      const { app, deps, invitation } = await registrationHttpFixture();
      const get = deps.teams.getTeam.bind(deps.teams);
      vi.spyOn(deps.teams, "getTeam").mockImplementationOnce(async (...args) => {
        const team = await get(...args);
        if (!team) throw new Error("Missing fixture team");
        return key === undefined ? undefined : { ...team, teamLoginKey: key };
      });
      const denied = await app.request(`${base}/claim`, request(invitation, { receipt }));
      expect(denied.status).toBe(404);
      expect(
        (await deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.claims,
      ).toEqual([]);
    },
  );
});
