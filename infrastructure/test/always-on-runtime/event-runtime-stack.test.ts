import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  buildEventRuntimeManifestParameterName,
  buildEventRuntimeStackId,
  EventRuntimeStack,
} from "../../lib/always-on-runtime/event-runtime-stack.js";
import {
  MANAGED_BY_ALWAYS_ON_RUNTIME,
  TAG_EVENT_ID,
  TAG_EXPIRES_AT,
  TAG_MANAGED_BY,
  TAG_TENANT_ID,
} from "../../lib/always-on-runtime/runtime-tags.js";

const EVENT_ID = "01JZK8EVENTRUNTIME01";
const TENANT_ID = "tenant-42";
const EXPIRES_AT = "2026-07-04T12:30:00Z";
const EXPIRES_AT_ISO = "2026-07-04T12:30:00.000Z";

function createStack(props?: { eventId?: string; tenantId?: string }): EventRuntimeStack {
  const app = new App();
  return new EventRuntimeStack(app, "TestEventRuntime", {
    eventId: props?.eventId ?? EVENT_ID,
    tenantId: props?.tenantId ?? TENANT_ID,
    expiresAt: EXPIRES_AT,
  });
}

describe("EventRuntimeStack", () => {
  it("should create an SSM manifest parameter for the live event", () => {
    const stack = createStack();

    expect(stack.manifestParameterName).toBe(buildEventRuntimeManifestParameterName(EVENT_ID));
    expect(stack.manifestParameter).toBeDefined();
    Template.fromStack(stack).hasResourceProperties("AWS::SSM::Parameter", {
      Description: "TenkaCloud Always-On event runtime manifest.",
      Name: `/tenkacloud/always-on/event-runtime/${EVENT_ID}`,
      Type: "String",
      Value: JSON.stringify({
        eventId: EVENT_ID,
        tenantId: TENANT_ID,
        expiresAt: EXPIRES_AT,
        managedBy: MANAGED_BY_ALWAYS_ON_RUNTIME,
      }),
    });
  });

  it("should propagate all four always-on runtime tags to the manifest parameter", () => {
    const template = Template.fromStack(createStack());

    template.hasResourceProperties("AWS::SSM::Parameter", {
      Tags: {
        [TAG_EVENT_ID]: EVENT_ID,
        [TAG_TENANT_ID]: TENANT_ID,
        [TAG_EXPIRES_AT]: EXPIRES_AT_ISO,
        [TAG_MANAGED_BY]: MANAGED_BY_ALWAYS_ON_RUNTIME,
      },
    });
  });

  it("should throw loudly when eventId is empty", () => {
    expect(() => createStack({ eventId: "   " })).toThrow(/eventId/);
  });

  it("should throw loudly when tenantId is empty", () => {
    expect(() => createStack({ tenantId: "" })).toThrow(/tenantId/);
  });
});

describe("event runtime naming helpers", () => {
  it("should build the per-event stack id from an alphanumeric event id", () => {
    expect(buildEventRuntimeStackId("evt123")).toBe("tenkacloud-event-runtime-evt123");
  });

  it("should accept an internal hyphen but reject underscores/spaces/dots/leading hyphen", () => {
    expect(buildEventRuntimeStackId("evt-123")).toBe("tenkacloud-event-runtime-evt-123");
    for (const bad of ["evt_123", "evt 123", "evt.123", "évt", "-evt", ""]) {
      expect(() => buildEventRuntimeStackId(bad)).toThrow(/stack-name safe/);
    }
  });
});
