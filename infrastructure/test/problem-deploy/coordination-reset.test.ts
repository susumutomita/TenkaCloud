import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { resetCoordinationRun } from "../../lib/problem-deploy/handlers/event-handler/coordination-reset";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * [Issue #3126] The coordination namespace is `tenant x event x problem x run`
 * and the platform issues one run id per `(event, problem)`, so re-deploying a
 * problem into the same event lands on the same key. Event teardown was the
 * only lifecycle that removed the row, so the "new" match silently resumed the
 * previous one's state, version, ledger and scores.
 *
 * The reset is a separate operator gesture rather than a hook on deploy,
 * because `bulkDeployEvent` runs against live events (late-joining teams,
 * failed-stack retries) and the state is shared by every team on the problem.
 * These tests pin the operation and the guard that keeps a typo from reading as
 * a successful reset.
 */

function buildShared(deployments: readonly Record<string, unknown>[]): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof QueryCommand) return { Items: [...deployments] };
    if (cmd instanceof DeleteCommand) return {};
    return {};
  });
  const shared: EventSharedResources = {
    runtime: makeTestControlDataRuntime(),
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    eventBusName: "test-bus",
    env: "development",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: { send: vi.fn() } as unknown as EventSharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

const deployment = (problemId: string, teamId: string) => ({
  jobId: `job-${problemId}-${teamId}`,
  tenantId: "tenant-acme",
  eventId: "EV1",
  teamId,
  problemId,
  status: "COMPLETE",
});

describe("resetCoordinationRun", () => {
  it("should delete the match's coordination state and report the namespace", async () => {
    const { shared, ddbSend } = buildShared([
      deployment("battle-a", "team-1"),
      deployment("battle-a", "team-2"),
    ]);

    const outcome = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");

    expect(outcome).toEqual({
      kind: "ok",
      result: { eventId: "EV1", problemId: "battle-a", runId: "default" },
    });
    const deletedKeys = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is DeleteCommand => c instanceof DeleteCommand)
      .map((c) => `${c.input.Key?.PK}/${c.input.Key?.SK}`);
    // The scoped row is the reset. The pre-scope row and the match secret ride
    // along because they belong to the same match — leaving the secret would
    // let the restarted match inherit the old one's hidden material.
    expect(deletedKeys).toContain("COORD#tenant-acme#EV1#battle-a#default/STATE");
    expect(deletedKeys).toContain("COORD#tenant-acme#EV1#battle-a#default/MATCHSECRET");
  });

  it("should reset only the named problem, leaving other matches in the event alone", async () => {
    const { shared, ddbSend } = buildShared([
      deployment("battle-a", "team-1"),
      deployment("battle-b", "team-1"),
    ]);

    await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");

    const deletedPks = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is DeleteCommand => c instanceof DeleteCommand)
      .map((c) => String(c.input.Key?.PK));
    expect(deletedPks.some((pk) => pk.includes("battle-b"))).toBe(false);
  });

  it("should report not_found when the event never deployed that problem", async () => {
    const { shared, ddbSend } = buildShared([deployment("battle-a", "team-1")]);

    // Without this guard a mistyped problemId returns a cheerful success and
    // the operator believes they reset a match they did not touch.
    const outcome = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battel-a");

    expect(outcome).toEqual({ kind: "not_found" });
    expect(ddbSend.mock.calls.some((c) => c[0] instanceof DeleteCommand)).toBe(false);
  });

  it("should stay idempotent so a repeated reset still succeeds", async () => {
    const { shared } = buildShared([deployment("battle-a", "team-1")]);

    const first = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");
    const second = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");

    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
  });
});
