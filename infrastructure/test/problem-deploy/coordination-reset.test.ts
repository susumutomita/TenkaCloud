import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { resetCoordinationRun } from "../../lib/problem-deploy/handlers/event-handler/coordination-reset";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * [Issue #3126] The coordination namespace is `tenant x event x problem x run`,
 * so re-deploying a problem into the same event lands on the same key. Event
 * teardown was the only lifecycle that removed the row, so the "new" match
 * silently resumed the previous one's state, version, ledger and scores. The
 * reset is a separate operator gesture rather than a hook on deploy, because
 * `bulkDeployEvent` runs against live events (late-joining teams, failed-stack
 * retries) and the state is shared by every team on the problem.
 *
 * [Issue #3153] What the reset DOES changed: it starts a new run instead of
 * deleting the namespace. The match in progress still ends — the next operation
 * rebuilds from `plugin.initialState` — but the run that just ended stays
 * readable under its own id. An operator resets because something went wrong,
 * and the old reset destroyed the evidence of what went wrong as its first act.
 */

/**
 * A DynamoDB whose items persist across commands.
 *
 * The pointer is the whole subject here, so a fake that forgot it between calls
 * could not tell a rotation from a no-op: every reset would read "no pointer",
 * rotate from the initial run, and look like it worked.
 */
function buildShared(deployments: readonly Record<string, unknown>[]): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  items: Map<string, Record<string, unknown>>;
} {
  const items = new Map<string, Record<string, unknown>>();
  const keyOf = (key: Record<string, unknown> | undefined) => `${key?.PK}/${key?.SK}`;
  const ddbSend = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof QueryCommand) return { Items: [...deployments] };
    if (cmd instanceof GetCommand) return { Item: items.get(keyOf(cmd.input.Key)) };
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Record<string, unknown>;
      const stored = items.get(`${item.PK}/${item.SK}`);
      // Mimic the conditional the adapter relies on, so a rotation that should
      // lose actually loses.
      const expected = cmd.input.ExpressionAttributeValues?.[":expected"];
      if (expected !== undefined && stored && stored.runId !== expected) {
        throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
      }
      items.set(`${item.PK}/${item.SK}`, item);
      return {};
    }
    if (cmd instanceof DeleteCommand) {
      items.delete(keyOf(cmd.input.Key));
      return {};
    }
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
  return { shared, ddbSend, items };
}

const deployment = (problemId: string, teamId: string) => ({
  jobId: `job-${problemId}-${teamId}`,
  tenantId: "tenant-acme",
  eventId: "EV1",
  teamId,
  problemId,
  status: "COMPLETE",
});

const deleteKeys = (ddbSend: ReturnType<typeof vi.fn>) =>
  ddbSend.mock.calls
    .map((call) => call[0])
    .filter((cmd): cmd is DeleteCommand => cmd instanceof DeleteCommand)
    .map((cmd) => `${cmd.input.Key?.PK}/${cmd.input.Key?.SK}`);

