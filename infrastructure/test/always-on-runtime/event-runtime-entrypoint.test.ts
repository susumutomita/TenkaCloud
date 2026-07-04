import { fileURLToPath } from "node:url";
import { type App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALWAYS_ON_EVENT_ID_ENV,
  ALWAYS_ON_EXPIRES_AT_ENV,
  ALWAYS_ON_TENANT_ID_ENV,
  buildEventRuntimeApp,
} from "../../bin/tenkacloud-always-on-runtime.js";
import {
  buildEventRuntimeManifestParameterName,
  buildEventRuntimeStackId,
} from "../../lib/always-on-runtime/event-runtime-stack.js";
import {
  MANAGED_BY_ALWAYS_ON_RUNTIME,
  TAG_EVENT_ID,
  TAG_EXPIRES_AT,
  TAG_MANAGED_BY,
  TAG_TENANT_ID,
} from "../../lib/always-on-runtime/runtime-tags.js";

const EVENT_ID = "evt-123";
const TENANT_ID = "tenant-42";
const EXPIRES_AT = "2026-07-04T12:30:00Z";
const EXPIRES_AT_ISO = "2026-07-04T12:30:00.000Z";

const BASE_ENV: NodeJS.ProcessEnv = {
  [ALWAYS_ON_EVENT_ID_ENV]: EVENT_ID,
  [ALWAYS_ON_TENANT_ID_ENV]: TENANT_ID,
  [ALWAYS_ON_EXPIRES_AT_ENV]: EXPIRES_AT,
  CDK_PARAM_AWS_ACCOUNT_ID: "111111111111",
  CDK_PARAM_AWS_REGION: "ap-northeast-1",
  CDK_SKIP_BUNDLING: "1",
};

function findStacks(app: App): Stack[] {
  return app.node.findAll().filter((construct): construct is Stack => Stack.isStack(construct));
}

describe("buildEventRuntimeApp", () => {
  it("should synthesize exactly one per-event runtime stack with its manifest and tags", () => {
    const app = buildEventRuntimeApp({ env: BASE_ENV });
    const stacks = findStacks(app);
    expect(stacks.map((stack) => stack.node.id)).toEqual([buildEventRuntimeStackId(EVENT_ID)]);

    const template = Template.fromStack(stacks[0]);
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: buildEventRuntimeManifestParameterName(EVENT_ID),
      Value: JSON.stringify({
        eventId: EVENT_ID,
        tenantId: TENANT_ID,
        expiresAt: EXPIRES_AT,
        managedBy: MANAGED_BY_ALWAYS_ON_RUNTIME,
      }),
      Tags: {
        [TAG_EVENT_ID]: EVENT_ID,
        [TAG_TENANT_ID]: TENANT_ID,
        [TAG_EXPIRES_AT]: EXPIRES_AT_ISO,
        [TAG_MANAGED_BY]: MANAGED_BY_ALWAYS_ON_RUNTIME,
        Project: "TenkaCloud",
        Environment: "development",
      },
    });
  });

  it.each([
    ["missing", ALWAYS_ON_EVENT_ID_ENV, undefined],
    ["blank", ALWAYS_ON_EVENT_ID_ENV, "   "],
    ["missing", ALWAYS_ON_TENANT_ID_ENV, undefined],
    ["blank", ALWAYS_ON_TENANT_ID_ENV, ""],
    ["missing", ALWAYS_ON_EXPIRES_AT_ENV, undefined],
    ["blank", ALWAYS_ON_EXPIRES_AT_ENV, "   "],
  ])("should fail loudly when %s %s is supplied", (_case, envName, value) => {
    const env = { ...BASE_ENV, [envName]: value };
    expect(() => buildEventRuntimeApp({ env })).toThrow(envName);
  });

  it("should fail loudly when the expiry is unparseable", () => {
    expect(() =>
      buildEventRuntimeApp({
        env: { ...BASE_ENV, [ALWAYS_ON_EXPIRES_AT_ENV]: "not-a-date" },
      }),
    ).toThrow(/valid date/i);
  });

  it("should support an environment-agnostic stack and configured aspect values", () => {
    const {
      CDK_PARAM_AWS_ACCOUNT_ID: _account,
      CDK_PARAM_AWS_REGION: _region,
      CDK_SKIP_BUNDLING: _skipBundling,
      ...env
    } = BASE_ENV;
    const app = buildEventRuntimeApp({
      env: {
        ...env,
        CDK_PARAM_ENVIRONMENT: "production",
        CDK_PARAM_KMS_PENDING_WINDOW_DAYS: "14",
        CDK_PARAM_DYNAMODB_READ_CAPACITY: "2",
        CDK_PARAM_DYNAMODB_WRITE_CAPACITY: "3",
      },
    });

    Template.fromStack(findStacks(app)[0]).hasResourceProperties("AWS::SSM::Parameter", {
      Tags: Match.objectLike({
        Project: "TenkaCloud",
        Environment: "production",
      }),
    });
  });
});

describe("tenkacloud-always-on-runtime entrypoint guard", () => {
  const savedArgv1 = process.argv[1];
  const savedEnv = {
    [ALWAYS_ON_EVENT_ID_ENV]: process.env[ALWAYS_ON_EVENT_ID_ENV],
    [ALWAYS_ON_TENANT_ID_ENV]: process.env[ALWAYS_ON_TENANT_ID_ENV],
    [ALWAYS_ON_EXPIRES_AT_ENV]: process.env[ALWAYS_ON_EXPIRES_AT_ENV],
  };

  afterEach(() => {
    process.argv[1] = savedArgv1;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.resetModules();
  });

  it("should build the app when invoked as the CDK entrypoint", async () => {
    const modulePath = fileURLToPath(
      new URL("../../bin/tenkacloud-always-on-runtime.ts", import.meta.url),
    );
    process.argv[1] = modulePath;
    process.env[ALWAYS_ON_EVENT_ID_ENV] = EVENT_ID;
    process.env[ALWAYS_ON_TENANT_ID_ENV] = TENANT_ID;
    process.env[ALWAYS_ON_EXPIRES_AT_ENV] = EXPIRES_AT;
    vi.resetModules();

    await expect(import("../../bin/tenkacloud-always-on-runtime.js")).resolves.toBeDefined();
  });

  it("should not build the app when argv carries no script path", async () => {
    process.argv[1] = "";
    vi.resetModules();

    await expect(import("../../bin/tenkacloud-always-on-runtime.js")).resolves.toBeDefined();
  });
});
