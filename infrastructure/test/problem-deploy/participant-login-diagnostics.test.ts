import { describe, expect, it, vi } from "vitest";
import { hashLoginKey } from "../../lib/problem-deploy/control-data/sql-teams-repository";
import type { DeploymentItem } from "../../lib/problem-deploy/handlers/deploy-handler/types";
import {
  classifyLoginLookupMiss,
  loginKeyHashPrefix,
  warnLoginUnauthorized,
} from "../../lib/problem-deploy/handlers/participant-handler/login-diagnostics";

const row = (status?: string): Partial<DeploymentItem> =>
  ({ jobId: "J", ...(status ? { status } : {}) }) as Partial<DeploymentItem>;

describe("classifyLoginLookupMiss (Issue #2675)", () => {
  it("should report no_rows when there are zero deployment rows", () => {
    expect(classifyLoginLookupMiss([])).toBe("no_rows");
  });

  it("should report all_deleted when every row is DELETED / DELETING (operator teardown)", () => {
    expect(classifyLoginLookupMiss([row("DELETED"), row("DELETING")])).toBe("all_deleted");
  });

  it("should report no_live_sample when a row is lifecycle-expired (EXPIRED / AUTO_DELETED)", () => {
    expect(classifyLoginLookupMiss([row("EXPIRED")])).toBe("no_live_sample");
    expect(classifyLoginLookupMiss([row("AUTO_DELETED"), row("DELETED")])).toBe("no_live_sample");
  });

  it("should treat a status-less row as the no_live_sample catch-all (default PENDING)", () => {
    expect(classifyLoginLookupMiss([row()])).toBe("no_live_sample");
  });
});

describe("loginKeyHashPrefix (Issue #2675)", () => {
  it("should return the first 8 chars of the canonical SHA-256 login-key hash", () => {
    expect(loginKeyHashPrefix("SECRET_KEY")).toBe(hashLoginKey("SECRET_KEY").slice(0, 8));
  });

  it("should never contain the plaintext key and be a stable lowercase hex prefix", () => {
    const prefix = loginKeyHashPrefix("SECRET_DO_NOT_LEAK");
    expect(prefix).toHaveLength(8);
    expect(prefix).not.toContain("SECRET");
    expect(prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(loginKeyHashPrefix("SECRET_DO_NOT_LEAK")).toBe(prefix);
  });
});

describe("warnLoginUnauthorized (Issue #2675)", () => {
  it("should emit one structured warn line with reason + hash prefix + rowCount, never the plaintext key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnLoginUnauthorized("SECRET_DO_NOT_LEAK", [row("DELETED")]);
      expect(warn).toHaveBeenCalledOnce();
      const line = warn.mock.calls[0]?.[0] as string;
      expect(line).not.toContain("SECRET_DO_NOT_LEAK");
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        event: "portal.login.unauthorized",
        level: "warn",
        component: "problem-deploy",
        reason: "all_deleted",
        keyHashPrefix: hashLoginKey("SECRET_DO_NOT_LEAK").slice(0, 8),
        rowCount: 1,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("should emit no_rows with rowCount 0 for a key that matched no rows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnLoginUnauthorized("KEY", []);
      const parsed = JSON.parse(warn.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(parsed.reason).toBe("no_rows");
      expect(parsed.rowCount).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
