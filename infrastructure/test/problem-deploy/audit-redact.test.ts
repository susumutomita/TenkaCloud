import { describe, expect, it } from "vitest";
import {
  diffSnapshots,
  redactForAudit,
} from "../../lib/problem-deploy/handlers/shared/audit/redact";

/**
 * Issue #1292: redactForAudit が secret / PII / nested を確実に drop することを pin する。
 * audit 行に raw secret が乗らない invariant は本 test が守る。
 */
describe("redactForAudit (#1292)", () => {
  it("should drop fields not in the allowlist", () => {
    const out = redactForAudit("event", {
      id: "e1",
      name: "Battle 1",
      privateNote: "secret",
      apiKey: "AKIA...",
    });
    expect(out).toEqual({ id: "e1", name: "Battle 1" });
  });

  it("should drop nested objects, arrays, dates, and functions", () => {
    const out = redactForAudit("event", {
      id: "e1",
      name: "ok",
      nested: { foo: 1 },
      arr: [1, 2],
      d: new Date(),
      fn: () => "x",
    });
    expect(out).toEqual({ id: "e1", name: "ok" });
  });

  it("should return an empty object for unknown resource types (fail-closed)", () => {
    const out = redactForAudit("nonexistent" as unknown as Parameters<typeof redactForAudit>[0], {
      id: "x",
    });
    expect(out).toEqual({});
  });

  it("should return an empty object for null / undefined / array sources", () => {
    expect(redactForAudit("event", null)).toEqual({});
    expect(redactForAudit("event", undefined)).toEqual({});
    expect(redactForAudit("event", [1, 2, 3])).toEqual({});
    expect(redactForAudit("event", "string")).toEqual({});
  });

  it("should preserve primitive types (string / number / boolean / null)", () => {
    const out = redactForAudit("event", {
      id: "e1",
      name: "x",
      scoringLocked: true,
      scoreboardFreezeMinutes: 5,
      archivedAt: null,
    });
    expect(out).toEqual({
      id: "e1",
      name: "x",
      scoringLocked: true,
      scoreboardFreezeMinutes: 5,
      archivedAt: null,
    });
  });

  it("should NEVER include secret keys like x509 / metadata XML for SAML", () => {
    const out = redactForAudit("tenant_saml_config", {
      providerName: "Okta",
      ssoUrl: "https://...",
      x509Certificate: "BEGIN CERT...",
      metadataXml: "<?xml ...?>",
      signingKey: "SUPER_SECRET",
    });
    expect(out).toEqual({ providerName: "Okta", ssoUrl: "https://..." });
    expect(out).not.toHaveProperty("x509Certificate");
    expect(out).not.toHaveProperty("metadataXml");
    expect(out).not.toHaveProperty("signingKey");
  });
});

describe("diffSnapshots (#1292)", () => {
  it("should keep only changed fields on both sides", () => {
    const { before, after } = diffSnapshots(
      { name: "old", id: "e1", scoringLocked: false },
      { name: "new", id: "e1", scoringLocked: true },
    );
    expect(before).toEqual({ name: "old", scoringLocked: false });
    expect(after).toEqual({ name: "new", scoringLocked: true });
  });

  it("should record an added field on after only", () => {
    const { before, after } = diffSnapshots({ id: "e1" }, { id: "e1", name: "added" });
    expect(before).toEqual({});
    expect(after).toEqual({ name: "added" });
  });

  it("should record a removed field on before only", () => {
    const { before, after } = diffSnapshots({ id: "e1", name: "removed" }, { id: "e1" });
    expect(before).toEqual({ name: "removed" });
    expect(after).toEqual({});
  });
});
