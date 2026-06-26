import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "scripts/participant-portal-runtime-config.ts");
const tempDirs: string[] = [];

function runConfig(args: readonly string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("bun", ["run", SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const failed = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: failed.stdout?.toString("utf8") ?? "",
      stderr: failed.stderr?.toString("utf8") ?? "",
      status: failed.status ?? 1,
    };
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("participant-portal-runtime-config (#1122)", () => {
  it("should emit the mock-mode runtime-config to stdout", () => {
    const result = runConfig(["--cloud-mode", "mock", "--print"]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);

    expect(json).toMatchObject({
      apiBaseUrl: "http://localhost:3199/dev-mock",
      eventTitle: "TenkaCloud Battle (offline)",
      eventRegion: "ap-northeast-1",
      mode: "dev-mock",
      cloudMode: "mock",
    });
    expect(json.localstackEndpoint).toBeUndefined();
  });

  it("localstack mode should normalize and output the localhost endpoint", () => {
    const result = runConfig([
      "--cloud-mode",
      "localstack",
      "--localstack-endpoint",
      "http://localhost:4566/",
      "--print",
    ]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);

    expect(json.mode).toBe("dev-mock");
    expect(json.cloudMode).toBe("localstack");
    expect(json.localstackEndpoint).toBe("http://localhost:4566");
  });

  it("localstack mode should reject endpoints other than localhost", () => {
    const result = runConfig([
      "--cloud-mode",
      "localstack",
      "--localstack-endpoint",
      "https://localstack.example.com",
      "--print",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LocalStack endpoint must be http(s) localhost");
  });

  it("backend mode should accept only HTTPS apiBaseUrl", () => {
    const ok = runConfig([
      "--cloud-mode",
      "real",
      "--portal-mode",
      "backend",
      "--api-base-url",
      "https://api.example.com/portal/",
      "--print",
    ]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).apiBaseUrl).toBe("https://api.example.com/portal");

    const ng = runConfig([
      "--cloud-mode",
      "real",
      "--portal-mode",
      "backend",
      "--api-base-url",
      "http://api.example.com/portal",
      "--print",
    ]);
    expect(ng.status).not.toBe(0);
    expect(ng.stderr).toContain("--api-base-url must be HTTPS");
  });

  it("localstack backend mode should accept a loopback HTTP apiBaseUrl", () => {
    const result = runConfig([
      "--cloud-mode",
      "localstack",
      "--portal-mode",
      "backend",
      "--api-base-url",
      "http://127.0.0.1:3199/",
      "--localstack-endpoint",
      "http://127.0.0.1:4566/",
      "--print",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      apiBaseUrl: "http://127.0.0.1:3199",
      mode: "backend",
      cloudMode: "localstack",
      localstackEndpoint: "http://127.0.0.1:4566",
    });
  });

  it("should write runtime-config.json when --out is specified", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-runtime-config-"));
    tempDirs.push(dir);
    const out = join(dir, "runtime-config.json");

    const result = runConfig(["--cloud-mode", "mock", "--out", out]);
    expect(result.status).toBe(0);

    const json = JSON.parse(readFileSync(out, "utf8"));
    expect(json.cloudMode).toBe("mock");
  });
});
