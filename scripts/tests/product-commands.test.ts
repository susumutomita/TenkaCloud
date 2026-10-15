import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
function make(...args: string[]) {
  return spawnSync("/usr/bin/make", ["--no-print-directory", ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
}
test("default bilingual help includes hosting, catalog updates and development commands", () => {
  for (const language of ["en", "ja"]) {
    const result = make("help", `HELP_LANG=${language}`);
    expect(result.status).toBe(0);
    expect([...result.stdout.matchAll(/^ {2}([a-z-]+)\s/gmu)].map((match) => match[1])).toEqual([
      "local",
      "down",
      "local-reset",
      "local-clear",
      "deploy",
      "destroy",
      "turso-clear",
      "turso-reset",
      "env-init",
      "turso-live",
      "turso-live-guide",
      "turso-live-preflight",
      "turso-deploy-preflight",
      "turso-live-verify-cfn",
      "turso-token-rotate",
      "catalog-download",
      "catalog-prepare",
      "validate-problems",
      "build",
      "install",
      "test",
      "lint",
      "before-commit",
    ]);
    expect(result.stdout).toContain(language === "ja" ? "開発用" : "Development");
    expect(result.stdout).toContain(
      language === "ja" ? "問題ソース・カタログ更新" : "Problem sources and catalog updates",
    );
    expect(result.stdout).not.toContain("SaaS");
    expect(result.stdout).not.toContain("Phase 1");
    expect(result.stdout).not.toContain("test-root");
    expect(result.stdout).toContain(
      language === "ja"
        ? "アカウント・IdP設定を含む管理データ"
        : "including account and IdP settings",
    );
    expect(result.stdout).not.toMatch(/legacy|従来|旧方式/iu);
  }
});
test("VS Code hosting tasks use supported Make targets", () => {
  const configuration = JSON.parse(readFileSync(join(root, ".vscode/tasks.json"), "utf8")) as {
    tasks: { command: string; label: string; detail: string }[];
  };
  expect(configuration.tasks.length).toBeGreaterThan(0);
  for (const task of configuration.tasks) {
    const target = /^make ([a-z-]+)$/u.exec(task.command)?.[1];
    expect(target).toBeDefined();
    expect(target).not.toBe("host");
    expect(make("-n", target ?? "").status).toBe(0);
    expect(task.detail).toContain(task.command);
  }
  const local = configuration.tasks.find((task) => task.command === "make local");
  expect(local?.label).toContain("ローカル開催");
  expect(local?.detail).toContain("local hosting");
});
test("local-reset reaches only key rotation, not shutdown or cloud teardown", () => {
  const result = make("-n", "local-reset", "LOCAL_ARGS=--data /tmp/synthetic-host");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("scripts/local-host/local.ts reset --data /tmp/synthetic-host");
  expect(result.stdout).not.toContain("cloud-hosting");
  expect(result.stdout).not.toContain("local.ts down");
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
  expect(pkg.scripts["test:root"]).toBe(
    "bun run test:scripts && bun run test:authoring && bun run test:host",
  );
  expect(pkg.scripts["test:scripts"]).toContain("./scripts/security/*.test.ts");
  expect(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ).toContain("run: bun run test:root");
  const developer = make("help", "HELP_SCOPE=developer");
  expect(developer.status).toBe(0);
  expect(developer.stdout).toContain("before-commit");
  expect(developer.stdout).not.toContain("security-harness-demo");
});

test("fast script checks preserve every root group while required CI retains all host regressions", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const fast = pkg.scripts["test:scripts"] ?? "";
  const command = fast.split(" && ").find((entry) => entry.startsWith("bun test "));
  expect(command?.split(" ").slice(2)).toEqual([
    "./scripts/landing/*.test.ts",
    "./scripts/workspace/*.test.ts",
    "./scripts/release/*.test.ts",
    "./scripts/quality/*.test.ts",
    "./scripts/ops/*.test.ts",
    "./scripts/tests/*.test.ts",
    "./scripts/cloud-hosting/*.test.ts",
    "./scripts/security/*.test.ts",
  ]);
  expect(fast).toContain("bun run release:check");
  expect(fast).toContain("generate-landing-locales.ts --check");
  expect(fast).toContain("generate-landing-docs.ts --check");
  expect(fast).not.toContain("test:host");
  expect(fast).not.toContain("test:authoring");
  expect(pkg.scripts["test:host"]).toBe(
    "bun run check:portable-domain && bun test ./scripts/local-host/tests/*.test.ts ./scripts/local-host/container/*.test.ts ./scripts/lib/*.test.ts && bun run scripts/local-host/tests/run.ts",
  );
  expect(pkg.scripts["check:portable-domain"]).toBe("bun run scripts/quality/portable-domain.ts");
  const result = make("-n", "test-scripts");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("bun run test:scripts");
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
      expect(result.stdout).toContain("bun run test:changed");
    }
  }
});

