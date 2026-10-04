import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as catalogContext from "../../lib/problem-deploy/handlers/shared/execution-catalog-context";
import {
  AT,
  acknowledgment,
  consent,
  EVENT_ID,
  existingEventFixture,
  TEAM_ID,
  TENANT_ID,
} from "./existing-event-consent.test-helpers";

beforeEach(() => {
  vi.stubEnv("CONTROL_PLANE_ACCOUNT", consent.awsAccountId);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(AT));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each(["dynamodb", "turso"] as const)(
  "existing event deploy consent through Hono: %s",
  (backend) => {
    it("returns 422 without effects, then saves authenticated consent on the same event and deploys", async () => {
      const f = await existingEventFixture(backend);
      const before = await f.events.getEvent(TENANT_ID, EVENT_ID);
      const denied = await f.deploy();
      expect(denied.status).toBe(422);
      expect(await denied.json()).toMatchObject({
        error: "unsupported_hosting_account",
        awsAccountId: consent.awsAccountId,
      });
      expect(f.save).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.eventsSend).not.toHaveBeenCalled();
      expect(await f.events.getEvent(TENANT_ID, EVENT_ID)).toEqual(before);
      // Cancel produces no second request; the denied request above cannot leave consent behind.
      const accepted = await f.deploy({ hostingAccountSelfTest: consent });
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toMatchObject({ eventId: EVENT_ID, enqueued: 1 });
      expect((await f.events.getEvent(TENANT_ID, EVENT_ID))?.hostingAccountSelfTest).toEqual(
        acknowledgment,
      );
      const detail = JSON.parse(f.eventsSend.mock.calls[0][0].input.Entries[0].Detail);
      expect(detail.hostingAccountSelfTest).toEqual({
        ...acknowledgment,
        eventId: EVENT_ID,
        tenantId: TENANT_ID,
        jobId: detail.jobId,
      });
      expect(detail.competitorRoleArn).toContain("RegisteredCompetitorRole");
      expect(detail.externalIdParameterName).toContain(`/tenants/${TENANT_ID}/external-id`);
    });

    it("retries existing consent without prompting and preserves the first audit stamp on duplicate requests", async () => {
      const f = await existingEventFixture(backend);
      expect((await f.deploy({ hostingAccountSelfTest: consent })).status).toBe(202);
      expect(
        (await f.deploy({ hostingAccountSelfTest: consent }, TENANT_ID, "operator-two")).status,
      ).toBe(202);
      expect((await f.deploy()).status).toBe(202);
      expect(f.save).toHaveBeenCalledTimes(1);
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(f.eventsSend).toHaveBeenCalledTimes(1);
      expect((await f.events.getEvent(TENANT_ID, EVENT_ID))?.hostingAccountSelfTest).toEqual(
        acknowledgment,
      );
    });

    it.each(["native", "foreign-account"])(
      "accepts retained valid consent for a later %s subset",
      async (kind) => {
        const f = await existingEventFixture(backend, { hostingAccountSelfTest: acknowledgment });
        if (kind === "native")
          vi.spyOn(catalogContext, "isNativeExecutionProblem").mockReturnValue(true);
        else {
          const [team] = await f.teams.listTeamsByEvent(EVENT_ID);
          await f.teams.putTeam({ ...team, awsAccountId: "222222222222" });
        }
        const response = await f.deploy({
          hostingAccountSelfTest: consent,
          teamIds: [TEAM_ID],
          problemIds: ["hello-world"],
        });
        expect(response.status).toBe(202);
        expect(f.save).not.toHaveBeenCalled();
        expect((await f.events.getEvent(TENANT_ID, EVENT_ID))?.hostingAccountSelfTest).toEqual(
          acknowledgment,
        );
      },
    );

    it("uses a concurrent first consent without overwriting its audit information", async () => {
      const f = await existingEventFixture(backend);
      const original = Object.getPrototypeOf(f.events).acknowledgeHostingAccountSelfTest.bind(
        f.events,
      );
      const first = { ...acknowledgment, acknowledgedBy: "concurrent-operator" };
      f.save.mockImplementationOnce(async (...args) => {
        await original(args[0], args[1], first, args[3]);
        return original(...args);
      });
      expect((await f.deploy({ hostingAccountSelfTest: consent })).status).toBe(202);
      expect((await f.events.getEvent(TENANT_ID, EVENT_ID))?.hostingAccountSelfTest).toEqual(first);
      const detail = JSON.parse(f.eventsSend.mock.calls[0][0].input.Entries[0].Detail);
      expect(detail.hostingAccountSelfTest.acknowledgedBy).toBe("concurrent-operator");
    });

    it("returns 404 without writes for another tenant", async () => {
      const f = await existingEventFixture(backend);
      expect((await f.deploy({ hostingAccountSelfTest: consent }, "other-tenant")).status).toBe(
        404,
      );
      expect(f.save).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.eventsSend).not.toHaveBeenCalled();
    });

    it.each(["acknowledgedBy", "acknowledgedAt", "eventId", "tenantId", "jobId"])(
      "rejects client-owned %s bindings before any effects",
      async (field) => {
        const f = await existingEventFixture(backend);
        expect(
          (await f.deploy({ hostingAccountSelfTest: { ...consent, [field]: "forged" } })).status,
        ).toBe(400);
        expect(f.save).not.toHaveBeenCalled();
        expect(f.writes).not.toHaveBeenCalled();
      },
    );

    it("rejects wrong account or missing authenticated actor before saving", async () => {
      const f = await existingEventFixture(backend);
      expect(
        (await f.deploy({ hostingAccountSelfTest: { ...consent, awsAccountId: "222222222222" } }))
          .status,
      ).toBe(422);
      expect((await f.deploy({ hostingAccountSelfTest: consent }, TENANT_ID, "")).status).toBe(422);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
    });

    it("rejects a foreign team and retains registration checks", async () => {
      const f = await existingEventFixture(backend);
      const team = (await f.teams.listTeamsByEvent(EVENT_ID))[0];
      await f.teams.putTeam({ ...team, tenantId: "foreign-tenant" });
      expect((await f.deploy({ hostingAccountSelfTest: consent })).status).toBe(409);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
    });

    it("still refuses deployment when the competitor account is unverified", async () => {
      const f = await existingEventFixture(backend);
      await f.accounts.deleteAccount(TENANT_ID, consent.awsAccountId);
      const response = await f.deploy({ hostingAccountSelfTest: consent });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ enqueued: 0, unverified: 1 });
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.eventsSend).not.toHaveBeenCalled();
    });

    it("retains filters and force-redeploy options after consent", async () => {
      const f = await existingEventFixture(backend);
      const body = {
        hostingAccountSelfTest: consent,
        teamIds: [TEAM_ID],
        problemIds: ["hello-world"],
      };
      expect((await f.deploy(body)).status).toBe(202);
      const [deployment] = await f.deployments.listByTenantAndEvent(TENANT_ID, EVENT_ID);
      await f.deployments.markCreateSucceeded(deployment.jobId, "stack-id", "{}", undefined, AT);
      const response = await f.deploy({ ...body, forceRedeploy: true });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ enqueued: 1 });
      expect(f.save).toHaveBeenCalledTimes(1);
    });

    it("retains retry-failed filters after consent", async () => {
      const f = await existingEventFixture(backend);
      expect((await f.deploy({ hostingAccountSelfTest: consent })).status).toBe(202);
      const [deployment] = await f.deployments.listByTenantAndEvent(TENANT_ID, EVENT_ID);
      await f.deployments.markCreateFailed(deployment.jobId, "failed", undefined, AT);
      const response = await f.deploy({
        retryFailedOnly: true,
        teamIds: [TEAM_ID],
        problemIds: ["hello-world"],
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ enqueued: 1 });
      expect(f.save).toHaveBeenCalledTimes(1);
    });

    it("uses the saved catalog for consent and dispatch, preserving its pin", async () => {
      const key = `catalogs/${"a".repeat(64)}.json`;
      const saved = vi.spyOn(catalogContext, "savedExecutionCatalog").mockResolvedValue({
        version: 1,
        catalogKey: key,
        catalog: { "hello-world": "saved/hello-world" },
        scoring: {},
        hints: {},
        endpoints: {},
        phases: {},
        visibility: {},
        runtimes: {},
        disruptions: {},
        writeups: {},
        provenance: {},
        coordination: {},
        plugins: {},
        sources: {},
        sourceArchive: { bucket: "test", key: "source.zip", versionId: "1" },
      });
      const f = await existingEventFixture(backend, { catalogKey: key });
      expect((await f.deploy()).status).toBe(422);
      expect((await f.deploy({ hostingAccountSelfTest: consent })).status).toBe(202);
      expect(saved).toHaveBeenCalledWith(key);
      expect((await f.events.getEvent(TENANT_ID, EVENT_ID))?.catalogKey).toBe(key);
      const detail = JSON.parse(f.eventsSend.mock.calls[0][0].input.Entries[0].Detail);
      expect(detail.catalogKey).toBe(key);
      expect(detail.problemDir).toBe("saved/hello-world");
    });

    it("keeps foreign account deployments available without consent", async () => {
      vi.stubEnv("CONTROL_PLANE_ACCOUNT", "222222222222");
      const f = await existingEventFixture(backend);
      expect((await f.deploy()).status).toBe(202);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.writes).toHaveBeenCalledTimes(1);
    });

    it("keeps native deployments available without consent", async () => {
      vi.spyOn(catalogContext, "isNativeExecutionProblem").mockReturnValue(true);
      const f = await existingEventFixture(backend);
      expect((await f.deploy()).status).toBe(202);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(f.eventsSend).not.toHaveBeenCalled();
    });

    it("preserves concurrent schedule, deployment scores and participant credentials while saving consent", async () => {
      const f = await existingEventFixture(backend);
      const schedule = "2026-10-05T10:00:00.000Z";
      // Use the prototype implementation to avoid re-entering the spy.
      const original = Object.getPrototypeOf(f.events).acknowledgeHostingAccountSelfTest.bind(
        f.events,
      );
      f.save.mockImplementationOnce(async (...args) => {
        await f.events.updateSchedule(TENANT_ID, EVENT_ID, { startsAt: schedule }, AT);
        await f.deployments.putDeployment({
          jobId: "existing-result",
          tenantId: TENANT_ID,
          eventId: EVENT_ID,
          teamId: TEAM_ID,
          problemId: "previous-problem",
          awsAccountId: consent.awsAccountId,
          region: "ap-northeast-1",
          teamName: "alpha",
          namePrefix: "previous",
          status: "COMPLETE",
          score: 42,
          teamLoginKey: "existing-participant-key",
          createdAt: AT,
          updatedAt: AT,
          expiresAt: 4_102_444_800,
        });
        return original(...args);
      });
      expect((await f.deploy({ hostingAccountSelfTest: consent })).status).toBe(202);
      expect((await f.events.getEvent(TENANT_ID, EVENT_ID))?.startsAt).toBe(schedule);
      const rows = await f.deployments.listByTenantAndEvent(TENANT_ID, EVENT_ID);
      expect(rows.find((row) => row.jobId === "existing-result")?.score).toBe(42);
      expect(rows.find((row) => row.problemId === "hello-world")?.eventStartsAt).toBe(schedule);
      expect((await f.teams.listTeamsByEvent(EVENT_ID))[0].teamLoginKey).toBe(
        "existing-participant-key",
      );
      expect(
        (await f.deployments.listByTeamLoginKey("existing-participant-key")).some(
          (row) => row.jobId === "existing-result",
        ),
      ).toBe(true);
    });

    it.each(["ENDED", "TEARDOWN", "ARCHIVED"] as const)(
      "does not save consent or deploy after lifecycle changes to %s",
      async (status) => {
        const f = await existingEventFixture(backend, { status });
        expect((await f.deploy({ hostingAccountSelfTest: consent })).status).toBe(409);
        expect(f.writes).not.toHaveBeenCalled();
        expect(f.eventsSend).not.toHaveBeenCalled();
        expect(
          (await f.events.getEvent(TENANT_ID, EVENT_ID))?.hostingAccountSelfTest,
        ).toBeUndefined();
      },
    );
  },
);
