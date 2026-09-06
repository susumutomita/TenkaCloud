import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository";
import {
  checkCoordinationCapacity,
  coordinationStateBudget,
  forecastCoordinationStateBytes,
  maxTeamsForCoordinationBudget,
  serializedStateBytes,
} from "../../lib/problem-deploy/control-data/domain/coordination-budget";
import { COORDINATION_SCORE_REASONS } from "../../lib/problem-deploy/control-data/domain/coordination-score";
import { checkBulkDeployCoordinationCapacity } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy/capacity-preflight";
import { warnOnCoordinationCapacity } from "../../lib/problem-deploy/handlers/event-handler/coordination-capacity-warning";
import { coordinationScoreDelivery } from "../../lib/problem-deploy/handlers/participant-handler/coordination-scoring";
import { writeCoordinationState } from "../../lib/problem-deploy/handlers/participant-handler/coordination-store";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

afterEach(() => vi.restoreAllMocks());

const SCOPE = { tenantId: "tenant", eventId: "event", problemId: "battle", runId: "default" };
const NOW = "2026-09-06T00:00:00.000Z";
const longestReason = [...COORDINATION_SCORE_REASONS].sort((a, b) => b.length - a.length)[0];
interface State {
  readonly after: boolean;
  readonly padding: string;
}

/** The plugin fills its entire declared allowance; none of it pays for the host. */
function worstTransition(teamIds: readonly string[], pluginBytes: number) {
  const state: State = {
    after: true,
    padding: "x".repeat(pluginBytes - JSON.stringify({ after: true, padding: "" }).length),
  };
  const plugin: CoordinationPlugin<State, never> = {
    initialState: () => state,
    validateOp: () => ({ ok: true }),
    applyOp: (current) => current,
    projectForTeam: () => ({}),
    // Negative fixed-notation doubles are longer than the usual exponent form.
    teamScores: (current) =>
      Object.fromEntries(
        teamIds.map((id) => [
          id,
          current.after ? -0.0000010000000000000004 : -0.0000010000000000000002,
        ]),
      ),
    scoreReasons: () => Object.fromEntries(teamIds.map((id) => [id, longestReason])),
  };
  const delivery = coordinationScoreDelivery(
    plugin,
    { ...state, after: false },
    state,
    { kind: "tick" },
    NOW,
    true,
  );
  if (!delivery) throw new Error("The fixture must reserve the entire roster's initial scores");
  return { state, delivery };
}

