import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __test__,
  classifyError,
  emitOperatorLog,
  errorOperator,
  logOperator,
  redactFields,
  warnOperator,
} from "../../lib/problem-deploy/handlers/shared/structured-log";

describe("structured-log helper (Issue #1352)", () => {
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

  describe("wire shape pin", () => {
    it("should emit a single JSON line with the canonical operator schema", () => {
      const fixedNow = new Date("2026-05-26T12:34:56.000Z");
      emitOperatorLog(
        "info",
        {
          eventName: "deploy.stack.create",
          action: "create_deployment",
          status: "succeeded",
          tenantId: "tenant-1",
          teamId: "team-A",
          problemId: "hello-world",
          durationMs: 1234,
        },
        { writer: (line) => console.log(line), now: () => fixedNow },
      );
      expect(logSpy).toHaveBeenCalledTimes(1);
      const raw = logSpy.mock.calls[0]?.[0] as string;
      const payload = JSON.parse(raw);
      expect(payload).toMatchObject({
        level: "info",
        ts: "2026-05-26T12:34:56.000Z",
        component: "problem-deploy",
        eventName: "deploy.stack.create",
        action: "create_deployment",
        status: "succeeded",
        tenantId: "tenant-1",
        teamId: "team-A",
        problemId: "hello-world",
        durationMs: 1234,
      });
    });

    it("should pin eventName / action / status / level / ts / component as required fields on every line", () => {
      logOperator({
        eventName: "scoring.flag.submit",
        action: "submit_flag",
        status: "succeeded",
      });
      const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      expect(payload.eventName).toBe("scoring.flag.submit");
      expect(payload.action).toBe("submit_flag");
      expect(payload.status).toBe("succeeded");
      expect(payload.level).toBe("info");
      expect(payload.component).toBe("problem-deploy");
      expect(typeof payload.ts).toBe("string");
      expect(() => new Date(payload.ts).toISOString()).not.toThrow();
    });

    it("warnOperator should route to console.warn at level=warn", () => {
      warnOperator({
        eventName: "deploy.stack.create",
        action: "create_deployment",
        status: "skipped",
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
      expect(payload.level).toBe("warn");
    });

    it("errorOperator should route to console.error at level=error", () => {
      errorOperator({
        eventName: "deploy.stack.create",
        action: "create_deployment",
        status: "failed",
        errorCode: "AccessDenied",
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
      expect(payload.level).toBe("error");
      expect(payload.errorCode).toBe("AccessDenied");
    });
  });

  describe("secret redaction (allowlist-only)", () => {
    it("should drop unknown keys (= fail-closed, matches #1297 audit redact)", () => {
      const out = redactFields({
        eventName: "deploy.stack.create",
        action: "create_deployment",
        status: "succeeded",
        // @ts-expect-error — caller-side typo we want to silently drop
        password: "hunter2",
        // @ts-expect-error — secret-shaped key
        externalId: "ext-secret-xxx",
        // @ts-expect-error — secret-shaped key
        accessKey: "AKIA...",
        // @ts-expect-error — secret-shaped key
        cookie: "session=abc",
      });
      expect(out).not.toHaveProperty("password");
      expect(out).not.toHaveProperty("externalId");
      expect(out).not.toHaveProperty("accessKey");
      expect(out).not.toHaveProperty("cookie");
    });

    it("should drop non-primitive values (= object / array / Date / function)", () => {
      const out = redactFields({
        eventName: "deploy.stack.create",
        action: "create_deployment",
        status: "succeeded",
        // @ts-expect-error — nested object would leak full shape into CloudWatch
        tenantId: { id: "tenant-1" },
        // @ts-expect-error — array smuggling
        problemId: ["a", "b"],
      });
      expect(out).not.toHaveProperty("tenantId");
      expect(out).not.toHaveProperty("problemId");
    });

    it("should keep string / number / boolean / null values for allowlisted keys", () => {
      const out = redactFields({
        eventName: "deploy.stack.create",
        action: "create_deployment",
        status: "succeeded",
        tenantId: "tenant-1",
        durationMs: 1234,
        problemId: "hello-world",
      });
      expect(out.tenantId).toBe("tenant-1");
      expect(out.durationMs).toBe(1234);
      expect(out.problemId).toBe("hello-world");
    });

    it("should clamp errorMessage to 240 chars to prevent multi-KB SDK stack traces blowing up CloudWatch", () => {
      const longMsg = "x".repeat(500);
      const out = redactFields({
        eventName: "deploy.stack.create",
        action: "create_deployment",
        status: "failed",
        errorMessage: longMsg,
      });
      expect(typeof out.errorMessage).toBe("string");
      expect((out.errorMessage as string).length).toBeLessThanOrEqual(
        __test__.ERROR_MESSAGE_MAX_LEN,
      );
      expect((out.errorMessage as string).endsWith("...")).toBe(true);
    });

    it("should not clamp errorMessage shorter than the cap", () => {
      const out = redactFields({
        eventName: "deploy.stack.create",
        action: "create_deployment",
        status: "failed",
        errorMessage: "AccessDenied: assume role failed",
      });
      expect(out.errorMessage).toBe("AccessDenied: assume role failed");
    });

    it("should reject every secret-shaped key (negative whitelist self-check)", () => {
      const secretKeys = [
        "password",
        "secret",
        "token",
        "accessKey",
        "externalId",
        "presignedUrl",
        "cookie",
        "authorization",
        "samlMetadata",
        "idToken",
        "accessToken",
        "refreshToken",
        "clientSecret",
      ];
      for (const key of secretKeys) {
        expect(__test__.FIELD_ALLOWLIST.has(key)).toBe(false);
      }
    });
  });

  describe("classifyError", () => {
    it("should extract name + message from an Error instance", () => {
      const { errorCode, errorMessage } = classifyError(
        Object.assign(new Error("assume role denied"), { name: "AccessDeniedError" }),
      );
      expect(errorCode).toBe("AccessDeniedError");
      expect(errorMessage).toBe("assume role denied");
    });

    it("should fall back to UnknownError for non-Error throws", () => {
      const { errorCode, errorMessage } = classifyError("oops");
      expect(errorCode).toBe("UnknownError");
      expect(errorMessage).toBe("oops");
    });
  });

  it("should be JSON.parse-safe even with quotes / newlines in field values", () => {
    logOperator({
      eventName: "deploy.stack.create",
      action: "create_deployment",
      status: "failed",
      errorMessage: 'broken "quoted"\nmulti-line',
    });
    const raw = logSpy.mock.calls[0]?.[0] as string;
    expect(() => JSON.parse(raw)).not.toThrow();
    const payload = JSON.parse(raw);
    expect(payload.errorMessage).toBe('broken "quoted"\nmulti-line');
  });
});
