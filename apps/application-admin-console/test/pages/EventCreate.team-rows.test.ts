import { describe, expect, it } from "vitest";
import {
  parseTeamCountInput,
  resizeTeamRows,
  resolveEventProviderMode,
  resolveInitialRegion,
  resolveRegionOptions,
  validateTeamRows,
} from "../../src/pages/EventCreate";

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
      { internalSlug: "team-2", awsAccountId: "", nonAwsCredentialTeamSlug: "team-2" },
      { internalSlug: "team-3", awsAccountId: "", nonAwsCredentialTeamSlug: "team-3" },
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
      allNonAwsCredentialSlugsValid: true,
      hasDuplicateSlug: false,
      providerMode: { kind: "aws" },
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
      allNonAwsCredentialSlugsValid: true,
      hasDuplicateSlug: true,
      providerMode: { kind: "aws" },
    });
  });

  it("should validate non-AWS credential team slugs instead of AWS accounts", () => {
    const providerMode = { kind: "nonAws" as const, provider: "gcp" };

    expect(
      validateTeamRows(
        [{ internalSlug: "team-1", awsAccountId: "", nonAwsCredentialTeamSlug: "gcp-team-1" }],
        providerMode,
      ),
    ).toEqual({
      allSlugsValid: true,
      allAccountsValid: true,
      allNonAwsCredentialSlugsValid: true,
      hasDuplicateSlug: false,
      providerMode,
    });
  });
});

describe("resolveEventProviderMode", () => {
  it("should reject mixed AWS and non-AWS provider events for v1", () => {
    expect(
      resolveEventProviderMode([{ runtimeProvider: "aws" }, { runtimeProvider: "gcp" }]),
    ).toEqual({
      kind: "mixed",
    });
  });

  it("should return the single non-AWS provider when all selected problems match", () => {
    expect(
      resolveEventProviderMode([{ runtimeProvider: "gcp" }, { runtimeProvider: "gcp" }]),
    ).toEqual({
      kind: "nonAws",
      provider: "gcp",
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

describe("resolveInitialRegion (Issue #1201)", () => {
  it("should prefer the problem metadata defaultRegion when declared", () => {
    expect(resolveInitialRegion("us-east-1", "ap-northeast-1")).toBe("us-east-1");
  });

  it("should fall back to the global default when the problem does not declare one", () => {
    expect(resolveInitialRegion(undefined, "ap-northeast-1")).toBe("ap-northeast-1");
  });

  it("should treat empty string as declared (= the operator can author it intentionally to force the global default off)", () => {
    // 仕様: 空文字は宣言済として扱う (= 後で metadata validator が拒否すべき)。 ここでは
    // 純関数の動作を pin するだけ。
    expect(resolveInitialRegion("", "ap-northeast-1")).toBe("");
  });
});

describe("resolveRegionOptions (Issue #1201 Phase 2)", () => {
  const base = [
    { value: "ap-northeast-1", label: "Tokyo" },
    { value: "us-east-1", label: "N. Virginia" },
    { value: "us-west-2", label: "Oregon" },
  ];

  it("should return all base options when supportedRegions is undefined (backward compatible)", () => {
    expect(resolveRegionOptions(undefined, base)).toBe(base);
  });

  it("should return all base options when supportedRegions is empty array", () => {
    expect(resolveRegionOptions([], base)).toBe(base);
  });

  it("should restrict to intersection of supportedRegions and base options", () => {
    const out = resolveRegionOptions(["us-east-1", "us-west-2"], base);
    expect(out.map((o) => o.value)).toEqual(["us-east-1", "us-west-2"]);
  });

  it("should ignore unknown region codes not in base", () => {
    const out = resolveRegionOptions(["us-east-1", "made-up-region"], base);
    expect(out.map((o) => o.value)).toEqual(["us-east-1"]);
  });

  it("should fall back to base when supportedRegions has no intersection (= author misconfig)", () => {
    // wizard が空 picker で固まるのを防ぐ fail-safe。 metadata validator は別途で hard-error。
    expect(resolveRegionOptions(["made-up-only"], base)).toBe(base);
  });
});
