import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import type { HostPlugin } from "../../../scripts/local-host/coordination-core.js";
import { hash, jsonBytes } from "../../lib/problem-deploy/control-data/coordination-state.js";
import {
  COORDINATION_MAX_BYTES,
  type NativeCoordinationArtifact,
  SQL_COORDINATION_MAX_BYTES,
} from "../../lib/problem-deploy/control-data/domain/coordination.js";
import { SQL_EVENT_LIMITS } from "../../lib/problem-deploy/control-data/domain/events.js";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../../lib/problem-deploy/control-data/libsql-executor.js";
import { SqlCloudRepository } from "../../lib/problem-deploy/control-data/sql-cloud-repository.js";
import { SqlDeploymentWork } from "../../lib/problem-deploy/control-data/sql-deployment-work.js";
import { SqlDeploymentsCoordination } from "../../lib/problem-deploy/control-data/sql-deployments-coordination.js";
import type { SqlExecutor } from "../../lib/problem-deploy/control-data/sql-port.js";
import { createCloudApp } from "../../lib/problem-deploy/handlers/cloud-api/app.js";
import type { NativeProblem } from "../../lib/problem-deploy/handlers/cloud-api/execution-config.js";
import { sqliteFixture } from "./sql-fixture.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const AUTH = { issuer: "https://cognito-idp.us-east-1.amazonaws.com/pool", audience: "client" };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
interface State {
  padding: string;
  scores: Record<string, number>;
}
async function fixture(engine: "sqlite" | "libsql") {
  let sql: SqlExecutor;
  if (engine === "sqlite") {
    const f = sqliteFixture();
    sql = f.sql;
    cleanups.push(f.close);
  } else {
    const client = createClient({ url: "file::memory:" });
    cleanups.push(() => client.close());
    await initializeControlDataSchema(client);
    sql = new LibsqlExecutor(client);
  }
  const repository = new SqlCloudRepository(sql);
  const store = new SqlDeploymentsCoordination(sql);
  const plugin: HostPlugin = {
    initialState: (context) => ({
      // Larger than the replaced 2 MiB ceiling, within the historical SQL policy.
      padding: "x".repeat(SQL_COORDINATION_MAX_BYTES - 32 * 1024),
      scores: Object.fromEntries(context.teamIds.map((id) => [id, 0])),
    }),
    validateOp: () => ({ ok: true }),
    applyOp: (state) => {
      const previous = state as State;
      return {
        ...previous,
        scores: Object.fromEntries(
          Object.entries(previous.scores).map(([id, score]) => [id, score + 1]),
        ),
      };
    },
    projectForTeam: (state, id) => ({ score: (state as State).scores[id] }),
    teamScores: (state) => (state as State).scores,
  };
  const artifactDigest = hash("capacity-fixture");
  const descriptor: NativeProblem = {
    kind: "coordination" as const,
    problemId: "ac26-crypto-battle",
    problemDir: "problems/battles/ac26-crypto-battle",
    artifactDigest,
    pluginKey: `plugins/${artifactDigest}.mjs`,
    catalogKey: `catalogs/${hash("capacity-catalog")}.json`,
    stateBudget: { bytesPerTeam: 31744, baseBytes: 1536 },
    name: "Native capacity fixture",
    description: "Fixture",
    instructions: "Fixture",
  };
  const artifact: NativeCoordinationArtifact = { ...descriptor, plugin };
  const app = createCloudApp({
    repository,
    now: () => NOW,
    organizerAuth: AUTH,
    allowedOrigins: [],
    deployment: {
      work: new SqlDeploymentWork(sql),
      catalog: async () => ({}),
      controlPlaneAccount: "123456789012",
    },
    coordination: {
      store,
      catalog: async () => ({ [descriptor.problemId]: descriptor }),
      resolve: async () => ({ descriptor, plugin }),
    },
  });
  const organizer = (path: string, method = "GET", body?: unknown) =>
    app.request(
      path,
      {
        method,
        ...(body
          ? { body: JSON.stringify(body), headers: { "Idempotency-Key": "capacity-create" } }
          : {}),
      },
      {
        event: {
          requestContext: {
            authorizer: {
              claims: {
                sub: "organizer",
                token_use: "id",
                iss: AUTH.issuer,
                aud: AUTH.audience,
                exp: String(NOW / 1000 + 3600),
                "custom:userRole": "Operator",
              },
            },
          },
        },
      },
    );
  const create = async (count = 99) => {
    const response = await organizer("/events", "POST", {
      name: "SQL capacity",
      teams: Array.from({ length: count }, (_, index) => ({ internalSlug: `team-${index}` })),
      problems: [{ problemId: descriptor.problemId, defaultRegion: "us-east-1" }],
    });
    return response;
  };
  const operation = { key: "capacity-move", hash: hash("{}"), op: {} };
  return { sql, repository, store, artifact, organizer, create, operation };
}

