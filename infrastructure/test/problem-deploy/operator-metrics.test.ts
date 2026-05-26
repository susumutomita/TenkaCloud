import type { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __test__,
  emitDeployOutcome,
  emitDisruptionDetection,
  emitFlagSubmission,
  getOperatorMetricsContext,
} from "../../lib/problem-deploy/handlers/shared/operator-metrics";

describe("operator-metrics helper (Issue #1352)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TENKACLOUD_METRIC_ENV = "Lite";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("namespace + environment resolution", () => {
    it("should build TenkaCloud/{env} namespace", () => {
      expect(__test__.buildNamespace("Lite")).toBe("TenkaCloud/Lite");
      expect(__test__.buildNamespace("development")).toBe("TenkaCloud/development");
      expect(__test__.buildNamespace("production")).toBe("TenkaCloud/production");
    });

    it("should prefer TENKACLOUD_METRIC_ENV over DEPLOY_ENVIRONMENT", () => {
      process.env.TENKACLOUD_METRIC_ENV = "Lite";
      process.env.DEPLOY_ENVIRONMENT = "production";
      expect(__test__.resolveEnvironment()).toBe("Lite");
    });

    it("should fall back to DEPLOY_ENVIRONMENT then 'development'", () => {
      process.env.TENKACLOUD_METRIC_ENV = "";
      process.env.DEPLOY_ENVIRONMENT = "staging";
      expect(__test__.resolveEnvironment()).toBe("staging");
      process.env.DEPLOY_ENVIRONMENT = "";
      expect(__test__.resolveEnvironment()).toBe("development");
    });

    it("should return undefined context (= no-op) when TENKACLOUD_METRIC_ENV is empty (= old stacks)", () => {
      process.env.TENKACLOUD_METRIC_ENV = "";
      expect(getOperatorMetricsContext()).toBeUndefined();
    });
  });

  describe("emitDeployOutcome", () => {
    it("should publish deploy.duration_ms (Milliseconds) and deploy.outcome (Count=1) with TenantId/ProblemId/Outcome/Environment dimensions", async () => {
      const send = vi.fn().mockResolvedValue({});
      await emitDeployOutcome(
        { environment: "Lite", client: { send: send as never } },
        {
          tenantId: "tenant-1",
          problemId: "hello-world",
          outcome: "success",
          durationMs: 12_345,
          timestamp: new Date("2026-05-26T00:00:00Z"),
        },
      );
      expect(send).toHaveBeenCalledTimes(2);
      const cmds = send.mock.calls.map((c) => c[0] as PutMetricDataCommand);
      const durationCmd = cmds.find(
        (c) => c.input.MetricData?.[0]?.MetricName === "deploy.duration_ms",
      );
      const outcomeCmd = cmds.find((c) => c.input.MetricData?.[0]?.MetricName === "deploy.outcome");
      expect(durationCmd?.input.Namespace).toBe("TenkaCloud/Lite");
      expect(durationCmd?.input.MetricData?.[0]?.Value).toBe(12_345);
      expect(durationCmd?.input.MetricData?.[0]?.Unit).toBe("Milliseconds");
      expect(outcomeCmd?.input.MetricData?.[0]?.Value).toBe(1);
      expect(outcomeCmd?.input.MetricData?.[0]?.Unit).toBe("Count");
      const dimsNames = (outcomeCmd?.input.MetricData?.[0]?.Dimensions ?? []).map((d) => d.Name);
      expect(dimsNames).toEqual(
        expect.arrayContaining(["TenantId", "ProblemId", "Outcome", "Environment"]),
      );
    });

    it("should no-op when context is undefined", async () => {
      // not throwing is the contract — old stacks pass undefined ctx
      await expect(
        emitDeployOutcome(undefined, {
          tenantId: "tenant-1",
          problemId: "hello-world",
          outcome: "failed",
          durationMs: 1,
        }),
      ).resolves.toBeUndefined();
    });

    it("should swallow PutMetricData failures (metric loss < primary op failure)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const send = vi.fn().mockRejectedValue(new Error("throttled"));
      await expect(
        emitDeployOutcome(
          { environment: "Lite", client: { send: send as never } },
          { tenantId: "t", problemId: "p", outcome: "success", durationMs: 1 },
        ),
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe("emitFlagSubmission", () => {
    it("should publish scoring.flag_submission_rate (Count) with TenantId/ProblemId dimensions", async () => {
      const send = vi.fn().mockResolvedValue({});
      await emitFlagSubmission(
        { environment: "production", client: { send: send as never } },
        { tenantId: "tenant-1", problemId: "ctf-1", count: 3 },
      );
      const cmd = send.mock.calls[0]?.[0] as PutMetricDataCommand;
      expect(cmd.input.Namespace).toBe("TenkaCloud/production");
      expect(cmd.input.MetricData?.[0]?.MetricName).toBe("scoring.flag_submission_rate");
      expect(cmd.input.MetricData?.[0]?.Value).toBe(3);
      expect(cmd.input.MetricData?.[0]?.Unit).toBe("Count");
    });

    it("should default count to 1 when omitted (= single submission)", async () => {
      const send = vi.fn().mockResolvedValue({});
      await emitFlagSubmission(
        { environment: "Lite", client: { send: send as never } },
        { tenantId: "t", problemId: "p" },
      );
      const cmd = send.mock.calls[0]?.[0] as PutMetricDataCommand;
      expect(cmd.input.MetricData?.[0]?.Value).toBe(1);
    });
  });

  describe("emitDisruptionDetection", () => {
    it("should publish scoring.disruption_detection_rate with TenantId/ProblemId/DisruptionId dimensions", async () => {
      const send = vi.fn().mockResolvedValue({});
      await emitDisruptionDetection(
        { environment: "Lite", client: { send: send as never } },
        { tenantId: "tenant-1", problemId: "uptime-1", disruptionId: "kill-leader" },
      );
      const cmd = send.mock.calls[0]?.[0] as PutMetricDataCommand;
      expect(cmd.input.MetricData?.[0]?.MetricName).toBe("scoring.disruption_detection_rate");
      const dimsNames = (cmd.input.MetricData?.[0]?.Dimensions ?? []).map((d) => d.Name);
      expect(dimsNames).toEqual(
        expect.arrayContaining(["TenantId", "ProblemId", "DisruptionId", "Environment"]),
      );
    });
  });
});
