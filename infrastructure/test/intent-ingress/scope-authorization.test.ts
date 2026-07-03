import { describe, expect, it } from "vitest";
import { authorizeIntentScope } from "../../lib/intent-ingress/scope-authorization";
import { makeVerified } from "./intent-fixtures";

describe("authorizeIntentScope (ADR-049 Phase 4 / #2293)", () => {
  it("should accept when no scope config is constrained", () => {
    expect(authorizeIntentScope(makeVerified(), {})).toEqual({ ok: true });
  });

  it("should accept when audience matches the expected audience", () => {
    const intent = makeVerified({ audience: "plane://tenka/ingress" });
    expect(authorizeIntentScope(intent, { expectedAudience: "plane://tenka/ingress" })).toEqual({
      ok: true,
    });
  });

  it("should reject audience-mismatch when the audience differs", () => {
    const intent = makeVerified({ audience: "plane://other" });
    expect(authorizeIntentScope(intent, { expectedAudience: "plane://tenka/ingress" })).toEqual({
      ok: false,
      reason: "audience-mismatch",
    });
  });

  it("should reject audience-mismatch when an audience is expected but absent", () => {
    const intent = makeVerified(); // no audience
    expect(authorizeIntentScope(intent, { expectedAudience: "plane://tenka/ingress" })).toEqual({
      ok: false,
      reason: "audience-mismatch",
    });
  });

  it("should accept a tenant that is on a non-empty allowlist", () => {
    const intent = makeVerified({ source: { tenantId: "tenant-a" } });
    expect(authorizeIntentScope(intent, { allowedTenantIds: ["tenant-a", "tenant-b"] })).toEqual({
      ok: true,
    });
  });

  it("should reject tenant-not-allowed for a tenant off the allowlist", () => {
    const intent = makeVerified({ source: { tenantId: "tenant-z" } });
    expect(authorizeIntentScope(intent, { allowedTenantIds: ["tenant-a"] })).toEqual({
      ok: false,
      reason: "tenant-not-allowed",
    });
  });

  it("should not constrain tenant when the allowlist is empty", () => {
    const intent = makeVerified({ source: { tenantId: "tenant-z" } });
    expect(authorizeIntentScope(intent, { allowedTenantIds: [] })).toEqual({ ok: true });
  });

  it("should reject event-id-missing when events are allowlisted but the intent has none", () => {
    const intent = makeVerified({ source: { eventId: undefined } });
    expect(authorizeIntentScope(intent, { allowedEventIds: ["event-a"] })).toEqual({
      ok: false,
      reason: "event-id-missing",
    });
  });

  it("should reject event-not-allowed for an event off the allowlist", () => {
    const intent = makeVerified({ source: { eventId: "event-z" } });
    expect(authorizeIntentScope(intent, { allowedEventIds: ["event-a"] })).toEqual({
      ok: false,
      reason: "event-not-allowed",
    });
  });

  it("should accept an event that is on the allowlist", () => {
    const intent = makeVerified({ source: { eventId: "event-a" } });
    expect(authorizeIntentScope(intent, { allowedEventIds: ["event-a"] })).toEqual({ ok: true });
  });

  it("should evaluate every configured axis together", () => {
    const intent = makeVerified({
      audience: "plane://tenka/ingress",
      source: { tenantId: "tenant-a", eventId: "event-a" },
    });
    expect(
      authorizeIntentScope(intent, {
        expectedAudience: "plane://tenka/ingress",
        allowedTenantIds: ["tenant-a"],
        allowedEventIds: ["event-a"],
      }),
    ).toEqual({ ok: true });
  });
});
