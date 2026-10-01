import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
function make(...args: string[]) {
  return spawnSync("/usr/bin/make", ["--no-print-directory", ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
}
test("default bilingual help exposes exactly the four product commands", () => {
  for (const language of ["en", "ja"]) {
    const result = make("help", `HELP_LANG=${language}`);
    expect(result.status).toBe(0);
    expect([...result.stdout.matchAll(/^ {2}([a-z-]+)\s/gmu)].map((match) => match[1])).toEqual([
      "local",
      "down",
      "deploy",
      "destroy",
    ]);
    expect(result.stdout).not.toContain("SaaS");
    expect(result.stdout).not.toContain("Phase 1");
    expect(result.stdout).not.toContain("test-root");
  }
});
test("retired demo and test-root targets are removed without dropping root or security tests", () => {
  for (const target of [
    "local-down",
    "test-root",
    "security-harness-demo",
    "host",
    "saas",
    "deploy-saas",
    "pack-activate",
    "pack-deactivate",
  ])
    expect(make("-n", target).status).not.toBe(0);
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts.test).toContain("bun run test:root");
  expect(pkg.scripts["test:root"]).toContain("./scripts/security/*.test.ts");
  expect(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ).toContain("run: bun run test:root");
  const developer = make("help", "HELP_SCOPE=developer");
  expect(developer.status).toBe(0);
  expect(developer.stdout).toContain("before-commit");
  expect(developer.stdout).not.toContain("security-harness-demo");
});
