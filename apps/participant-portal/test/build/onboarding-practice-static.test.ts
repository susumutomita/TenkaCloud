import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("onboarding practice endpoint", () => {
  it("should provide the connection code and final flag outside the hint flow", async () => {
    const html = await readFile(resolve(process.cwd(), "public/onboarding-practice.html"), "utf8");

    expect(html).toContain("CONNECTED");
    expect(html).toContain("TC{HELLO-TENKACLOUD}");
    expect(html).toContain("ポータルの問題画面へ戻");
  });
});
