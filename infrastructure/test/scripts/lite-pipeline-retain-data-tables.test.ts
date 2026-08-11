import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [Issue #2959] The CodeBuild launcher must be able to choose the DynamoDB removal policy,
 * and — more importantly — must stop telling users something that is no longer true.
 *
 * Before this change every table was deployed with `DeletionPolicy: Retain`, so
 * `ACTION=destroy` really did preserve DynamoDB history and the template said so. The
 * default is now Delete, which makes that sentence a lie in exactly the direction that
 * costs money: a user reads "destroy preserves history", runs it, and is surprised either
 * way. So this file pins the plumbing AND the wording.
 *
 * Assertion style follows lite-pipeline-capacity.test.ts: per-parameter facts are asserted
 * inside that parameter's extracted block, because an unbounded span keeps matching a later
 * parameter after the pinned line regresses.
 */
const template = readFileSync(
  join(__dirname, "..", "..", "templates", "lite-pipeline.yaml"),
  "utf8",
);
const repoRoot = join(__dirname, "..", "..", "..");

function paramBlock(name: string): string {
  const block = template.match(new RegExp(`  ${name}:\\n[\\s\\S]*?\\n\\n`))?.[0];
  if (!block) throw new Error(`parameter block ${name} not found in lite-pipeline.yaml`);
  return block;
}

describe("lite-pipeline.yaml RetainDataTables parameter (Issue #2959)", () => {
  const block = paramBlock("RetainDataTables");

  it("should default to false so a destroy leaves nothing billing behind", () => {
    expect(block).toMatch(/^\s+Default: "false"$/m);
  });

  it("should accept only the two literal strings", () => {
    // 自由文字列にすると "False" / "1" が黙って false 扱いになり、retain したつもりが消える。
    expect(block).toMatch(/^\s+AllowedValues:$/m);
    expect(block).toMatch(/^\s+- "false"$/m);
    expect(block).toMatch(/^\s+- "true"$/m);
  });

  it("should say that retained tables keep billing and are not cleaned up for you", () => {
    expect(block).toMatch(/billing/i);
    expect(block).toContain("aws dynamodb delete-table");
  });

  it("should warn that the value is baked in at deploy time", () => {
    // これを書かないと「destroy の直前に true にすれば残る」と読まれる。実際には CFn に
    // 載っている DeletionPolicy が使われるので、先に deploy し直さないと効かない。
    expect(block).toMatch(/DEPLOY time|deploy time/i);
  });
});

describe("lite-pipeline.yaml RetainDataTables wiring (Issue #2959)", () => {
  it("should surface the parameter in the console parameter group", () => {
    expect(template).toMatch(/^\s+- RetainDataTables$/m);
  });

  it("should forward it to CodeBuild as an environment variable", () => {
    expect(template).toMatch(
      /- Name: RETAIN_DATA_TABLES\n\s+Value: !Ref RetainDataTables\n\s+Type: PLAINTEXT/,
    );
  });

  it("should emit it into the .env the CDK deploy reads", () => {
    expect(template).toContain(`echo "CDK_PARAM_RETAIN_DATA_TABLES=\${RETAIN_DATA_TABLES}"`);
  });
});

describe("lite-pipeline.yaml destroy wording (Issue #2959)", () => {
  it("should no longer claim that ACTION=destroy preserves DynamoDB history", () => {
    // これがこの file の主目的。既定を変えたのに文言を残すと、コストの罠を案内文が作る。
    expect(template).not.toMatch(/destroy` removes stacks while\n\s+preserving DynamoDB history/);
    expect(template).not.toContain("ACTION=destroy preserves DynamoDB history");
    expect(template).not.toContain(
      'echo "DynamoDB history was retained; no complete-cleanup checkpoint is emitted."',
    );
  });

  it("should point at RetainDataTables wherever it talks about keeping history", () => {
    const actionBlock = paramBlock("Action");
    expect(actionBlock).toContain("RetainDataTables");
  });

  it("should keep public Lite teardown guidance aligned with the default removal policy", () => {
    const publicGuidancePaths = [
      "README.md",
      "README.ja.md",
      "infrastructure/templates/README.md",
      "docs/operations/event-runbook.md",
      "docs/running-costs.md",
      "scripts/tenkacloud-lite.ts",
      "apps/developer-portal/src/app/developers/docs/getting-started/page.mdx",
      "apps/developer-portal/src/app/developers/docs/getting-started/page.ja.mdx",
      "infrastructure/environments/development/.env.example",
      "infrastructure/environments/production/.env.example",
      "landing/docs/getting-started/index.en.html",
      "landing/docs/getting-started/index.html",
    ];
    const staleClaims = [
      "ACTION=destroy (DynamoDB 履歴を残す場合)",
      "`destroy`（DynamoDB 履歴保持）",
      "make destroy       — stack を削除し、DynamoDB 履歴は保持",
      "DDB 履歴は保持",
      "Use `make destroy` only when retaining the DynamoDB history is intentional",
      "tables all use `RemovalPolicy.RETAIN`",
      "8 DynamoDB tables above use RemovalPolicy.RETAIN",
      "make destroy</code> removes the stacks while retaining DynamoDB",
    ];

    for (const path of publicGuidancePaths) {
      const content = readFileSync(join(repoRoot, path), "utf8");
      for (const staleClaim of staleClaims) {
        expect(content, `${path}: ${staleClaim}`).not.toContain(staleClaim);
      }
    }

    expect(readFileSync(join(repoRoot, "README.md"), "utf8")).toContain("RetainDataTables=true");
    expect(readFileSync(join(repoRoot, "docs/running-costs.md"), "utf8")).toContain(
      "CDK_PARAM_RETAIN_DATA_TABLES=true",
    );
    expect(
      readFileSync(
        join(repoRoot, "apps/developer-portal/src/app/developers/docs/getting-started/page.mdx"),
        "utf8",
      ),
    ).toContain("deletes DynamoDB tables by default");
  });
});
