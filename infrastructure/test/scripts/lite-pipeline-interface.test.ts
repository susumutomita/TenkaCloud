import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [Issue #2696 PR 3] The CFn console experience for the Lite-mode launcher
 * (infrastructure/templates/lite-pipeline.yaml) dumps all 15 parameters into one
 * flat, unordered list today, so a first-time deployer can't tell which single
 * field (TenantAdminEmail) they actually need to fill in, and the console gives no
 * hint about the standing DynamoDB cost or why it is asking for an IAM
 * capabilities acknowledgement. This pins:
 *
 *   - An AWS::CloudFormation::Interface ParameterGroups block that places every
 *     declared parameter into exactly one group, with a "Required" group
 *     containing ONLY TenantAdminEmail.
 *   - ParameterLabels giving TenantAdminEmail a human label.
 *   - A standing-cost sentence, distinct from the existing build-cost sentence, so
 *     a deployer understands DynamoDB accrues cost while the stack stays up (not
 *     just while CodeBuild is running).
 *   - A plain-language sentence explaining the CodeBuild role's broad
 *     (administrator-equivalent) permissions, on the same console page as the IAM
 *     capabilities acknowledge checkbox.
 *
 * Assertion style follows lite-pipeline-capacity.test.ts: block extraction over
 * the raw file text, not a full YAML parse -- the template uses CFn intrinsic
 * tags (!Ref / !Sub / !If / !Not / !Equals / !GetAtt) that a plain YAML.parse
 * cannot load without a custom schema.
 */
const template = readFileSync(
  join(__dirname, "..", "..", "templates", "lite-pipeline.yaml"),
  "utf8",
);

/**
 * Every top-level Parameters logical ID, derived from the file itself (not
 * hardcoded) so a future 16th parameter added without a ParameterGroups entry
 * fails this suite instead of silently shipping ungrouped.
 */
function declaredParameterNames(): string[] {
  const block = template.match(/\nParameters:\n([\s\S]*?)\nConditions:\n/)?.[1];
  if (!block) throw new Error("Parameters block not found in lite-pipeline.yaml");
  const names = [...block.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):\s*$/gm)].map((m) => m[1]);
  if (names.length === 0) throw new Error("no parameter names extracted from Parameters block");
  return names;
}

/** Raw text of the AWS::CloudFormation::Interface metadata block, if present. */
function interfaceMetadataBlock(): string {
  const block = template.match(
    /Metadata:\n {2}AWS::CloudFormation::Interface:\n([\s\S]*?)\nParameters:\n/,
  )?.[1];
  if (!block) {
    throw new Error(
      "AWS::CloudFormation::Interface metadata block not found in lite-pipeline.yaml",
    );
  }
  return block;
}

/** [{label, params}] for every ParameterGroups entry inside the Interface metadata. */
function parameterGroups(): Array<{ label: string; params: string[] }> {
  const metadata = interfaceMetadataBlock();
  const groupsBlock = metadata.match(/ParameterGroups:\n([\s\S]*?)\n {4}ParameterLabels:\n/)?.[1];
  if (!groupsBlock) throw new Error("ParameterGroups not found in Interface metadata");
  const entries = [
    ...groupsBlock.matchAll(
      // Lazily capture up to (not including) the NEXT "- Label:" entry, the
      // ParameterLabels: sibling key, or end of block -- so this group's
      // Parameters list can't swallow a later group's items.
      /- Label:\n\s*default: "([^"]*)"\n\s*Parameters:\n([\s\S]*?)(?=\n\s*- Label:|\n {4}ParameterLabels:|$)/g,
    ),
  ];
  if (entries.length === 0) throw new Error("no ParameterGroups entries parsed");
  return entries.map((m) => ({
    label: m[1],
    // Each list item is its own line: "          - SomeParam".
    params: [...m[2].matchAll(/^\s*- ([A-Za-z][A-Za-z0-9]*)\s*$/gm)].map((p) => p[1]),
  }));
}

