import { describe, expect, it } from "vitest";
import { handlerMustNotCallFetch } from "./handler-must-not-call-fetch.ts";

describe("handler-must-not-call-fetch", () => {
  it("handlers 配下の生 fetch( 呼び出しを error にすべき", () => {
    const code = 'const res = await fetch(url, { method: "GET" });';
    const findings = handlerMustNotCallFetch.check({
      files: ["infrastructure/lib/problem-deploy/handlers/foo/service.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("handler-must-not-call-fetch");
    expect(findings[0]?.severity).toBe("error");
  });

  it("portalFetch( のような別関数名は通すべき (= word boundary)", () => {
    const code = "const res = await portalFetch(url);";
    const findings = handlerMustNotCallFetch.check({
      files: ["infrastructure/lib/problem-deploy/handlers/foo/service.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("コメント行の fetch( 言及は通すべき", () => {
    const code = "// この層では fetch( を直接呼ばず client を注入する";
    const findings = handlerMustNotCallFetch.check({
      files: ["infrastructure/lib/problem-deploy/handlers/foo/service.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("handlers 外 (runtime-clients) の fetch は対象外にすべき (= REST client の置き場)", () => {
    const code = "const res = await fetch(url);";
    const findings = handlerMustNotCallFetch.check({
      files: ["infrastructure/lib/problem-deploy/runtime-clients/sakura-apprun-rest-client.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("`*` で始まらない block comment 継続行の fetch( 言及も通すべき (レビュー指摘)", () => {
    const code = [
      "/*",
      "  fetch(url) をここで呼んではいけない理由のメモ",
      "*/",
      "const x = 1;",
    ].join("\n");
    const findings = handlerMustNotCallFetch.check({
      files: ["infrastructure/lib/problem-deploy/handlers/foo/service.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("block comment が閉じた後の実コード fetch( は検知すべき", () => {
    const code = ["/*", "  doc", "*/", "const res = await fetch(url);"].join("\n");
    const findings = handlerMustNotCallFetch.check({
      files: ["infrastructure/lib/problem-deploy/handlers/foo/service.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(4);
  });

  it("テストファイルは対象外にすべき", () => {
    const code = "const res = await fetch(url);";
    const findings = handlerMustNotCallFetch.check({
      files: ["infrastructure/lib/problem-deploy/handlers/foo/service.test.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });
});
