import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [Issue #2679] The CodeBuild launcher (infrastructure/templates/lite-pipeline.yaml)
 * is the one-click deploy path. `resolveAppConfig` has accepted
 * CDK_PARAM_DYNAMODB_READ_CAPACITY / CDK_PARAM_DYNAMODB_WRITE_CAPACITY for a long
 * time (app-config/resolve.ts) and the DynamoDbLowCapacity aspect applies whatever
 * the caller passes — but the pipeline never forwarded a value, so every pipeline
 * deploy was pinned to 1 RCU / 1 WCU. This pins the parameter → CodeBuild env →
 * .env wiring so the deploy-time capacity knob cannot silently regress.
 */
const template = readFileSync(
  join(__dirname, "..", "..", "templates", "lite-pipeline.yaml"),
  "utf8",
);

describe("lite-pipeline.yaml DynamoDB capacity parameters (Issue #2679)", () => {
  it("should declare DynamoReadCapacity / DynamoWriteCapacity as Number parameters", () => {
    expect(template).toMatch(/DynamoReadCapacity:\s*\n\s*Type: Number/);
    expect(template).toMatch(/DynamoWriteCapacity:\s*\n\s*Type: Number/);
  });

  it("should default both capacities to 1 so existing pipelines stay NO-OP", () => {
    expect(template).toMatch(/DynamoReadCapacity:[\s\S]*?Default: 1\b/);
    expect(template).toMatch(/DynamoWriteCapacity:[\s\S]*?Default: 1\b/);
  });

  it("should enforce MinValue 1 on both capacity parameters", () => {
    expect(template).toMatch(/DynamoReadCapacity:[\s\S]*?MinValue: 1\b/);
    expect(template).toMatch(/DynamoWriteCapacity:[\s\S]*?MinValue: 1\b/);
  });

  it("should warn in both descriptions that a turso backend ignores the parameter", () => {
    // A user picking the zero-cost turso backend must not expect this knob to do
    // anything — CDK synthesizes zero DynamoDB tables there.
    const readBlock = template.match(/DynamoReadCapacity:[\s\S]*?\n\n/)?.[0] ?? "";
    const writeBlock = template.match(/DynamoWriteCapacity:[\s\S]*?\n\n/)?.[0] ?? "";
    expect(readBlock).toMatch(/[Ii]gnored when ControlDataBackend/);
    expect(writeBlock).toMatch(/[Ii]gnored when ControlDataBackend/);
  });

  it("should forward both parameters to the build as environment variables", () => {
    expect(template).toMatch(/Name: DYNAMO_READ_CAPACITY\s*\n\s*Value: !Ref DynamoReadCapacity/);
    expect(template).toMatch(/Name: DYNAMO_WRITE_CAPACITY\s*\n\s*Value: !Ref DynamoWriteCapacity/);
  });

  it("should write the CDK_PARAM capacity lines into the generated .env", () => {
    expect(template).toMatch(/CDK_PARAM_DYNAMODB_READ_CAPACITY=\$\{DYNAMO_READ_CAPACITY\}/);
    expect(template).toMatch(/CDK_PARAM_DYNAMODB_WRITE_CAPACITY=\$\{DYNAMO_WRITE_CAPACITY\}/);
  });
});
