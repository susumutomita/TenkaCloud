import { describe, expect, it, vi } from "vitest";
import {
  emitShadowAudit,
  type ShadowIntentParams,
} from "../../lib/problem-deploy/handlers/shared/trust-bridge-shadow";

/**
 * Issue #795 ADR-017 Phase 3 (shadow integration): emitShadowAudit が
 * `trust-bridge.shadow.audit` を 1 行 JSON で CloudWatch に出すこと、 schema
 * 違反でも throw せず audit を残すこと、 必要な claim だけが乗ること を pin。
 */

function baseParams(overrides: Partial<ShadowIntentParams> = {}): ShadowIntentParams {
  return {
    jobId: "01KSHADOW0000000000000000",
    tenantId: "tenant-a",
    teamSlug: "team-alpha",
    problemId: "hello-world",
    namePrefix: "tc-hello-world-team-alpha",
    region: "ap-northeast-1",
    awsAccountId: "123456789012",
    nowMs: Date.UTC(2026, 4, 15, 22, 0, 0),
    ttlSeconds: 900,
    action: "deploy",
    requestedScopes: ["cloudformation:CreateStack"],
    ...overrides,
  };
}

function captureLogs(): {
  readonly infoLines: string[];
  readonly warnLines: string[];
  restore(): void;
} {
  const infoLines: string[] = [];
  const warnLines: string[] = [];
  // trace-log.ts uses console.log / console.warn / console.error。 spy には
  // `log` を info-level として束ねる。
  const infoSpy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
    infoLines.push(String(msg));
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((msg: unknown) => {
    warnLines.push(String(msg));
  });
  return {
    infoLines,
    warnLines,
    restore() {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

describe("emitShadowAudit (#795 Phase 3 shadow)", () => {
  it("should emit trust-bridge.shadow.audit with decision=allow on normal params", () => {
    const cap = captureLogs();
    try {
      emitShadowAudit(baseParams());
      const audit = cap.infoLines.find((l) => l.includes("trust-bridge.shadow.audit"));
      expect(audit).toBeDefined();
      expect(audit).toContain('"decision":"allow"');
      expect(audit).toContain('"tenantId":"tenant-a"');
      expect(audit).toContain('"problemId":"hello-world"');
      expect(audit).toContain('"deploymentId":"01KSHADOW0000000000000000"');
      expect(audit).toContain('"provider":"aws"');
      expect(audit).toContain('"action":"deploy"');
    } finally {
      cap.restore();
    }
  });

  it("should emit action=destroy with the same audit shape", () => {
    const cap = captureLogs();
    try {
      emitShadowAudit(baseParams({ action: "destroy" }));
      const audit = cap.infoLines.find((l) => l.includes("trust-bridge.shadow.audit"));
      expect(audit).toContain('"action":"destroy"');
      expect(audit).toContain('"decision":"allow"');
    } finally {
      cap.restore();
    }
  });

  it("should not throw but warn and emit audit deny on ttlSeconds=0 (schema violation) (fail-open)", () => {
    const cap = captureLogs();
    try {
      expect(() => emitShadowAudit(baseParams({ ttlSeconds: 0 }))).not.toThrow();
      const warn = cap.warnLines.find((l) => l.includes("trust-bridge.shadow.schema-invalid"));
      expect(warn).toBeDefined();
      const audit = cap.infoLines.find((l) => l.includes("trust-bridge.shadow.audit"));
      expect(audit).toBeDefined();
      expect(audit).toContain('"decision":"deny"');
      expect(audit).toContain('"denialReason":"schema-invalid"');
    } finally {
      cap.restore();
    }
  });

  it("should likewise emit audit deny fail-open on ttlSeconds=9999 (above schema cap)", () => {
    const cap = captureLogs();
    try {
      expect(() => emitShadowAudit(baseParams({ ttlSeconds: 9999 }))).not.toThrow();
      const warn = cap.warnLines.find((l) => l.includes("trust-bridge.shadow.schema-invalid"));
      expect(warn).toBeDefined();
    } finally {
      cap.restore();
    }
  });

  it("should still build an intent and emit allow when competitorRoleArn is unset (same-account dev path)", () => {
    const cap = captureLogs();
    try {
      emitShadowAudit(baseParams({ competitorRoleArn: undefined }));
      const audit = cap.infoLines.find((l) => l.includes("trust-bridge.shadow.audit"));
      expect(audit).toContain('"decision":"allow"');
    } finally {
      cap.restore();
    }
  });

  it("should still build an intent and emit an audit without teamId field when teamSlug is unset", () => {
    const cap = captureLogs();
    try {
      emitShadowAudit(baseParams({ teamSlug: undefined }));
      const audit = cap.infoLines.find((l) => l.includes("trust-bridge.shadow.audit"));
      expect(audit).toBeDefined();
      // teamId field は intent.source.teamId が undefined のとき audit にも乗らない。
      expect(audit).not.toContain('"teamId"');
    } finally {
      cap.restore();
    }
  });
});
