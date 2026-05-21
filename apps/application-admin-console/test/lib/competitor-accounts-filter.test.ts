import { describe, expect, it } from "vitest";
import type { CompetitorAccountSummary } from "../../src/api/competitor-accounts-client";
import { filterVerifiedAccounts } from "../../src/lib/competitor-accounts-filter";

function row(verified: unknown, accountId = "123456789012"): CompetitorAccountSummary {
  return {
    awsAccountId: accountId,
    region: "ap-northeast-1",
    competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
    verified: verified as boolean,
    createdAt: "2026-05-13T00:00:00Z",
    updatedAt: "2026-05-13T00:00:00Z",
  };
}

describe("filterVerifiedAccounts", () => {
  it("should return only rows where verified=true", () => {
    const out = filterVerifiedAccounts([row(true, "1"), row(false, "2")]);
    expect(out).toHaveLength(1);
    expect(out[0].awsAccountId).toBe("1");
  });

  it("should return an empty array for null input (= loading)", () => {
    expect(filterVerifiedAccounts(null)).toEqual([]);
  });

  it('should NOT reject when backend returns string "true" (= defensive)', () => {
    const out = filterVerifiedAccounts([row("true", "1"), row("", "2")]);
    expect(out).toHaveLength(1);
    expect(out[0].awsAccountId).toBe("1");
  });

  it("should NOT reject when backend returns number 1 (= defensive)", () => {
    const out = filterVerifiedAccounts([row(1, "1"), row(0, "2")]);
    expect(out).toHaveLength(1);
    expect(out[0].awsAccountId).toBe("1");
  });

  it("should return an empty array for empty input", () => {
    expect(filterVerifiedAccounts([])).toEqual([]);
  });
});