describe.each([
  "DynamoDB",
  "SQL",
])("capacity includes the durable score envelope: %s", (backend) => {
  it.each([
    "ULID",
    "escaped legacy",
  ])("admits only a worst-case row that the runtime can store (%s IDs)", async (idKind) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ddb = makeFakeDdb();
    const repository =
      backend === "DynamoDB"
        ? new DynamoDbDeploymentsRepository(ddb, "Deployments")
        : new SqlDeploymentsRepository(makeSqliteExecutor());
    const runtime = {
      ...makeTestControlDataRuntime({
        CONTROL_DATA_BACKEND: backend === "DynamoDB" ? "dynamodb" : "turso",
      }),
      resolveDeploymentsRepository: async () => repository,
    };
    const budget = runtime.coordinationStateBudget();
    const store = { runtime, ddb, tableName: "Deployments" };
    const teamIds = Array.from({ length: 99 }, (_, index) =>
      idKind === "ULID"
        ? index.toString().padStart(26, "0")
        : `${'旧\\"\n\u0000'.repeat(20)}${index.toString().padStart(3, "0")}`,
    );
    const forecast = { baseBytes: budget.maxBytes - 1600 * teamIds.length, bytesPerTeam: 1600 };

    // The previous preflight admitted this exact-ceiling plugin state. The first
    // roster-wide score must be rejected by the real runtime guard on either backend.
    const rejected = worstTransition(teamIds, budget.maxBytes);
    expect(serializedStateBytes(rejected.state)).toBe(budget.maxBytes);
    expect(
      await writeCoordinationState(store, SCOPE, rejected.state, 0, NOW, 1, rejected.delivery),
    ).toMatchObject({ kind: "too_large" });
    expect(await repository.readCoordinationState(SCOPE)).toBeUndefined();

    // All existing ownership modes (and a legacy entry) get the same safe reserve.
    for (const scoreMode of ["exclusive", "additive", undefined]) {
      const report = checkBulkDeployCoordinationCapacity({
        problems: [{ problemId: SCOPE.problemId }],
        eventTeamCount: teamIds.length,
        eventTeamIds: teamIds,
        problemsCoordination: { battle: { plugin: "battle", stateBudget: forecast, scoreMode } },
        budget,
      });
      expect(report.refusals).toHaveLength(1);
      expect(report.refusals[0]?.forecastBytes).toBe(
        forecastCoordinationStateBytes(forecast, 99, teamIds),
      );
      const warnings = warnOnCoordinationCapacity({
        problems: [{ problemId: SCOPE.problemId }],
        teamCount: teamIds.length,
        teamIds,
        problemsCoordination: { battle: { plugin: "battle", stateBudget: forecast, scoreMode } },
        budget,
        tenantId: SCOPE.tenantId,
        eventId: SCOPE.eventId,
      });
      expect(warnings[0]?.kind).toBe("over");
      expect(warnings[0]?.message).toContain(`at most ${report.refusals[0]?.maxTeams} teams`);
    }

    const maxTeams = maxTeamsForCoordinationBudget(forecast, budget, teamIds);
    expect(maxTeams).toBeGreaterThan(0);
    expect(maxTeams).toBeLessThan(teamIds.length);
    expect(checkCoordinationCapacity(forecast, maxTeams + 1, budget, teamIds).kind).toBe("over");
    const admittedTeamIds = teamIds.slice(0, maxTeams);
    const admitted = checkBulkDeployCoordinationCapacity({
      problems: [{ problemId: SCOPE.problemId }],
      eventTeamCount: maxTeams,
      eventTeamIds: admittedTeamIds,
      problemsCoordination: { battle: { plugin: "battle", stateBudget: forecast } },
      budget,
    });
    expect(admitted.refusals).toEqual([]);
    expect(admitted.tight[0]?.maxTeams).toBe(maxTeams);
    const pluginBytes = forecast.baseBytes + forecast.bytesPerTeam * maxTeams;
    const { state, delivery } = worstTransition(admittedTeamIds, pluginBytes);
    expect(serializedStateBytes(state)).toBe(pluginBytes);
    expect(
      await writeCoordinationState(store, SCOPE, state, 0, NOW, Number.MAX_SAFE_INTEGER, delivery),
    ).toEqual({ kind: "ok" });
    // A retry can retain every failed team and add a cursor. That larger envelope
    // must fit as well, even though acknowledge does not run the state-size guard.
    await repository.acknowledgeCoordinationScores(SCOPE, 1, [], admittedTeamIds[0]);
    const saved = await repository.readCoordinationState(SCOPE);
    expect(saved?.state).toMatchObject({
      state,
      pendingScores: { ...delivery, resumeAfterTeamId: admittedTeamIds[0] },
    });
    const storedBytes = serializedStateBytes(saved?.state);
    expect(storedBytes).toBeLessThanOrEqual(budget.maxBytes);
    expect(storedBytes).toBeLessThanOrEqual(admitted.tight[0]?.forecastBytes);
  });
});

it("measures JSON-escaped UTF-8 IDs for the advertised maximum rather than assuming ULIDs", () => {
  const forecast = { baseBytes: 1000, bytesPerTeam: 1000 };
  const budget = coordinationStateBudget({ kind: "dynamodb" });
  const shortIds = ["0".repeat(26)];
  const escapedIds = ['日本語\u0000\n\\"'.repeat(200)];
  expect(maxTeamsForCoordinationBudget(forecast, budget, escapedIds)).toBeLessThan(
    maxTeamsForCoordinationBudget(forecast, budget, shortIds),
  );
  expect(forecastCoordinationStateBytes(forecast, 99, escapedIds)).toBeGreaterThan(
    forecastCoordinationStateBytes(forecast, 99, shortIds),
  );
});
