import { describe, expect, it } from "vitest";
import { buildInviteLink } from "./invite-link";

describe("buildInviteLink", () => {
  it("should build a /login link carrying the key in the URL fragment", () => {
    expect(buildInviteLink("https://portal.example.com", "KEY-A")).toBe(
      "https://portal.example.com/login#invite=KEY-A",
    );
  });

  it("should strip trailing slashes from the portal URL", () => {
    expect(buildInviteLink("https://portal.example.com/", "KEY-A")).toBe(
      "https://portal.example.com/login#invite=KEY-A",
    );
  });

  it("should percent-encode keys with URL-unsafe characters", () => {
    expect(buildInviteLink("https://portal.example.com", "key with spaces&#")).toBe(
      "https://portal.example.com/login#invite=key%20with%20spaces%26%23",
    );
  });
});
