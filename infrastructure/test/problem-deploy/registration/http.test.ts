import { describe, expect, it } from "vitest";
import { fixtureEventId, fixtureTenantId, registrationHttpFixture } from "./http-fixture";

const base = `/portal/registration/${fixtureTenantId}/${fixtureEventId}`;
const receipt = "r".repeat(43);
const request = (token: string, body: object = {}) => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("public registration API with persistent repositories", () => {
  it("registers, resumes and releases the key only after all deployments complete", async () => {
    const { app, deps, invitation } = await registrationHttpFixture();
    const info = await app.request(`${base}/info`, request(invitation));
    expect(info.status).toBe(200);
    expect(info.headers.get("Cache-Control")).toContain("no-store");
    expect(await info.json()).toMatchObject({ state: "open", remaining: 2 });
    const reserved = await app.request(`${base}/claim`, request(invitation, { receipt }));
    expect(reserved.status).toBe(200);
    const progress = await reserved.json();
    expect(progress).toMatchObject({ state: "preparing", ready: 0 });
    expect(progress).not.toHaveProperty("teamLoginKey");
    expect(await (await app.request(`${base}/status`, request(receipt))).json()).toEqual(progress);
    const jobs = await deps.deployments.listByTenantAndEvent(fixtureTenantId, fixtureEventId);
    const job = jobs.find((row) => row.teamId === progress.teamId);
    if (!job) throw new Error("Allocated deployment missing");
    await deps.deployments.putDeployment({
      ...job,
      status: "COMPLETE",
      teamLoginKey: "1".repeat(43),
    });
    const ready = await (await app.request(`${base}/status`, request(receipt))).json();
    expect(ready).toMatchObject({ state: "ready", teamLoginKey: "1".repeat(43) });
    expect(await deps.deployments.listByTeamLoginKey(ready.teamLoginKey)).toHaveLength(1);
  });

  it("rejects malformed or unauthorized requests without reserving a slot", async () => {
    const { app, deps, invitation } = await registrationHttpFixture();
    expect((await app.request(`${base}/info`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`${base}/info`, request(receipt))).status).toBe(404);
    expect(
      (await app.request(`${base}/claim`, request(invitation, { receipt: "short" }))).status,
    ).toBe(400);
    expect(
      (await app.request(`${base}/claim`, request(invitation, { receipt, teamId: "another" })))
        .status,
    ).toBe(400);
    expect(
      (await app.request(`${base}/claim`, request(invitation, { receipt: "x".repeat(2048) })))
        .status,
    ).toBe(413);
    expect((await app.request(`${base}/delete`, request(invitation))).status).toBe(404);
    expect(
      (await deps.events.getEvent(fixtureTenantId, fixtureEventId))?.registration?.claims,
    ).toHaveLength(0);
  });
});
