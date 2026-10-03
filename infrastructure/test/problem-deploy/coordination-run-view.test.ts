import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoordinationRunPointer } from "../../lib/problem-deploy/control-data/domain/coordination-run.js";
import { lookupTeamByLoginKey } from "../../lib/problem-deploy/handlers/participant-handler/lookup.js";
import { buildParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared.js";
import { setDisplayTeamName } from "../../lib/problem-deploy/handlers/participant-handler/update.js";
import { fakeParticipantShared } from "./coordination.test-helpers.js";

const row = {
  PK: "DEPLOYMENT#team-deployment",
  SK: "META",
  jobId: "team-deployment",
  tenantId: "tenant-1",
  eventId: "event-1",
  teamId: "team-1",
  problemId: "battle",
  teamName: "Alpha",
  status: "COMPLETE",
  createdAt: "2026-06-01T00:00:00Z",
};

function fixture(coordinationProblemIds = ["battle"]) {
  let pointer: CoordinationRunPointer | undefined;
  const pointerRead = vi.fn(() => ({ Item: pointer }));
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof QueryCommand) return { Items: [row] };
    if (command instanceof GetCommand) {
      if (String(command.input.Key?.PK).startsWith("COORDRUN#")) return pointerRead();
      return {};
    }
    if (command instanceof UpdateCommand)
      return { Attributes: { ...row, displayTeamName: "Renamed" } };
    throw new Error("unexpected mutation");
  });
  return {
    shared: { ...fakeParticipantShared(send), coordinationProblemIds },
    send,
    pointerRead,
    setPointer: (next: CoordinationRunPointer | undefined) => {
      pointer = next;
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("participant coordination run view", () => {
  it.each([
    ["absent", undefined, "default"],
    ["initial", { runId: "default", startedAt: "", history: [] }, "default"],
    ["rotated", { runId: "next-run", startedAt: "", history: ["default"] }, "next-run"],
  ] as const)(
    "publishes the %s pointer without creating or resetting a run",
    async (_label, pointer, expected) => {
      const test = fixture();
      test.setPointer(pointer);
      const view = await lookupTeamByLoginKey(test.shared, "key");
      expect(view?.problems[0]).toMatchObject({
        jobId: "team-deployment",
        coordinationRunId: expected,
      });
      expect(test.pointerRead).toHaveBeenCalledTimes(1);
      expect(
        test.send.mock.calls.every(
          ([command]) => command instanceof GetCommand || command instanceof QueryCommand,
        ),
      ).toBe(true);
      const pointerCommand = test.send.mock.calls
        .map(([command]) => command)
        .find(
          (command) =>
            command instanceof GetCommand && String(command.input.Key?.PK).startsWith("COORDRUN#"),
        ) as GetCommand;
      expect(pointerCommand.input.ConsistentRead).toBe(true);
    },
  );

  it("refreshes the pointer while retaining the deployment identity", async () => {
    const test = fixture();
    const before = await lookupTeamByLoginKey(test.shared, "key");
    test.setPointer({ runId: "next-run", startedAt: "", history: ["default"] });
    const after = await lookupTeamByLoginKey(test.shared, "key");
    expect(before?.problems[0]?.coordinationRunId).toBe("default");
    expect(after?.problems[0]?.coordinationRunId).toBe("next-run");
    expect(after?.problems[0]?.jobId).toBe(before?.problems[0]?.jobId);
  });

  it.each([[[]], [["other-problem"]]])(
    "does not read pointers for unconfigured problems %j",
    async (ids) => {
      const test = fixture(ids);
      const view = await lookupTeamByLoginKey(test.shared, "key");
      expect(view?.problems[0]).not.toHaveProperty("coordinationRunId");
      expect(test.pointerRead).not.toHaveBeenCalled();
    },
  );

  it("does not silently fall back to a deployment id when the pointer read fails", async () => {
    const test = fixture();
    test.pointerRead.mockImplementation(() => {
      throw new Error("pointer unavailable");
    });
    await expect(lookupTeamByLoginKey(test.shared, "key")).rejects.toThrow("pointer unavailable");
  });

  it("keeps the shared pointer on the renamed team response", async () => {
    const test = fixture();
    test.setPointer({ runId: "next-run", startedAt: "", history: ["default"] });
    const result = await setDisplayTeamName(test.shared, "key", "Renamed");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("rename failed");
    expect(result.view.team.teamName).toBe("Renamed");
    expect(result.view.problems[0]).toMatchObject({
      jobId: "team-deployment",
      coordinationRunId: "next-run",
    });
    expect(test.pointerRead).toHaveBeenCalledTimes(1);
  });

  it("loads only the configured problem ids from bundled catalog data", () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "test");
    vi.stubEnv("COORDINATION_PROBLEM_IDS", JSON.stringify(["battle"]));
    const test = fixture();
    const resources = buildParticipantSharedResources(test.shared.runtime, test.shared.ddb);
    expect(resources.coordinationProblemIds).toEqual(["battle"]);
  });
});
