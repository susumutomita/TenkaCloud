import { describe, expect, it } from "vitest";
import { generateProblemSecret } from "../../lib/problem-deploy/handlers/deploy-worker/team-secret";

describe("generateProblemSecret", () => {
  it("base64url 24 文字 (18 byte = 144 bits) を返すべき", () => {
    const secret = generateProblemSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBe(24);
  });

  it("呼び出しごとに異なる値を返すべき", () => {
    const a = generateProblemSecret();
    const b = generateProblemSecret();
    expect(a).not.toBe(b);
  });

  it("CFn DbPassword の AllowedPattern (英数字 + 限定記号) のサブセットに含まれるべき", () => {
    const cfnAllowed = /^[A-Za-z0-9!@#$%^&*()_+\-=]+$/;
    for (let i = 0; i < 50; i += 1) {
      expect(generateProblemSecret()).toMatch(cfnAllowed);
    }
  });
});
