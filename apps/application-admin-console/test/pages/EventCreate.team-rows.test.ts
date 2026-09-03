import { describe, expect, it } from "vitest";
import {
  parseTeamCountInput,
  resizeTeamRows,
  resolveEventProviderMode,
  resolveInitialRegion,
  resolveRegionOptions,
  validateTeamRows,
} from "../../src/pages/EventCreate";

const row = (
  internalSlug: string,
  awsAccountId: string,
  nonAwsCredentialTeamSlug = internalSlug,
) => ({
  internalSlug,
  awsAccountId,
  nonAwsCredentialTeamSlug,
  // [Issue #3173] Blank = the problem's region, which is what every row is
  // until an operator spreads the teams out.
  region: "",
});

describe("resizeTeamRows", () => {
  it("should return the same array reference when team count is unchanged", () => {
    const rows = [row("team-1", "111111111111")];

    expect(resizeTeamRows(rows, 1)).toBe(rows);
  });

  it("should drop trailing rows when team count is reduced", () => {
    expect(
      resizeTeamRows([row("team-1", "111111111111"), row("team-2", "222222222222")], 1),
    ).toEqual([row("team-1", "111111111111")]);
  });

  it("should keep existing rows and append empty new rows when team count is increased", () => {
    expect(resizeTeamRows([row("team-1", "111111111111")], 3)).toEqual([
      row("team-1", "111111111111"),
      { internalSlug: "team-2", awsAccountId: "", nonAwsCredentialTeamSlug: "team-2", region: "" },
      { internalSlug: "team-3", awsAccountId: "", nonAwsCredentialTeamSlug: "team-3", region: "" },
    ]);
  });

  it("should treat negative count as zero rows", () => {
    expect(resizeTeamRows([row("team-1", "111111111111")], -1)).toEqual([]);
  });
});

describe("validateTeamRows", () => {
  it("should return valid when all slug/account are valid and have no duplicates", () => {
    expect(
      validateTeamRows([row("team-1", "111111111111"), row("team-2", "222222222222")]),
    ).toEqual({
      allSlugsValid: true,
      allAccountsValid: true,
      allNonAwsCredentialSlugsValid: true,
      hasDuplicateSlug: false,
      providerMode: { kind: "aws" },
    });
  });

  it("should detect invalid slug/account and duplicate slugs", () => {
    expect(validateTeamRows([row("Team_1", "111"), row("Team_1", "222222222222")])).toEqual({
      allSlugsValid: false,
      allAccountsValid: false,
      allNonAwsCredentialSlugsValid: true,
      hasDuplicateSlug: true,
      providerMode: { kind: "aws" },
    });
  });

  it("should validate non-AWS credential team slugs instead of AWS accounts", () => {
    const providerMode = { kind: "nonAws" as const, provider: "gcp" };

    expect(validateTeamRows([row("team-1", "", "gcp-team-1")], providerMode)).toEqual({
      allSlugsValid: true,
      allAccountsValid: true,
      allNonAwsCredentialSlugsValid: true,
      hasDuplicateSlug: false,
      providerMode,
    });
  });

  it("should flag an invalid non-AWS credential slug (#2563)", () => {
    const providerMode = { kind: "nonAws" as const, provider: "gcp" };

    expect(validateTeamRows([row("team-1", "", "Bad_Slug")], providerMode)).toEqual({
      allSlugsValid: true,
      allAccountsValid: true,
      allNonAwsCredentialSlugsValid: false,
      hasDuplicateSlug: false,
      providerMode,
    });
  });

  it("should require both an AWS account and credential slug for a composite event", () => {
    const providerMode = { kind: "composite" as const, providers: ["aws", "gcp"] };

    expect(validateTeamRows([row("team-1", "", "team-1")], providerMode)).toMatchObject({
      allAccountsValid: false,
      allNonAwsCredentialSlugsValid: true,
    });
    expect(validateTeamRows([row("team-1", "111111111111", "Bad_")], providerMode)).toMatchObject({
      allAccountsValid: true,
      allNonAwsCredentialSlugsValid: false,
    });
  });
});

describe("resolveEventProviderMode", () => {
  it("should preserve every provider from a composite problem", () => {
    expect(
      resolveEventProviderMode([
        { runtimeProviders: ["aws", "gcp", "azure", "sakura"], composite: true },
        { runtimeProvider: "aws" },
        {},
      ]),
    ).toEqual({ kind: "composite", providers: ["aws", "gcp", "azure", "sakura"] });
  });

  it("should reject mixed AWS and non-AWS provider events for v1", () => {
    expect(
      resolveEventProviderMode([{ runtimeProvider: "aws" }, { runtimeProvider: "gcp" }]),
    ).toEqual({
      kind: "mixed",
    });
  });

  it("should treat an undeclared-runtime (= AWS) row plus a non-AWS row as mixed", () => {
    // 未宣言 provider は aws 扱い。 [{}, gcp] を nonAws と誤判定すると AWS 問題の
    // account 束縛が丸ごと落ちるので mixed でなければならない。
    expect(resolveEventProviderMode([{}, { runtimeProvider: "gcp" }])).toEqual({ kind: "mixed" });
  });

  it("should treat two different non-AWS providers as mixed (v1)", () => {
    expect(
      resolveEventProviderMode([{ runtimeProvider: "gcp" }, { runtimeProvider: "azure" }]),
    ).toEqual({ kind: "mixed" });
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
