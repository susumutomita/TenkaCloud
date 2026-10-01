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
test("default bilingual help separates four hosting commands and four essential development commands", () => {
  for (const language of ["en", "ja"]) {
    const result = make("help", `HELP_LANG=${language}`);
    expect(result.status).toBe(0);
    expect([...result.stdout.matchAll(/^ {2}([a-z-]+)\s/gmu)].map((match) => match[1])).toEqual([
      "local",
      "down",
      "deploy",
      "destroy",
      "install",
      "test",
      "lint",
      "before-commit",
    ]);
    expect(result.stdout).toContain(language === "ja" ? "開発用" : "Development");
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

test("the four development targets retain safe installation and the complete verification path", () => {
  const install = make("-n", "install");
  expect(install.status).toBe(0);
  expect(install.stdout).toContain("bun install --ignore-scripts");
  const tests = make("-n", "test");
  expect(tests.status).toBe(0);
  expect(tests.stdout).toContain("bun run test");
  for (const target of ["lint", "before-commit"]) {
    const result = make("-n", target);
    expect(result.status).toBe(0);
    for (const check of ["lint:md", "lint:text", "lint:format", "lint:eslint-scope", "lint:ts"])
      expect(result.stdout).toContain(`bun run ${check}`);
    if (target === "before-commit") {
      expect(result.stdout).toContain("bun run dead-code");
      expect(result.stdout).toContain("bun run test");
    }
  }
});

// Dry-run only: the CLI's injected subprocess suite verifies AWS and teardown semantics.
test("cloud product commands reach the existing scoped CLI without replacing local shutdown", () => {
  for (const [target, command] of [
    ["deploy", "up"],
    ["destroy", "down"],
  ]) {
    const result = make("-n", target ?? "", "CLOUD_ARGS=--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`bun run scripts/cloud-hosting/main.ts ${command} --help`);
    expect(result.stdout).not.toContain("not implemented");
  }
  const local = make("-n", "down");
  expect(local.status).toBe(0);
  expect(local.stdout).toContain("scripts/local-host/local.ts down");
  expect(local.stdout).not.toContain("cloud-hosting");
});
