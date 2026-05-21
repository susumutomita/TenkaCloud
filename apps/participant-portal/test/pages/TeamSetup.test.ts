import { describe, expect, it } from "vitest";
import { PortalValidationError } from "../../src/api/portal-client";
import {
  canSubmitTeamName,
  describeTeamNameDraft,
  formatTeamSetupSubmitError,
} from "../../src/pages/TeamSetup";

describe("TeamSetup helpers", () => {
  it("team name を trim し、有効な入力を判定すべき", () => {
    expect(describeTeamNameDraft("  Team Alpha  ")).toEqual({
      trimmed: "Team Alpha",
      invalid: false,
    });
  });

  it("不正文字を含む team name を invalid にすべき", () => {
    expect(describeTeamNameDraft("Team!")).toEqual({
      trimmed: "Team!",
      invalid: true,
    });
  });

  it("sessionToken があり非空かつ valid で送信中でなければ submit 可能にすべき", () => {
    expect(
      canSubmitTeamName({
        sessionToken: "session-token",
        trimmed: "Team Alpha",
        invalid: false,
        submitting: false,
      }),
    ).toBe(true);
  });

  it("sessionToken 不在 / 空 / invalid / submitting は submit 不可にすべき", () => {
    expect(
      canSubmitTeamName({
        sessionToken: undefined,
        trimmed: "Team Alpha",
        invalid: false,
        submitting: false,
      }),
    ).toBe(false);
    expect(
      canSubmitTeamName({
        sessionToken: "session-token",
        trimmed: "",
        invalid: false,
        submitting: false,
      }),
    ).toBe(false);
    expect(
      canSubmitTeamName({
        sessionToken: "session-token",
        trimmed: "Team!",
        invalid: true,
        submitting: false,
      }),
    ).toBe(false);
    expect(
      canSubmitTeamName({
        sessionToken: "session-token",
        trimmed: "Team Alpha",
        invalid: false,
        submitting: true,
      }),
    ).toBe(false);
  });

  it("validation error は i18n 済み message に整形すべき", () => {
    expect(
      formatTeamSetupSubmitError(new PortalValidationError("invalid"), "validation failed"),
    ).toBe("validation failed");
  });

  it("Error 以外も string 化すべき", () => {
    expect(formatTeamSetupSubmitError("boom", "validation failed")).toBe("boom");
  });
});
