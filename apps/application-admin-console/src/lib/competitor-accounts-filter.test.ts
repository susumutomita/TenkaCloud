import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import {
  filterVerifiedAccounts,
  formatCompetitorAccountsLoadError,
} from "./competitor-accounts-filter";

describe("filterVerifiedAccounts (Issue #671)", () => {
  it("null は空配列を返すべき", () => {
    expect(filterVerifiedAccounts(null)).toEqual([]);
  });

  it("verified=true のみ通すべき", () => {
    const accounts = [
      {
        awsAccountId: "111111111111",
        region: "ap-northeast-1",
        competitorRoleName: "Role",
        verified: true,
        createdAt: "",
        updatedAt: "",
      },
      {
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "Role",
        verified: false,
        createdAt: "",
        updatedAt: "",
      },
    ];
    expect(filterVerifiedAccounts(accounts).map((a) => a.awsAccountId)).toEqual(["111111111111"]);
  });

  it('verified が string "true" / number 1 の truthy 値も通すべき (= ABI 揺れ対策)', () => {
    const accounts = [
      {
        awsAccountId: "111111111111",
        region: "ap-northeast-1",
        competitorRoleName: "Role",
        verified: "true" as unknown as boolean,
        createdAt: "",
        updatedAt: "",
      },
      {
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "Role",
        verified: 1 as unknown as boolean,
        createdAt: "",
        updatedAt: "",
      },
    ];
    expect(filterVerifiedAccounts(accounts).length).toBe(2);
  });
});

describe("formatCompetitorAccountsLoadError (Issue #815)", () => {
  it("ApiError 401 は friendly 再ログインメッセージに flip すべき", () => {
    const msg = formatCompetitorAccountsLoadError(
      new ApiError(StatusCodes.UNAUTHORIZED, "missing_tenant_claim"),
    );
    expect(msg).toMatch(/再ログイン/);
  });

  it("ApiError 500 等の他 status は raw message を返すべき (= dev debug)", () => {
    const msg = formatCompetitorAccountsLoadError(
      new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "DynamoDB throttle"),
    );
    expect(msg).toContain("DynamoDB throttle");
  });

  it("Error 以外 (= 文字列 / null 等) は String() で safe stringify すべき", () => {
    expect(formatCompetitorAccountsLoadError("plain string")).toBe("plain string");
    expect(formatCompetitorAccountsLoadError(null)).toBe("null");
  });
});
