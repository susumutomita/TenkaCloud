import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  errorDeployTrace,
  logDeployTrace,
  warnDeployTrace,
} from "../../lib/problem-deploy/handlers/shared/trace-log";

describe("trace-log helpers", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logDeployTrace should emit a single JSON line with event / level=info / component=problem-deploy / timestamp", () => {
    logDeployTrace("deploy.create.enqueued", { jobId: "01ABC", correlationId: "01ABC" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload.event).toBe("deploy.create.enqueued");
    expect(payload.level).toBe("info");
    expect(payload.component).toBe("problem-deploy");
    expect(typeof payload.timestamp).toBe("string");
    expect(payload.jobId).toBe("01ABC");
    expect(payload.correlationId).toBe("01ABC");
  });

  it("warnDeployTrace should emit at level=warn (for soft-degraded notifications)", () => {
    warnDeployTrace("deploy.create.partial-degraded", {
      jobId: "01XYZ",
      reason: "ssm-delete-noop",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(payload.level).toBe("warn");
    expect(payload.reason).toBe("ssm-delete-noop");
  });

  it("errorDeployTrace should emit at level=error", () => {
    errorDeployTrace("deploy.cfn.deploy.failed", { jobId: "01ZZZ" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(payload.level).toBe("error");
  });

  it("should omit undefined fields from output JSON (save log size + avoid Logs Insights column pollution)", () => {
    logDeployTrace("deploy.test", {
      jobId: "01ABC",
      optional: undefined,
      defined: "value",
    });
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload).not.toHaveProperty("optional");
    expect(payload.defined).toBe("value");
  });

  it("should emit minimal JSON without crashing even when fields argument is omitted", () => {
    logDeployTrace("deploy.healthz");
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload.event).toBe("deploy.healthz");
    expect(payload.level).toBe("info");
  });

  it("timestamp should be an ISO 8601 string that re-parses", () => {
    logDeployTrace("deploy.test");
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    const parsed = new Date(payload.timestamp);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it("net JSON should be parseable and not break on nested quotes / newlines", () => {
    logDeployTrace("deploy.eventbridge.publish.succeeded", {
      detailType: 'DeployCreate"Requested',
      resource: "line1\nline2",
    });
    const raw = logSpy.mock.calls[0]?.[0] as string;
    expect(() => JSON.parse(raw)).not.toThrow();
    const payload = JSON.parse(raw);
    expect(payload.detailType).toBe('DeployCreate"Requested');
    expect(payload.resource).toBe("line1\nline2");
  });
});
