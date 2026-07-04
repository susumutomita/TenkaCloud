import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Topic } from "aws-cdk-lib/aws-sns";
import { describe, expect, it } from "vitest";
import {
  applyAlwaysOnRuntimeTags,
  MANAGED_BY_ALWAYS_ON_RUNTIME,
  normalizeExpiresAt,
  TAG_EVENT_ID,
  TAG_EXPIRES_AT,
  TAG_MANAGED_BY,
  TAG_TENANT_ID,
} from "../../lib/always-on-runtime/runtime-tags";

const EVENT_ID = "01J000000000000000000EVENT";
const TENANT_ID = "tenant-42";

/** Synth a Stack with one taggable resource so the propagated stack tags appear in the template. */
function synthWithTags(expiresAt: Date | string): Template {
  const app = new App();
  const stack = new Stack(app, "TestAlwaysOnRuntime");
  new Topic(stack, "Marker");
  applyAlwaysOnRuntimeTags(stack, { eventId: EVENT_ID, tenantId: TENANT_ID, expiresAt });
  return Template.fromStack(stack);
}

describe("applyAlwaysOnRuntimeTags", () => {
  it("should apply the four TenkaCloud:* tags with a normalized ISO-8601 expiry from a Date", () => {
    const template = synthWithTags(new Date("2026-07-01T00:00:00.000Z"));
    // CDK renders tags sorted by key, so assert each independently (order-agnostic).
    for (const tag of [
      { Key: TAG_EVENT_ID, Value: EVENT_ID },
      { Key: TAG_TENANT_ID, Value: TENANT_ID },
      { Key: TAG_EXPIRES_AT, Value: "2026-07-01T00:00:00.000Z" },
      { Key: TAG_MANAGED_BY, Value: MANAGED_BY_ALWAYS_ON_RUNTIME },
    ]) {
      template.hasResourceProperties("AWS::SNS::Topic", {
        Tags: Match.arrayWith([tag]),
      });
    }
  });

  it("should normalize an ISO-8601 string expiry to a canonical ISO-8601 value", () => {
    const template = synthWithTags("2026-08-15T12:30:00Z");
    template.hasResourceProperties("AWS::SNS::Topic", {
      Tags: Match.arrayWith([{ Key: TAG_EXPIRES_AT, Value: "2026-08-15T12:30:00.000Z" }]),
    });
  });

  it("should throw loudly on an unparseable expiresAt", () => {
    const app = new App();
    const stack = new Stack(app, "BadExpiry");
    expect(() =>
      applyAlwaysOnRuntimeTags(stack, {
        eventId: EVENT_ID,
        tenantId: TENANT_ID,
        expiresAt: "not-a-date",
      }),
    ).toThrow(/valid Date or ISO-8601/);
  });
});

describe("normalizeExpiresAt", () => {
  it("should return the ISO-8601 string for a valid Date", () => {
    expect(normalizeExpiresAt(new Date("2026-07-01T00:00:00.000Z"))).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  it("should throw for an invalid Date instance", () => {
    expect(() => normalizeExpiresAt(new Date("nonsense"))).toThrow(/valid Date or ISO-8601/);
  });
});