describe("lite-pipeline.yaml CFn console Interface metadata (Issue #2696)", () => {
  it("should declare an AWS::CloudFormation::Interface metadata block with ParameterGroups", () => {
    expect(template).toMatch(/Metadata:\n {2}AWS::CloudFormation::Interface:/);
    expect(interfaceMetadataBlock()).toMatch(/ParameterGroups:/);
  });

  it("should place every declared parameter into exactly one ParameterGroups group", () => {
    const declared = [...declaredParameterNames()].sort();
    const grouped = parameterGroups().flatMap((g) => g.params);

    // No duplicates across groups (a parameter placed in two groups would still
    // pass a naive "is it grouped somewhere" check, so this is asserted first).
    expect(new Set(grouped).size).toBe(grouped.length);
    // Every declared parameter is grouped, and nothing ungrouped/stale is grouped.
    expect([...grouped].sort()).toEqual(declared);
  });

  it("should have a Required group containing exactly TenantAdminEmail", () => {
    const groups = parameterGroups();
    const required = groups.find((g) => /required/i.test(g.label));
    if (!required) throw new Error("no ParameterGroups entry labeled Required");
    expect(required.params).toEqual(["TenantAdminEmail"]);
  });

  it("should give TenantAdminEmail a human ParameterLabels label", () => {
    const metadata = interfaceMetadataBlock();
    const labelsBlock = metadata.match(/ParameterLabels:\n([\s\S]*)$/)?.[1];
    if (!labelsBlock) throw new Error("ParameterLabels not found in Interface metadata");
    const tenantLabel = labelsBlock.match(/TenantAdminEmail:\n\s*default: "([^"]*)"/)?.[1];
    expect(tenantLabel).toBeTruthy();
    expect(tenantLabel).toMatch(/email/i);
  });
});

describe("lite-pipeline.yaml cost + IAM console messaging (Issue #2696)", () => {
  // Everything the CFn console renders above the Parameters form: the file's
  // top-of-template comments, the template Description, and (once added) the
  // Interface metadata -- i.e. everything before the Parameters block starts.
  const header = template.slice(0, template.indexOf("\nParameters:\n"));

  it("should keep the existing build-cost sentence ('under a dollar')", () => {
    expect(header).toMatch(/under a dollar/);
  });

  it("should add a standing-cost sentence distinct from the build-cost sentence", () => {
    expect(header).toMatch(/\$7\.06|standing cost/i);
  });

  it("should state the build-cost and standing-cost facts as separate statements", () => {
    const buildIdx = header.search(/under a dollar/);
    const standingIdx = header.search(/\$7\.06|standing cost/i);
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(standingIdx).toBeGreaterThanOrEqual(0);
    const [start, end] = buildIdx < standingIdx ? [buildIdx, standingIdx] : [standingIdx, buildIdx];
    // A sentence boundary (. or !) between the two facts, not just a comma splice.
    expect(header.slice(start, end)).toMatch(/[.!]\s/);
  });

  it("should plainly explain the CodeBuild role's broad IAM permissions", () => {
    expect(header).toMatch(/administrator-equivalent/i);
  });

  it("should keep the template Description under the CFn 1024-character limit", () => {
    const desc = template.match(
      /^Description: >-\n([\s\S]*?)\n\n(?:#|Metadata:|Parameters:)/m,
    )?.[1];
    if (!desc) throw new Error("Description block not found");
    const folded = desc
      .split("\n")
      .map((line) => line.trim())
      .join(" ")
      .trim();
    expect(folded.length).toBeLessThan(1024);
  });
});

describe("lite-pipeline.yaml ExternalId input contract", () => {
  const externalIdBlock = template.match(
    /\n {2}DeployExternalId:\n([\s\S]*?)\n {2}ControlDataBackend:\n/,
  )?.[1];

  it("should accept an empty same-account trial value or the competitor bootstrap contract", () => {
    expect(externalIdBlock).toBeTruthy();
    expect(externalIdBlock).toContain("AllowedPattern: '^$|^[A-Za-z0-9_=,.@:/-]{16,128}$'");
  });

  it("should explain the exact range and character set in the CloudFormation error", () => {
    expect(externalIdBlock).toContain("16-128 ASCII letters");
    expect(externalIdBlock).toContain("_ = , . @ : / -");
  });
});
