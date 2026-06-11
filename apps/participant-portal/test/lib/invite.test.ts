import { afterEach, describe, expect, it } from "vitest";
import { clearInviteHash, readInviteKeyFromHash } from "../../src/lib/invite";

describe("readInviteKeyFromHash", () => {
  it("should decode the key from an #invite= fragment", () => {
    expect(readInviteKeyFromHash("#invite=KEY-A")).toBe("KEY-A");
  });

  it("should percent-decode URL-unsafe characters", () => {
    expect(readInviteKeyFromHash("#invite=key%20with%20spaces%26%23")).toBe("key with spaces&#");
  });

  it("should return null for a non-invite hash", () => {
    expect(readInviteKeyFromHash("")).toBeNull();
    expect(readInviteKeyFromHash("#other=1")).toBeNull();
  });

  it("should return null for an empty or malformed invite value", () => {
    expect(readInviteKeyFromHash("#invite=")).toBeNull();
    expect(readInviteKeyFromHash("#invite=%E0%A4%A")).toBeNull(); // broken percent-encoding
  });
});

describe("clearInviteHash", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("should remove the invite fragment from the URL", () => {
    window.history.replaceState(null, "", "/login#invite=KEY-A");
    clearInviteHash();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/login");
  });

  it("should leave non-invite hashes untouched", () => {
    window.history.replaceState(null, "", "/login#section-1");
    clearInviteHash();
    expect(window.location.hash).toBe("#section-1");
  });
});
