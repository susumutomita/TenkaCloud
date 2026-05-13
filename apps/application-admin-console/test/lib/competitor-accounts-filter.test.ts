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
  it("verified=true な行のみを返すべき", () => {
    const out = filterVerifiedAccounts([row(true, "1"), row(false, "2")]);
    expect(out).toHaveLength(1);
    expect(out[0].awsAccountId).toBe("1");
  });

  it("null 入力 (= 読み込み中) は空配列を返すべき", () => {
    expect(filterVerifiedAccounts(null)).toEqual([]);
  });

  it('backend が万一 string "true" で返してきても弾かないべき (= defensive)', () => {
    const out = filterVerifiedAccounts([row("true", "1"), row("", "2")]);
    expect(out).toHaveLength(1);
    expect(out[0].awsAccountId).toBe("1");
  });

  it("backend が number 1 で返してきても弾かないべき (= defensive)", () => {
    const out = filterVerifiedAccounts([row(1, "1"), row(0, "2")]);
    expect(out).toHaveLength(1);
    expect(out[0].awsAccountId).toBe("1");
  });

  it("空配列入力は空配列を返すべき", () => {
    expect(filterVerifiedAccounts([])).toEqual([]);
  });
});
