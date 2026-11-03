import { describe, expect, it, vi } from "vitest";
import {
  type ParticipantSharedResources,
  queryTeamItems,
} from "../../lib/problem-deploy/handlers/participant-handler/shared.js";
import { mcpConfigFixture } from "./mcp-oauth-fixture.js";

describe("OAuth team authorization uses current deployment META rows without a team bearer key", () => {
  function fixture() {
    const binding = mcpConfigFixture().bindings[0];
    if (!binding) throw new Error("Missing test binding");
    const row = {
      jobId: binding.jobIds[0],
      tenantId: binding.tenantId,
      eventId: binding.eventId,
      teamId: binding.teamId,
      expiresAt: Date.now() / 1000 + 3600,
    };
    const getDeployment = vi.fn(async () => row as typeof row | undefined);
    const listByTeamLoginKey = vi.fn();
    const shared = {
      runtime: {
        resolveDeploymentsRepository: async () => ({ getDeployment, listByTeamLoginKey }),
      },
      mcpTeam: { binding, expiresAt: Date.now() / 1000 + 300, allowSubmit: true },
    } as unknown as ParticipantSharedResources;
    return { shared, row, getDeployment, listByTeamLoginKey, binding };
  }
  it("reads only explicitly pinned jobs using consistent reads and never queries another credential", async () => {
    const f = fixture();
    const rows = await queryTeamItems(f.shared, "");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.teamId).toBe(f.binding.teamId);
    expect(rows[0]?.teamLoginKey).toBeUndefined();
    expect(f.getDeployment).toHaveBeenCalledExactlyOnceWith(f.binding.jobIds[0], {
      consistentRead: true,
    });
    expect(f.listByTeamLoginKey).not.toHaveBeenCalled();
  });
  it("rejects deleted, expired, moved or foreign rows and never falls back to a raw key", async () => {
    for (const patch of [
      { tenantId: "other" },
      { eventId: "other" },
      { teamId: "other" },
      { expiresAt: 1 },
    ]) {
      const f = fixture();
      f.getDeployment.mockResolvedValue({ ...f.row, ...patch });
      expect(await queryTeamItems(f.shared, "")).toEqual([]);
      expect(f.listByTeamLoginKey).not.toHaveBeenCalled();
    }
    const missing = fixture();
    missing.getDeployment.mockResolvedValue(undefined);
    expect(await queryTeamItems(missing.shared, "")).toEqual([]);
    const mixed = fixture();
    expect(await queryTeamItems(mixed.shared, "another-team-key")).toEqual([]);
    expect(mixed.listByTeamLoginKey).not.toHaveBeenCalled();
    const expired = fixture();
    const principal = expired.shared.mcpTeam;
    if (!principal) throw new Error("Missing test principal");
    expect(
      await queryTeamItems({ ...expired.shared, mcpTeam: { ...principal, expiresAt: 1 } }, ""),
    ).toEqual([]);
  });
});
