import { describe, expect, it } from "vitest";
import { parseTeamCountInput, resizeTeamRows, validateTeamRows } from "../../src/pages/EventCreate";

describe("resizeTeamRows", () => {
  it("should return the same array reference when team count is unchanged", () => {
    const rows = [{ internalSlug: "team-1", awsAccountId: "111111111111" }];

    expect(resizeTeamRows(rows, 1)).toBe(rows);
  });

  it("should drop trailing rows when team count is reduced", () => {
    expect(
      resizeTeamRows(
        [
          { internalSlug: "team-1", awsAccountId: "111111111111" },
          { internalSlug: "team-2", awsAccountId: "222222222222" },
        ],
        1,
      ),
    ).toEqual([{ internalSlug: "team-1", awsAccountId: "111111111111" }]);
  });

  it("should keep existing rows and append empty new rows when team count is increased", () => {
    expect(resizeTeamRows([{ internalSlug: "team-1", awsAccountId: "111111111111" }], 3)).toEqual([
      { internalSlug: "team-1", awsAccountId: "111111111111" },
      { internalSlug: "team-2", awsAccountId: "" },
      { internalSlug: "team-3", awsAccountId: "" },
    ]);
  });

  it("should treat negative count as zero rows", () => {
    expect(resizeTeamRows([{ internalSlug: "team-1", awsAccountId: "111111111111" }], -1)).toEqual(
      [],
    );
  });
});

describe("validateTeamRows", () => {
  it("should return valid when all slug/account are valid and have no duplicates", () => {
    expect(
      validateTeamRows([
        { internalSlug: "team-1", awsAccountId: "111111111111" },
        { internalSlug: "team-2", awsAccountId: "222222222222" },
      ]),
    ).toEqual({
      allSlugsValid: true,
      allAccountsValid: true,
      hasDuplicateSlug: false,
    });
  });

  it("should detect invalid slug/account and duplicate slugs", () => {
    expect(
      validateTeamRows([
        { internalSlug: "Team_1", awsAccountId: "111" },
        { internalSlug: "Team_1", awsAccountId: "222222222222" },
      ]),
    ).toEqual({
      allSlugsValid: false,
      allAccountsValid: false,
      hasDuplicateSlug: true,
    });
  });
});

describe("parseTeamCountInput", () => {
  it("should extract only digits and clamp to the upper limit", () => {
    expect(parseTeamCountInput("abc12345")).toBe(99);
  });

  it("should return undefined for empty string or input with no digits", () => {
    expect(parseTeamCountInput("")).toBeUndefined();
    expect(parseTeamCountInput("abc")).toBeUndefined();
  });

  it("should return 0 as-is for input '0'", () => {
    expect(parseTeamCountInput("0")).toBe(0);
  });
});
