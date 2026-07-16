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
 *
 * Assertion style: every per-parameter fact is asserted INSIDE that parameter's
 * extracted block. An unbounded /Name:[\s\S]*?Default: 1/ span would keep matching
 * a LATER parameter's value after the pinned line regressed (mutation-verified in
 * review), so block extraction is what makes these pins real.
 */
const template = readFileSync(
  join(__dirname, "..", "..", "templates", "lite-pipeline.yaml"),
  "utf8",
);

/** One parameter's block: from `  <Name>:` up to the blank line that ends it. */
function paramBlock(name: string): string {
  const block = template.match(new RegExp(`  ${name}:\\n[\\s\\S]*?\\n\\n`))?.[0];
  if (!block) throw new Error(`parameter block ${name} not found in lite-pipeline.yaml`);
  return block;
}

describe.each([
  "DynamoReadCapacity",
  "DynamoWriteCapacity",
] as const)("lite-pipeline.yaml %s parameter (Issue #2679)", (name) => {
  const block = paramBlock(name);

  it("should be a Number parameter", () => {
    expect(block).toMatch(/^\s+Type: Number$/m);
  });

  it("should default to 1 so existing pipelines stay NO-OP", () => {
    expect(block).toMatch(/^\s+Default: 1$/m);
  });

  it("should enforce MinValue 1", () => {
    expect(block).toMatch(/^\s+MinValue: 1$/m);
  });

  it("should enforce the runbook's 200 billing-guard ceiling as MaxValue", () => {
    // docs/operations/dynamodb-event-capacity.md 課金爆死ガード layer 2: the SSM
    // runbook caps event-window changes at 200 so a digit typo (20 → 2000) fails
    // before provisioning. The deploy-time knob shares the same ceiling.
    expect(block).toMatch(/^\s+MaxValue: 200$/m);
  });

  it("should warn in the description that a turso backend ignores the parameter", () => {
    expect(block).toMatch(/[Ii]gnored when ControlDataBackend/);
  });
});

describe("lite-pipeline.yaml capacity wiring (Issue #2679)", () => {
  it("should forward both parameters to the build as environment variables", () => {
    expect(template).toMatch(/Name: DYNAMO_READ_CAPACITY\s*\n\s*Value: !Ref DynamoReadCapacity/);
    expect(template).toMatch(/Name: DYNAMO_WRITE_CAPACITY\s*\n\s*Value: !Ref DynamoWriteCapacity/);
  });

  it("should emit the CDK_PARAM capacity lines unconditionally inside the .env redirect group", () => {
    // The knob only does anything on the dynamodb backend, so the echoes must sit
    // on the UNCONDITIONAL path — if someone tidied them into the adjacent
    // turso-only if-block, dynamodb deploys (the only mode where the value
    // matters) would silently lose the knob. Pin: the echoes appear inside the
    // { ... } > .env redirect group AND after the turso conditional's closing fi.
    const group = template.match(/\{\n[\s\S]*?\} > "\$\{ENV_DIR\}\/\.env"/)?.[0];
    if (!group) throw new Error(".env redirect group not found in lite-pipeline.yaml");
    const afterTursoGate = group.slice(group.lastIndexOf("fi"));
    expect(afterTursoGate).toMatch(/CDK_PARAM_DYNAMODB_READ_CAPACITY=\$\{DYNAMO_READ_CAPACITY\}/);
    expect(afterTursoGate).toMatch(/CDK_PARAM_DYNAMODB_WRITE_CAPACITY=\$\{DYNAMO_WRITE_CAPACITY\}/);
  });
});
