import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import {
  getTeamCredentialStatus,
  registerTeamCredential,
  revokeTeamCredential,
} from "../../src/api/team-credentials-client";

/**
 * team cloud credential API client の path / body / verb を pin。
 */

function fakeClient(getResponse: unknown = {}) {
  const put = vi
    .fn()
    .mockResolvedValue({ registered: true, provider: "sakura", teamSlug: "team-a" });
  const del = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue(getResponse);
  const client = { put, del, get } as unknown as ApiClient;
  return { client, put, del, get };
}

describe("team-credentials-client", () => {
  it("should PUT the credential to the per-team provider path (register/rotate)", async () => {
    const { client, put } = fakeClient();
    const res = await registerTeamCredential(client, "sakura", "team-a", { accessToken: "x" });
    expect(res.registered).toBe(true);
    expect(put).toHaveBeenCalledWith("admin/team-cloud-credentials/sakura/team-a", {
      accessToken: "x",
    });
  });

  it("should encode provider + teamSlug into the path", async () => {
    const { client, put } = fakeClient();
    await registerTeamCredential(client, "azure", "team a/b", { clientId: "c" });
    expect(put).toHaveBeenCalledWith("admin/team-cloud-credentials/azure/team%20a%2Fb", {
      clientId: "c",
    });
  });

  it("should DELETE for revoke", async () => {
    const { client, del } = fakeClient();
    await revokeTeamCredential(client, "gcp", "team-a");
    expect(del).toHaveBeenCalledWith("admin/team-cloud-credentials/gcp/team-a");
  });

  it("should GET the status (registered boolean, no secret)", async () => {
    const { client, get } = fakeClient({
      provider: "sakura",
      teamSlug: "team-a",
      registered: true,
    });
    const status = await getTeamCredentialStatus(client, "sakura", "team-a");
    expect(status.registered).toBe(true);
    expect(get).toHaveBeenCalledWith("admin/team-cloud-credentials/sakura/team-a");
  });
});
