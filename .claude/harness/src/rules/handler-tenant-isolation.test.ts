import { describe, expect, it } from "vitest";
import { handlerTenantIsolation } from "./handler-tenant-isolation.ts";

const EVENT_HANDLER_PATH = "infrastructure/lib/problem-deploy/handlers/event-handler/foo.ts";
const COMPETITOR_HANDLER_PATH =
  "infrastructure/lib/problem-deploy/handlers/competitor-accounts-handler/bar.ts";

describe("handler-tenant-isolation", () => {
  it("対象 path で DDB Command を呼ぶが tenantId に触れない file は warning", () => {
    const code = [
      'import { QueryCommand } from "@aws-sdk/lib-dynamodb";',
      "async function leakAll() {",
      "  await ddb.send(new QueryCommand({ TableName: 't' }));",
      "}",
    ].join("\n");
    const findings = handlerTenantIsolation.check({
      files: [EVENT_HANDLER_PATH],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.match).toBe("no-tenantId-reference");
  });

  it("tenantId を 1 度でも参照していれば通す", () => {
    const code = [
      'import { QueryCommand } from "@aws-sdk/lib-dynamodb";',
      "function safe(tenantId: string) {",
      "  return ddb.send(new QueryCommand({ TableName: 't' }));",
      "}",
    ].join("\n");
    const findings = handlerTenantIsolation.check({
      files: [EVENT_HANDLER_PATH],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("DDB Command を呼んでいない file は対象外", () => {
    const code = 'export const foo = "no ddb here";';
    const findings = handlerTenantIsolation.check({
      files: [EVENT_HANDLER_PATH],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("competitor-accounts-handler 配下も対象", () => {
    const code =
      'import { UpdateCommand } from "@aws-sdk/lib-dynamodb"; ddb.send(new UpdateCommand({}));';
    const findings = handlerTenantIsolation.check({
      files: [COMPETITOR_HANDLER_PATH],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
  });

  it("participant-handler は対象外 (= teamLoginKey scope)", () => {
    const code =
      'import { QueryCommand } from "@aws-sdk/lib-dynamodb"; ddb.send(new QueryCommand({}));';
    const findings = handlerTenantIsolation.check({
      files: ["infrastructure/lib/problem-deploy/handlers/participant-handler/foo.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("shared.ts / types.ts 等は対象外 (= non-entry layer)", () => {
    const code =
      'import { QueryCommand } from "@aws-sdk/lib-dynamodb"; ddb.send(new QueryCommand({}));';
    const sharedFindings = handlerTenantIsolation.check({
      files: ["infrastructure/lib/problem-deploy/handlers/event-handler/shared.ts"],
      readFile: () => code,
    });
    expect(sharedFindings).toHaveLength(0);
    const typesFindings = handlerTenantIsolation.check({
      files: ["infrastructure/lib/problem-deploy/handlers/event-handler/types.ts"],
      readFile: () => code,
    });
    expect(typesFindings).toHaveLength(0);
  });

  it(".test.ts は対象外", () => {
    const code =
      'import { QueryCommand } from "@aws-sdk/lib-dynamodb"; ddb.send(new QueryCommand({}));';
    const findings = handlerTenantIsolation.check({
      files: ["infrastructure/lib/problem-deploy/handlers/event-handler/foo.test.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("admin-insight-handler は対象外 (= cross-tenant 集計が正当な systemAdmin scope)", () => {
    const code =
      'import { QueryCommand } from "@aws-sdk/lib-dynamodb"; ddb.send(new QueryCommand({}));';
    const findings = handlerTenantIsolation.check({
      files: ["infrastructure/lib/admin-insight/handlers/admin-insight-handler/foo.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });
});
