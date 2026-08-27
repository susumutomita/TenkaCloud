import { describe, expect, it, vi } from "vitest";
import type { LocalComposeUnit } from "../../../scripts/local-play/container-runner";
import { diagnoseComposeUnit } from "../../../scripts/local-play/docker-adapter";

const CLI = { command: "docker" as const, prefix: ["compose"] as const, label: "docker compose" };

const UNIT: LocalComposeUnit = {
  problemId: "demo",
  offset: 0,
  composePath: "/catalog/demo/local/docker-compose.yml",
  composeProjectName: "tc-local-demo",
  secretEnv: ["FLAG_SEED"],
  projectDirectory: "/catalog/demo/local",
};

interface Result {
  readonly status: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

function psRows(rows: readonly Record<string, unknown>[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

describe("diagnoseComposeUnit", () => {
  it("reports exited and unhealthy service state and only queries the authenticated project", () => {
    const calls: Array<[string, readonly string[]]> = [];
    const run = vi.fn((command: string, args: readonly string[]): Result => {
      calls.push([command, args]);
      if (args.includes("ps")) {
        return {
          status: 0,
          stdout: psRows([
            { Name: "tc-local-demo-db-1", Service: "db", State: "exited", ExitCode: 1 },
            {
              Name: "tc-local-demo-web-1",
              Service: "web",
              State: "running",
              Health: "unhealthy",
              ExitCode: 0,
            },
          ]),
        };
      }
      if (args[0] === "inspect") return { status: 0, stdout: "HP" };
      if (args.includes("logs")) return { status: 0, stdout: "startup failed" };
      return { status: 1 };
    });

    const diagnostics = diagnoseComposeUnit(UNIT, [], { cli: CLI, run });

    expect(diagnostics).toContain("db: state=exited, health=none, exit=1");
    expect(diagnostics).toContain("web: state=running, health=unhealthy, exit=0");
    expect(diagnostics).toContain("Logs (tail) for db");
    for (const [, args] of calls.filter(([, args]) => args.includes("compose"))) {
      expect(args).toContain("/catalog/demo/local/docker-compose.yml");
      expect(args).toContain("tc-local-demo");
      expect(args.join(" ")).not.toContain("tc-local-foreign");
    }
  });

  it("redacts generated secrets and sensitive key-value log lines", () => {
    const run = vi.fn((_command: string, args: readonly string[]): Result => {
      if (args.includes("ps")) {
        return {
          status: 0,
          stdout: psRows([
            {
              Name: "tc-local-demo-web-1",
              Service: "web",
              State: "running",
              Health: "unhealthy",
              ExitCode: 0,
            },
          ]),
        };
      }
      if (args.includes("logs")) {
        return {
          status: 0,
          stdout:
            'received exact-secret-value\nAuthorization: Bearer abc\n{"token":"json-secret"}\npublic diagnostic',
        };
      }
      return { status: 0, stdout: "" };
    });

    const diagnostics = diagnoseComposeUnit(UNIT, ["exact-secret-value"], { cli: CLI, run });

    expect(diagnostics).not.toContain("exact-secret-value");
    expect(diagnostics).not.toContain("Bearer abc");
    expect(diagnostics).not.toContain("json-secret");
    expect(diagnostics).toContain("[redacted]");
    expect(diagnostics).toContain("[redacted sensitive log line]");
    expect(diagnostics).toContain("public diagnostic");
  });

  it("adds an explicit manual recovery hint for Docker VM disk exhaustion", () => {
    const run = vi.fn((_command: string, args: readonly string[]): Result => {
      if (args.includes("ps")) {
        return {
          status: 0,
          stdout: psRows([
            { Name: "tc-local-demo-db-1", Service: "db", State: "exited", ExitCode: 1 },
          ]),
        };
      }
      if (args[0] === "inspect") return { status: 0, stdout: "HP" };
      if (args.includes("logs")) {
        return { status: 0, stdout: "write failed: No space left on device (Errcode: 28)" };
      }
      return { status: 0, stdout: "" };
    });

    const diagnostics = diagnoseComposeUnit(UNIT, [], { cli: CLI, run });

    expect(diagnostics).toContain('Detected "No space left on device"');
    expect(diagnostics).toContain("docker builder prune -af");
    expect(diagnostics).toContain("TenkaCloud did not run either command");
  });

  it("returns a bounded unavailable message instead of leaking compose stderr", () => {
    const diagnostics = diagnoseComposeUnit(UNIT, ["exact-secret-value"], {
      cli: CLI,
      run: () => ({ status: 1, stderr: "FLAG_SEED=exact-secret-value" }),
    });

    expect(diagnostics).toBe(
      "Container diagnostics unavailable for tc-local-demo: compose ps failed.",
    );
  });
});
