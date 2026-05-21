import { describe, expect, it } from "vitest";
import { generateTeamLoginKey } from "../../lib/problem-deploy/handlers/deploy-handler/team-key";

describe("generateTeamLoginKey", () => {
  it("should return a base64url string (32 bytes → 43 chars)", () => {
    const key = generateTeamLoginKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key.length).toBe(43);
  });

  it("should return a different key on each call", () => {
    const a = generateTeamLoginKey();
    const b = generateTeamLoginKey();
    expect(a).not.toBe(b);
  });
});
