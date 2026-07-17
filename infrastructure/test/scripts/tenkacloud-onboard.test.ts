import { describe, expect, it } from "vitest";
import { currentPlatform } from "../../../scripts/tenkacloud-onboard";

/**
 * [Issue #2696 PR 2] currentPlatform() used to read process.platform directly,
 * so it could not be unit-tested. It now takes an injectable platform argument
 * (default process.platform), matching the injectability pattern already used by
 * diagnose()/plan() elsewhere in the onboarding CLI.
 */
describe("currentPlatform", () => {
  it("should map darwin to the darwin platform", () => {
    expect(currentPlatform("darwin")).toBe("darwin");
  });

  it("should map linux to the linux platform", () => {
    expect(currentPlatform("linux")).toBe("linux");
  });

  it("should map win32 (native Windows) to other", () => {
    expect(currentPlatform("win32")).toBe("other");
  });

  it("should map freebsd (BSD) to other", () => {
    expect(currentPlatform("freebsd")).toBe("other");
  });

  it("should default to reading process.platform when no argument is given", () => {
    expect(currentPlatform()).toBe(currentPlatform(process.platform));
  });
});
