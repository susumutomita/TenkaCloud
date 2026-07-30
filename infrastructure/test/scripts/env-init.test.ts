import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateEnvContent,
  PROMPTS,
  parseExampleKeys,
  runEnvInit,
} from "../../../scripts/ops/env-init";

/**
 * Issue #1345: `make env-init` の .env 生成 wizard の挙動 pin。
 *
 * runEnvInit は prompt I/O を injectable にしてあるので、 file system 上は
 * 一時 dir で再現し、 stdin / stdout を通さずに deterministic に観測する。
 */

describe("scripts/ops/env-init (#1345 Lite mode first-run wizard)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tenkacloud-env-init-"));
    mkdirSync(join(workDir, "infrastructure", "environments", "development"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function seedExample(content: string): string {
    const examplePath = join(
      workDir,
      "infrastructure",
      "environments",
      "development",
      ".env.example",
    );
    writeFileSync(examplePath, content, "utf8");
    return examplePath;
  }

  it("parseExampleKeys should ignore comments and blank lines", () => {
    const parsed = parseExampleKeys(
      [
        "# this is a comment",
        "",
        "FOO=bar",
        "BAZ=qux # inline comment kept verbatim",
        "  # leading-whitespace comment",
        "TRIMMED  =  value-with-spaces  ",
      ].join("\n"),
    );
    expect(parsed.FOO).toBe("bar");
    expect(parsed.BAZ).toBe("qux # inline comment kept verbatim");
    expect(parsed.TRIMMED).toBe("value-with-spaces");
    expect(parsed).not.toHaveProperty("# this is a comment");
  });

  it("generateEnvContent should override only declared keys and preserve comments verbatim", () => {
    const example = ["# header", "FOO=default-foo", "# section", "BAR=default-bar", ""].join("\n");
    const result = generateEnvContent(example, { FOO: "from-wizard" });
    expect(result).toContain("# header");
    expect(result).toContain("# section");
    expect(result).toContain("FOO=from-wizard");
    expect(result).toContain("BAR=default-bar"); // untouched
  });

  it("generateEnvContent should append unknown override keys to the end (future-proof)", () => {
    const example = "FOO=default-foo\n";
    const result = generateEnvContent(example, { FOO: "v1", NEW_KEY: "v2" });
    expect(result).toContain("FOO=v1");
    expect(result).toContain("NEW_KEY=v2");
    expect(result).toContain("# === Added by `make env-init` ===");
  });

  it("PROMPTS should ask for the three task-required keys (TENANT_ADMIN_EMAIL / AWS_REGION / CDK_PARAM_DEPLOY_EXTERNAL_ID)", () => {
    const keys = PROMPTS.map((p) => p.key);
    expect(keys).toContain("TENANT_ADMIN_EMAIL");
    expect(keys).toContain("AWS_REGION");
    expect(keys).toContain("CDK_PARAM_DEPLOY_EXTERNAL_ID");
  });

  it("PROMPTS validate should reject malformed email / region / external id", () => {
    const email = PROMPTS.find((p) => p.key === "TENANT_ADMIN_EMAIL");
    expect(email?.validate?.("noatsymbol")).toBeDefined();
    expect(email?.validate?.("ok@example.com")).toBeUndefined();

    const region = PROMPTS.find((p) => p.key === "AWS_REGION");
    expect(region?.validate?.("tokyo")).toBeDefined();
    expect(region?.validate?.("ap-northeast-1")).toBeUndefined();

    const externalId = PROMPTS.find((p) => p.key === "CDK_PARAM_DEPLOY_EXTERNAL_ID");
    expect(externalId?.validate?.("a".repeat(15))).toBe(
      "16〜128文字で、半角英数字と _ = , . @ : / - を使ってください",
    );
    expect(externalId?.validate?.("a".repeat(129))).toBeDefined();
    expect(externalId?.validate?.("unsupported space")).toBeDefined();
    expect(externalId?.validate?.("a".repeat(16))).toBeUndefined();
    expect(externalId?.validate?.("tenkacloud-lite-default")).toBeUndefined();
  });

  it("runEnvInit should skip when .env already exists (idempotent)", async () => {
    seedExample("FOO=bar\n");
    const envPath = join(workDir, "infrastructure", "environments", "development", ".env");
    writeFileSync(envPath, "# pre-existing", "utf8");

    const out: string[] = [];
    const result = await runEnvInit({
      env: "development",
      repoRoot: workDir,
      ask: async () => "should-not-be-asked",
      print: (line) => out.push(line),
    });
    expect(result.status).toBe("exists");
    expect(result.path).toBe(envPath);
    // 既存 file は触らない (= 上書きしない)。
    expect(readFileSync(envPath, "utf8")).toBe("# pre-existing");
    expect(out.join("\n")).toContain("既に存在します");
  });

  it("runEnvInit should write a .env file using wizard answers", async () => {
    seedExample(
      [
        "# TenkaCloud .env example",
        "TENANT_ADMIN_EMAIL=admin@example.com",
        "SYSTEM_ADMIN_EMAIL=admin@example.com",
        "AWS_REGION=ap-northeast-1",
        "CDK_PARAM_DEPLOY_EXTERNAL_ID=tenkacloud-lite-default",
        "# end",
      ].join("\n"),
    );

    const answers = new Map<string, string>([
      ["TENANT_ADMIN_EMAIL", "user@org.example"],
      ["AWS_REGION", "us-east-1"],
      ["CDK_PARAM_DEPLOY_EXTERNAL_ID", "my-external-id-2026"],
    ]);

    const result = await runEnvInit({
      env: "development",
      repoRoot: workDir,
      ask: async (question) => {
        for (const [key, value] of answers.entries()) {
          if (question.startsWith(key)) return value;
        }
        return "";
      },
      print: () => undefined,
    });

    expect(result.status).toBe("created");
    const content = readFileSync(result.path, "utf8");
    expect(content).toContain("TENANT_ADMIN_EMAIL=user@org.example");
    expect(content).toContain("SYSTEM_ADMIN_EMAIL=user@org.example"); // derived
    expect(content).toContain("AWS_REGION=us-east-1");
    expect(content).toContain("CDK_PARAM_DEPLOY_EXTERNAL_ID=my-external-id-2026");
    expect(content).toContain("# TenkaCloud .env example"); // comments preserved
  });

  it("runEnvInit should use default values in nonInteractive mode (CI / pipe)", async () => {
    seedExample(
      [
        "TENANT_ADMIN_EMAIL=admin@example.com",
        "SYSTEM_ADMIN_EMAIL=admin@example.com",
        "AWS_REGION=ap-northeast-1",
        "CDK_PARAM_DEPLOY_EXTERNAL_ID=tenkacloud-lite-default",
      ].join("\n"),
    );

    let askCalls = 0;
    const result = await runEnvInit({
      env: "development",
      repoRoot: workDir,
      ask: async () => {
        askCalls++;
        return "";
      },
      print: () => undefined,
      nonInteractive: true,
    });
    expect(askCalls).toBe(0);
    expect(result.status).toBe("created");
    const content = readFileSync(result.path, "utf8");
    expect(content).toContain("TENANT_ADMIN_EMAIL=admin@example.com");
    expect(content).toContain("AWS_REGION=ap-northeast-1");
    expect(content).toContain("CDK_PARAM_DEPLOY_EXTERNAL_ID=tenkacloud-lite-default");
  });

  it("runEnvInit should re-prompt up to 3 times on validate failure", async () => {
    seedExample(
      [
        "TENANT_ADMIN_EMAIL=admin@example.com",
        "AWS_REGION=ap-northeast-1",
        "CDK_PARAM_DEPLOY_EXTERNAL_ID=tenkacloud-lite-default",
      ].join("\n"),
    );

    const asked: Array<{ q: string; n: number }> = [];
    let emailAttempt = 0;
    const result = await runEnvInit({
      env: "development",
      repoRoot: workDir,
      ask: async (question) => {
        if (question.startsWith("TENANT_ADMIN_EMAIL")) {
          emailAttempt++;
          asked.push({ q: "TENANT_ADMIN_EMAIL", n: emailAttempt });
          // 1 回目は invalid を返す → re-prompt されることを観測。
          if (emailAttempt === 1) return "no-at-symbol";
          return "ok@example.com";
        }
        return "";
      },
      print: () => undefined,
    });
    expect(emailAttempt).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("created");
    const content = readFileSync(result.path, "utf8");
    expect(content).toContain("TENANT_ADMIN_EMAIL=ok@example.com");
  });

  it("runEnvInit should throw when .env.example is missing", async () => {
    const envDir = join(workDir, "infrastructure", "environments", "development");
    expect(existsSync(join(envDir, ".env.example"))).toBe(false);
    await expect(
      runEnvInit({
        env: "development",
        repoRoot: workDir,
        ask: async () => "",
        print: () => undefined,
      }),
    ).rejects.toThrow(/\.env\.example/);
  });
});