describe("resetCoordinationRun (#3153)", () => {
  it("should start a new run and report which run it replaced", async () => {
    const { shared } = buildShared([
      deployment("battle-a", "team-1"),
      deployment("battle-a", "team-2"),
    ]);

    const outcome = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");

    expect(outcome.kind).toBe("ok");
    expect(outcome.kind === "ok" && outcome.result).toMatchObject({
      eventId: "EV1",
      problemId: "battle-a",
      // The first run of every (event, problem) keeps the old constant, which
      // is what lets a match that predates this change keep playing.
      previousRunId: "default",
    });
    expect(outcome.kind === "ok" && outcome.result.runId).not.toBe("default");
  });

  it("should leave the previous run's state readable instead of deleting it", async () => {
    const { shared, ddbSend } = buildShared([deployment("battle-a", "team-1")]);

    await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");

    // This is the behaviour change. The match is over — the next operation
    // rebuilds from `initialState` under the new run — but the one that just
    // ended is still there to look at.
    expect(deleteKeys(ddbSend)).not.toContain("COORD#tenant-acme#EV1#battle-a#default/STATE");
  });

  it("should point participants at the new run afterwards", async () => {
    const { shared, items } = buildShared([deployment("battle-a", "team-1")]);

    const outcome = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");

    const pointer = items.get("COORDRUN#tenant-acme#EV1#battle-a/CURRENT");
    expect(pointer?.runId).toBe(outcome.kind === "ok" ? outcome.result.runId : undefined);
    expect(pointer?.history).toEqual(["default"]);
  });

  it("should mint a distinct run every time, never reusing one", async () => {
    const { shared } = buildShared([deployment("battle-a", "team-1")]);

    const first = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");
    const second = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");

    // A reused id would walk a new match into the previous run's tombstoned
    // artifact prefix, and would make "history" meaningless.
    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
    expect(first.kind === "ok" && second.kind === "ok" && first.result.runId).not.toBe(
      second.kind === "ok" ? second.result.runId : "",
    );
    expect(second.kind === "ok" && second.result.previousRunId).toBe(
      first.kind === "ok" ? first.result.runId : "",
    );
  });

  it("should retire runs that fall out of the retention window, with their state", async () => {
    const { shared, ddbSend } = buildShared([deployment("battle-a", "team-1")]);

    const runIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const outcome = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");
      if (outcome.kind === "ok") runIds.push(outcome.result.previousRunId);
    }

    // History is a debrief, not an archive: every retained run is a full state
    // row plus its artifacts, and #3151 measured what one of those costs.
    const deleted = deleteKeys(ddbSend);
    expect(deleted).toContain("COORD#tenant-acme#EV1#battle-a#default/STATE");
    expect(deleted).not.toContain(`COORD#tenant-acme#EV1#battle-a#${runIds.at(-1)}/STATE`);
  });

  it("should reset only the named problem, leaving other matches in the event alone", async () => {
    const { shared, items } = buildShared([
      deployment("battle-a", "team-1"),
      deployment("battle-b", "team-1"),
    ]);

    await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");

    expect(items.has("COORDRUN#tenant-acme#EV1#battle-b/CURRENT")).toBe(false);
  });

  it("should report not_found when the event never deployed that problem", async () => {
    const { shared, ddbSend } = buildShared([deployment("battle-a", "team-1")]);

    // Without this guard a mistyped problemId returns a cheerful success and
    // the operator believes they reset a match they did not touch.
    const outcome = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battel-a");

    expect(outcome).toEqual({ kind: "not_found" });
    expect(ddbSend.mock.calls.some((call) => call[0] instanceof PutCommand)).toBe(false);
  });

  it("should report a conflict rather than silently discarding a concurrent reset", async () => {
    const { shared, items } = buildShared([deployment("battle-a", "team-1")]);
    await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");

    // Another operator's rotation lands between this one's read and its write.
    const pointerKey = "COORDRUN#tenant-acme#EV1#battle-a/CURRENT";
    const stored = items.get(pointerKey);
    const raced = { ...stored, runId: "rSOMEONEELSE" };
    const original = shared.ddb.send.bind(shared.ddb);
    let reads = 0;
    (shared.ddb as { send: (cmd: unknown) => Promise<unknown> }).send = async (cmd: unknown) => {
      if (cmd instanceof GetCommand && `${cmd.input.Key?.PK}/${cmd.input.Key?.SK}` === pointerKey) {
        reads += 1;
        // The first read sees the old pointer; the winner writes before this
        // caller gets to its own write.
        if (reads === 1) {
          const result = await original(cmd as never);
          items.set(pointerKey, raced);
          return result;
        }
      }
      return original(cmd as never);
    };

    const outcome = await resetCoordinationRun(shared, "tenant-acme", "EV1", "battle-a");

    // Two operators resetting at once must not end up with two runs started and
    // one silently discarded.
    expect(outcome).toEqual({ kind: "conflict" });
    expect(items.get(pointerKey)?.runId).toBe("rSOMEONEELSE");
  });
});
