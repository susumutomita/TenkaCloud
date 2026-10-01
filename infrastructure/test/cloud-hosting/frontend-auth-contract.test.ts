import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeIdToken,
  resolveTenantConsoleAccess,
} from "../../../apps/application-admin-console/src/auth/claims.js";
import { createCoreApiClient } from "../../../packages/web-kit/src/api-client.js";

afterEach(() => vi.unstubAllGlobals());
describe("existing organizer frontend bearer and role contract", () => {
  it.each(["Admin", "Operator", "Viewer"])(
    "uses the ID token and recognizes %s without tenant claims",
    async (role) => {
      const claims = {
        sub: "test-organizer",
        token_use: "id",
        aud: "organizer-client",
        "custom:userRole": role,
      };
      const session = {
        idToken: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-signature`,
        accessToken: "distinct-access-token",
        refreshToken: "distinct-refresh-token",
        expiresAt: Date.now() + 60_000,
      };
      const fetchMock = vi.fn(async () => Response.json({ items: [] }));
      vi.stubGlobal("fetch", fetchMock);
      await createCoreApiClient("https://api.example.test", session.idToken).get("events");
      expect(fetchMock).toHaveBeenCalledWith(
        new URL("https://api.example.test/events"),
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: `Bearer ${session.idToken}` }),
        }),
      );
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(session.accessToken);
      const decoded = decodeIdToken(session.idToken);
      expect(decoded?.["custom:tenantId"]).toBeUndefined();
      expect(resolveTenantConsoleAccess(decoded).canMutateTenant).toBe(role !== "Viewer");
    },
  );
  it("pins the real React session selector to idToken rather than accessToken", () => {
    const source = readFileSync(
      new URL("../../../apps/application-admin-console/src/api/client.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("createApiClient(config.apiBaseUrl, auth.tokens.idToken)");
    expect(source).not.toContain("createApiClient(config.apiBaseUrl, auth.tokens.accessToken)");
  });
});
