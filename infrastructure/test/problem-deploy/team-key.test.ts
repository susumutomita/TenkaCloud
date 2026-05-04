import { describe, expect, it } from "vitest";
import { generateTeamLoginKey } from "../../lib/problem-deploy/handlers/deploy-handler/team-key";

describe("generateTeamLoginKey", () => {
  it("base64url 形式の文字列を返すべき (32 byte → 43 chars)", () => {
    const key = generateTeamLoginKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key.length).toBe(43);
  });

  it("呼び出しごとに異なるキーを返すべき", () => {
    const a = generateTeamLoginKey();
    const b = generateTeamLoginKey();
    expect(a).not.toBe(b);
  });
});
