import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import {
  filterVerifiedAccounts,
  formatCompetitorAccountsLoadError,
} from "./competitor-accounts-filter";

describe("filterVerifiedAccounts (Issue #671)", () => {
  it("should return an empty array for null", () => {
    expect(filterVerifiedAccounts(null)).toEqual([]);
  });

  it("should pass through only verified=true", () => {
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

  it('should also pass truthy values such as string "true" / number 1 for verified (= ABI drift guard)', () => {
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
  it("should flip ApiError 401 into a friendly re-login message", () => {
    const msg = formatCompetitorAccountsLoadError(
      new ApiError(StatusCodes.UNAUTHORIZED, "missing_tenant_claim"),
    );
    expect(msg).toMatch(/再ログイン/);
  });

  it("should return raw message for other statuses such as ApiError 500 (= dev debug)", () => {
    const msg = formatCompetitorAccountsLoadError(
      new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "DynamoDB throttle"),
    );
    expect(msg).toContain("DynamoDB throttle");
  });

  it("should safe-stringify non-Error values via String() (= e.g. string / null)", () => {
    expect(formatCompetitorAccountsLoadError("plain string")).toBe("plain string");
    expect(formatCompetitorAccountsLoadError(null)).toBe("null");
  });
});
