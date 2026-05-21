import { describe, expect, it } from "vitest";
import { PortalValidationError } from "../../src/api/portal-client";
import {
  canSubmitTeamName,
  describeTeamNameDraft,
  formatTeamSetupSubmitError,
} from "../../src/pages/TeamSetup";

describe("TeamSetup helpers", () => {
  it("should trim team name and judge valid input", () => {
    expect(describeTeamNameDraft("  Team Alpha  ")).toEqual({
      trimmed: "Team Alpha",
      invalid: false,
    });
  });

  it("should mark team names containing invalid characters as invalid", () => {
    expect(describeTeamNameDraft("Team!")).toEqual({
      trimmed: "Team!",
      invalid: true,
    });
  });

  it("should allow submit when sessionToken exists, value is non-empty and valid, and not submitting", () => {
    expect(
      canSubmitTeamName({
        sessionToken: "session-token",
        trimmed: "Team Alpha",
        invalid: false,
        submitting: false,
      }),
    ).toBe(true);
  });

  it("should disallow submit when sessionToken is missing / empty / invalid / submitting", () => {
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

  it("should format validation errors into an i18n message", () => {
    expect(
      formatTeamSetupSubmitError(new PortalValidationError("invalid"), "validation failed"),
    ).toBe("validation failed");
  });

  it("should stringify non-Error values", () => {
    expect(formatTeamSetupSubmitError("boom", "validation failed")).toBe("boom");
  });
});
