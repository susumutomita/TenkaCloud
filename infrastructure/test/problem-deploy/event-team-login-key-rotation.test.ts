import { describe, expect, it, vi } from "vitest";
import { rotateTeamLoginKey } from "../../lib/problem-deploy/handlers/event-handler/rotate-team-login-key";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

function sharedWith(overrides: {
  readonly team?: Record<string, unknown>;
  readonly deployments?: readonly Record<string, unknown>[];
  readonly rotateOutcome?: "updated" | "conflict";
}) {
  const teams = {
    getTeam: vi.fn().mockResolvedValue(overrides.team),
    rotateLoginKey: vi.fn().mockResolvedValue({ outcome: overrides.rotateOutcome ?? "updated" }),
  };
  const deployments = {
    listByTenantAndEvent: vi.fn().mockResolvedValue(overrides.deployments ?? []),
  };
  const shared = {
    runtime: {
      resolveTeamsRepository: vi.fn().mockResolvedValue(teams),
      resolveDeploymentsRepository: vi.fn().mockResolvedValue(deployments),
    },
    ddb: {},
    teamsTableName: "Teams",
    deploymentsTableName: "Deployments",
  } as unknown as EventSharedResources;
  return { shared, teams, deployments };
}

describe("rotateTeamLoginKey", () => {
  it("should return not_found without generating a credential for an unknown team", async () => {
    const { shared, teams, deployments } = sharedWith({});
    const generate = vi.fn(() => "NEW-KEY");

    await expect(
      rotateTeamLoginKey(shared, "tenant-a", "event-1", "team-1", 1_700_000_000_000, generate),
    ).resolves.toEqual({ kind: "not_found" });
    expect(generate).not.toHaveBeenCalled();
    expect(deployments.listByTenantAndEvent).not.toHaveBeenCalled();
    expect(teams.rotateLoginKey).not.toHaveBeenCalled();
  });

  it("should rotate only participant-resolvable deployment indexes and return plaintext once", async () => {
    const { shared, teams } = sharedWith({
      team: {
        teamId: "team-1",
        eventId: "event-1",
        tenantId: "tenant-a",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      deployments: [
        {
          jobId: "active",
          teamId: "team-1",
          status: "COMPLETE",
          createdAt: "2026-07-15T00:00:00Z",
        },
        {
          jobId: "other-team",
          teamId: "team-2",
          status: "COMPLETE",
          createdAt: "2026-07-15T00:00:00Z",
        },
        {
          jobId: "deleted",
          teamId: "team-1",
          status: "DELETED",
          createdAt: "2026-07-15T00:00:00Z",
        },
      ],
    });

    const result = await rotateTeamLoginKey(
      shared,
      "tenant-a",
      "event-1",
      "team-1",
      1_700_000_000_000,
      () => "NEW-KEY",
    );

    expect(result).toEqual({
      kind: "ok",
      teamId: "team-1",
      teamLoginKey: "NEW-KEY",
      rotatedAt: "2023-11-14T22:13:20.000Z",
    });
    expect(teams.rotateLoginKey).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      eventId: "event-1",
      teamId: "team-1",
      newLoginKey: "NEW-KEY",
      expectedUpdatedAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2023-11-14T22:13:20.000Z",
      deployments: [{ jobId: "active", createdAt: "2026-07-15T00:00:00Z" }],
    });
  });

  it("should return a conflict outcome when the atomic write loses a race", async () => {
    const { shared } = sharedWith({
      team: { teamId: "team-1", updatedAt: "2026-07-14T00:00:00.000Z" },
      rotateOutcome: "conflict",
    });

    await expect(
      rotateTeamLoginKey(shared, "tenant-a", "event-1", "team-1", 0, () => "NEW-KEY"),
    ).resolves.toEqual({ kind: "conflict" });
  });
});