test("catalog acquisition and validation stay separate from runtime startup", () => {
  expect(make("-n", "catalog-download").stdout).toContain("catalog download catalog-sources.json");
  expect(make("-n", "validate-problems").stdout).toContain("catalog validate");
  expect(make("-n", "local").stdout).not.toContain("catalog download");
  expect(make("-n", "build").stdout).toContain("catalog prepare");
});

// Dry-run only: the CLI's injected subprocess suite verifies AWS and teardown semantics.
test("cloud product commands reach the existing scoped CLI without replacing local shutdown", () => {
  for (const [target, command] of [
    ["deploy", "up"],
    ["destroy", "down"],
    ["turso-clear", "turso-clear"],
    ["turso-reset", "turso-reset"],
  ]) {
    const result = make("-n", target ?? "", "CLOUD_ARGS=--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `bun run --no-env-file scripts/cloud-hosting/main.ts ${command} --help`,
    );
    expect(result.stdout).not.toContain("not implemented");
  }
  const local = make("-n", "down");
  expect(local.status).toBe(0);
  expect(local.stdout).toContain("scripts/local-host/local.ts down");
  expect(local.stdout).not.toContain("cloud-hosting");
});

test("Turso clear and all-control-data reset use distinct entrypoints and forward environment and consent", () => {
  const directory = mkdtempSync(join(tmpdir(), "tenkacloud-turso-entrypoints-"));
  const capture = join(directory, "capture");
  const inheritedToken = "synthetic-process-only-turso-token";
  try {
    writeFileSync(
      join(directory, "bun"),
      '#!/bin/sh\n[ "$TURSO_AUTH_TOKEN" = "synthetic-process-only-turso-token" ] || exit 93\nprintf \'%s\\n\' "$ENV" "$@" >> "$TURSO_COMMAND_CAPTURE"\nexit "$TURSO_COMMAND_EXIT"\n',
      { mode: 0o755 },
    );
    // Existing files with these names must not suppress the phony cleanup targets.
    for (const target of ["turso-clear", "turso-reset"]) {
      writeFileSync(join(directory, target), "synthetic file\n");
      const variants = [[], ["--plan"], ["--yes"], ["-y"], ["--plan", "--yes"], ["--help"]];
      if (target === "turso-clear")
        variants.push(
          ["--credentials", "ssm", "--plan"],
          ["--credentials", "ssm", "--yes"],
          ["--credentials", "direct", "--plan"],
        );
      for (const args of variants) {
        for (const exit of [0, 7]) {
          writeFileSync(capture, "");
          const result = spawnSync(
            "/usr/bin/make",
            [
              "--no-print-directory",
              "-f",
              join(root, "Makefile"),
              target,
              "ENV=staging",
              `CLOUD_ARGS=${args.join(" ")}`,
            ],
            {
              cwd: directory,
              encoding: "utf8",
              env: {
                PATH: `${directory}:/usr/bin:/bin`,
                TURSO_AUTH_TOKEN: inheritedToken,
                TURSO_COMMAND_CAPTURE: capture,
                TURSO_COMMAND_EXIT: String(exit),
              },
            },
          );
          expect(result.status).toBe(exit === 0 ? 0 : 2);
          expect(result.stdout + result.stderr).not.toContain(inheritedToken);
          expect(readFileSync(capture, "utf8").trim().split("\n")).toEqual([
            "staging",
            "run",
            "--no-env-file",
            "scripts/cloud-hosting/main.ts",
            target,
            ...args,
          ]);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Turso clear help and the offline guide explain credential selection and preserved settings", () => {
  const clear = spawnSync(
    process.execPath,
    ["run", "--no-env-file", "scripts/cloud-hosting/main.ts", "turso-clear", "--help"],
    { cwd: root, env: {}, encoding: "utf8" },
  );
  expect(clear.status).toBe(0);
  expect(clear.stdout).toContain("TURSO_AUTH_TOKEN");
  expect(clear.stdout).toContain("--credentials <direct|ssm>");
  expect(clear.stdout).not.toContain("TenkaCloud cloud hosting");
  expect(clear.stdout).not.toContain("cdk bootstrap");
  const usage = spawnSync(
    process.execPath,
    ["run", "--no-env-file", "scripts/tenkacloud.ts", "--help"],
    { cwd: root, env: {}, encoding: "utf8" },
  );
  expect(usage.status).toBe(0);
  expect(usage.stdout).toContain("--credentials <direct|ssm> overrides");
  expect(usage.stdout).toContain(
    "nonblank process-only TURSO_AUTH_TOKEN, otherwise configured SSM",
  );
  const guide = spawnSync(
    process.execPath,
    ["run", "--no-env-file", "scripts/tenkacloud.ts", "turso-live", "guide"],
    { cwd: root, env: { ENV: "staging" }, encoding: "utf8" },
  );
  expect(guide.status).toBe(0);
  expect(guide.stdout).toContain('make turso-clear ENV=staging CLOUD_ARGS="--plan"');
  expect(guide.stdout).toContain("process-only TURSO_AUTH_TOKEN");
  expect(guide.stdout).toContain("Direct access needs no AWS account, region, profile or calls");
  expect(guide.stdout).toContain("admin audit logs");
  expect(guide.stdout).toContain("delete all known control-data rows");
  expect(guide.stdout).toContain("SSM only retrieves the existing Turso token");
  for (const output of [clear.stdout, guide.stdout]) {
    expect(output).toContain("nonblank process-only TURSO_AUTH_TOKEN selects direct");
    expect(output).toContain("otherwise it reads the configured SSM SecureString");
    expect(output).toContain("--credentials <direct|ssm> overrides");
    expect(output).toContain("Tokens in .env are ignored");
    expect(output).toContain("retry with another source");
    expect(output).toContain("ssm:GetParameter");
    expect(output).toMatch(/exact (?:account\/region-qualified )?parameter ARN/u);
    expect(output).toContain("kms:Decrypt");
    expect(output).toContain("customer-managed key");
    expect(output).toContain("IdP, connection, feature-flag and admin-audit data");
    expect(output).toContain("configuration files remain");
    expect(output).toContain("SSM parameter and Turso database itself are also preserved");
    expect(output).not.toMatch(/legacy (?:SSM|all-control-data|data-reset)|alias/iu);
  }
});

test("the Turso reset and credential commands expose offline help", () => {
  const result = spawnSync(
    process.execPath,
    ["run", "--no-env-file", "scripts/tenkacloud.ts", "turso-live", "reset", "--help"],
    { cwd: root, env: process.env, encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Standalone make turso-reset");
  expect(result.stdout).toContain("deletes all known control-data rows");
  expect(result.stdout).toContain("SSM is used only to retrieve the existing Turso token");
  expect(result.stdout).toContain("ssm:GetParameter on the exact parameter ARN");
  expect(result.stdout).toContain("kms:Decrypt");
  expect(result.stdout).toContain("STS GetCallerIdentity");
  expect(result.stdout).toContain("no explicit IAM permission grant");
  expect(result.stdout).toContain(
    "Configuration files, the SSM parameter and the Turso database itself remain",
  );
  expect(result.stdout).not.toMatch(/legacy (?:SSM|all-control-data|data-reset)|alias/iu);
  expect(result.stdout).toContain("make turso-clear");
  const rotation = spawnSync(
    process.execPath,
    ["run", "--no-env-file", "scripts/tenkacloud.ts", "turso-live", "rotate-token", "--help"],
    { cwd: root, env: process.env, encoding: "utf8" },
  );
  expect(rotation.status).toBe(0);
  expect(rotation.stdout).toContain("credential rotation");
});

test("restored Turso Make targets retain their source CLI and argument contract", () => {
  for (const [target, command] of [
    ["turso-live", ""],
    ["turso-live-guide", " guide"],
    ["turso-live-preflight", " preflight"],
    ["turso-live-verify-cfn", " verify-cloudformation"],
    ["turso-token-rotate", " rotate-token --expiration 30d --yes"],
  ]) {
    const result = make("-n", target ?? "", "ENV=staging", "ROTATE_ARGS=--expiration 30d --yes");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `bun run --no-env-file scripts/tenkacloud.ts turso-live${command}`,
    );
  }
  expect(make("-n", "env-init").stdout).toContain("bun run --no-env-file scripts/ops/env-init.ts");
  expect(make("-n", "turso-deploy-preflight").stdout).toContain(
    "bun run --no-env-file scripts/ops/turso-deploy-preflight.ts",
  );
});