for (const engine of ["sqlite", "libsql"] as const) {
  describe(`${engine}: historical SQL Native Battle capacity`, () => {
    it("creates, explicitly selects, scores and replays a 99-team match above 2 MiB", async () => {
      const f = await fixture(engine);
      expect(f.repository.eventLimits).toEqual(SQL_EVENT_LIMITS);
      const response = await f.create();
      expect(response.status).toBe(201);
      const created = await response.json();
      expect(created.teams).toHaveLength(99);
      expect(await (await f.create()).json()).toEqual(created);
      const teams = await f.repository.listTeamsByEvent(created.eventId);
      expect(teams).toHaveLength(99);
      for (const team of [teams[0], teams[98]]) {
        if (!team) throw new Error("Missing capacity team");
        expect(await f.repository.authenticateTeam(team.teamLoginKey, NOW)).toEqual(team);
      }
      const deployed = await f.organizer(`/events/${created.eventId}/deploy`, "POST", {
        teamIds: teams.map((team) => team.teamId),
      });
      expect(deployed.status).toBe(202);
      expect(await deployed.json()).toMatchObject({ initialized: 1, enqueued: 0 });
      const event = await f.repository.getEvent(created.eventId);
      const team = teams[98];
      if (!event || !team) throw new Error("Missing initialized capacity event");
      const started = await f.store.changeSchedule({
        event,
        artifact: f.artifact,
        now: () => NOW,
        patch: { startsAt: new Date(NOW).toISOString() },
      });
      const request = {
        event: started,
        team,
        artifact: f.artifact,
        now: () => NOW,
        operation: f.operation,
      };
      const before = await f.store.read(event.eventId, f.artifact.problemId);
      const lastTeam = before?.roster.at(-1)?.teamId;
      if (!lastTeam) throw new Error("Missing final score target");
      await f.sql.run(`CREATE TRIGGER fail_final_capacity_score BEFORE INSERT ON cloud_team_scores
        WHEN NEW.team_id = '${lastTeam}' BEGIN SELECT RAISE(ABORT, 'capacity_score_failure'); END`);
      await expect(f.store.request(request)).rejects.toThrow("capacity_score_failure");
      expect((await f.store.read(event.eventId, f.artifact.problemId))?.match).toEqual(
        before?.match,
      );
      expect(await f.repository.listTeamScores(event.eventId)).toEqual([]);
      expect(
        await f.sql.get("SELECT COUNT(*) AS count FROM cloud_coordination_receipts"),
      ).toMatchObject({ count: 0 });
      await f.sql.run("DROP TRIGGER fail_final_capacity_score");
      const result = await f.store.request(request);
      expect(result).toMatchObject({ status: 200, body: { projection: { score: 1 } } });
      expect(await f.store.request(request)).toEqual(result);
      const run = await f.store.read(event.eventId, f.artifact.problemId);
      expect(run?.roster).toHaveLength(99);
      expect(jsonBytes(run?.match).byteLength).toBeGreaterThan(COORDINATION_MAX_BYTES);
      const scores = await f.repository.listTeamScores(event.eventId);
      expect(scores).toHaveLength(99);
      expect(scores.every((row) => row.score === 1 && row.completedProblems === 0)).toBe(true);
      const detail = await f.organizer(`/events/${event.eventId}?withScoreEvents=true`);
      expect(detail.status).toBe(200);
      expect((await detail.json()).scoreEventsByTeam).toHaveLength(99);
      expect(
        await f.sql.get("SELECT COUNT(*) AS count FROM cloud_coordination_receipts"),
      ).toMatchObject({ count: 1 });
      expect(
        await f.sql.get("SELECT COUNT(*) AS count FROM cloud_coordination_scores"),
      ).toMatchObject({ count: 1 });
    });
    it("rejects the 100th team at HTTP admission without creating rows", async () => {
      const f = await fixture(engine);
      expect((await f.create(100)).status).toBe(400);
      expect(await f.repository.listEvents()).toEqual([]);
    });
    it("preserves the snapshot, scores and receipts when the 4 MiB state boundary is exceeded", async () => {
      const f = await fixture(engine);
      const created = await (await f.create()).json();
      const event = await f.repository.getEvent(created.eventId);
      const teams = await f.repository.listTeamsByEvent(created.eventId);
      const team = teams[0];
      if (!event || !team) throw new Error("Missing capacity fixture");
      await f.store.initialize({ event, teams, artifact: f.artifact, now: NOW });
      const ready = await f.repository.getEvent(event.eventId);
      if (!ready) throw new Error("Missing ready event");
      const started = await f.store.changeSchedule({
        event: ready,
        artifact: f.artifact,
        now: () => NOW,
        patch: { startsAt: new Date(NOW).toISOString() },
      });
      const before = await f.store.read(event.eventId, f.artifact.problemId);
      const artifact = {
        ...f.artifact,
        plugin: {
          ...f.artifact.plugin,
          applyOp: () => ({
            padding: "x".repeat(SQL_COORDINATION_MAX_BYTES),
            scores: Object.fromEntries(teams.map((entry) => [entry.teamId, 10])),
          }),
        },
      };
      await expect(
        f.store.request({ event: started, team, artifact, now: () => NOW, operation: f.operation }),
      ).rejects.toThrow("coordination_state_too_large");
      expect((await f.store.read(event.eventId, artifact.problemId))?.match).toEqual(before?.match);
      expect(await f.repository.listTeamScores(event.eventId)).toEqual([]);
      expect(
        await f.sql.get("SELECT COUNT(*) AS count FROM cloud_coordination_receipts"),
      ).toMatchObject({ count: 0 });
      expect(
        await f.sql.get("SELECT COUNT(*) AS count FROM cloud_coordination_scores"),
      ).toMatchObject({ count: 0 });
    });
  });
}
