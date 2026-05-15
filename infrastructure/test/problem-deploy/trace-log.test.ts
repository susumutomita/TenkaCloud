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

  it("logDeployTrace は JSON 1 行で event / level=info / component=problem-deploy / timestamp を出力するべき", () => {
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

  it("warnDeployTrace は level=warn を吐くべき (= grace-fallback 等の通知用)", () => {
    warnDeployTrace("deploy.describe-stack.assume-role.grace-fallback", {
      jobId: "01XYZ",
      externalIdVersion: 3,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(payload.level).toBe("warn");
    expect(payload.externalIdVersion).toBe(3);
  });

  it("errorDeployTrace は level=error を吐くべき", () => {
    errorDeployTrace("deploy.cfn.deploy.failed", { jobId: "01ZZZ" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(payload.level).toBe("error");
  });

  it("undefined な field は出力 JSON から除外すべき (= log size 節約 + Logs Insights の column 汚染防止)", () => {
    logDeployTrace("deploy.test", {
      jobId: "01ABC",
      optional: undefined,
      defined: "value",
    });
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload).not.toHaveProperty("optional");
    expect(payload.defined).toBe("value");
  });

  it("fields 引数を省略しても crash せず最小 JSON を出すべき", () => {
    logDeployTrace("deploy.healthz");
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload.event).toBe("deploy.healthz");
    expect(payload.level).toBe("info");
  });

  it("timestamp は ISO 8601 文字列で再 parse 可能であるべき", () => {
    logDeployTrace("deploy.test");
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    const parsed = new Date(payload.timestamp);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it("net JSON はパース可能で多重 quote / newline を破壊しないべき", () => {
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
