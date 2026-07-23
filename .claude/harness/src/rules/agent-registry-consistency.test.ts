import { describe, expect, it } from "vitest";
import { agentRegistryConsistency } from "./agent-registry-consistency.ts";

const PRINCIPLES_PATH = "docs/architecture/principles.md";
const ENFORCEMENT_DOC_PATH = "docs/architecture/enforcement-registry.md";
const MANIFEST_PATH = "docs/architecture/enforcement-rules.json";
const IMPLEMENTATION_PATH = ".claude/harness/src/rules/sample-rule.ts";
const TEST_PATH = ".claude/harness/src/rules/sample-rule.test.ts";
const CLAUDE_MD_PATH = "CLAUDE.md";
const HARNESS_SKILL_PATH = ".claude/skills/harness/SKILL.md";
const RULE_A_PATH = ".claude/harness/src/rules/rule-a.ts";
const RULE_A_TEST_PATH = ".claude/harness/src/rules/rule-a.test.ts";
const RULE_B_PATH = ".claude/harness/src/rules/rule-b.ts";
const RULE_B_TEST_PATH = ".claude/harness/src/rules/rule-b.test.ts";
const RULE_C_PATH = ".claude/harness/src/rules/rule-c.ts";
const RULE_C_TEST_PATH = ".claude/harness/src/rules/rule-c.test.ts";

interface FixtureOptions {
  readonly principles?: string;
  readonly enforcement?: string;
  readonly manifest?: unknown;
  readonly implementation?: string;
  readonly test?: string;
  readonly extraFiles?: Readonly<Record<string, string>>;
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "sample-rule",
    principle: "PRINCIPLE_SAMPLE",
    implementation: IMPLEMENTATION_PATH,
    test: TEST_PATH,
    timing: "pre-commit / CI",
    severity: "error",
    scope: "sample scope",
    exception: "fix the sample",
    ...overrides,
  };
}

function fixture(options: FixtureOptions = {}) {
  const files: Record<string, string> = {
    [PRINCIPLES_PATH]: options.principles ?? "# Principles\n\n### `PRINCIPLE_SAMPLE`\n\nSample.\n",
    [ENFORCEMENT_DOC_PATH]:
      options.enforcement ??
      "# Enforcement\n\n| Rule ID | Principle | Scope | Severity |\n| --- | --- | --- | --- |\n| `sample-rule` | `PRINCIPLE_SAMPLE` | sample | error |\n",
    [MANIFEST_PATH]: JSON.stringify(options.manifest ?? [entry()]),
    [IMPLEMENTATION_PATH]:
      options.implementation ??
      'import type { Rule } from "../types.ts";\nexport const sampleRule: Rule = { id: "sample-rule", severity: "error", check: () => [] };\n',
    [TEST_PATH]: options.test ?? "// sample-rule contract test\n",
    ...(options.extraFiles ?? {}),
  };
  return {
    files: [MANIFEST_PATH],
    allFiles: Object.keys(files),
    readFile: (path: string) => {
      if (!(path in files)) throw new Error(`missing: ${path}`);
      return files[path] ?? "";
    },
  };
}

function findingMatches(options: FixtureOptions, match: string): boolean {
  return agentRegistryConsistency
    .check(fixture(options))
    .some((finding) => finding.match === match);
}

function ruleImplementation(id: string): string {
  return `import type { Rule } from "../types.ts";\nexport const rule: Rule = { id: "${id}", severity: "error", check: () => [] };\n`;
}

/** A 4-rule manifest (sample-rule + rule-a/b/c) used to reproduce a *partial* prose
 * enumeration — the exact shape of the "13 of 16 rules" drift this check exists to catch. */
function fourRuleManifest() {
  return [
    entry(),
    entry({ id: "rule-a", implementation: RULE_A_PATH, test: RULE_A_TEST_PATH }),
    entry({ id: "rule-b", implementation: RULE_B_PATH, test: RULE_B_TEST_PATH }),
    entry({ id: "rule-c", implementation: RULE_C_PATH, test: RULE_C_TEST_PATH }),
  ];
}

function fourRuleEnforcementDoc(): string {
  return (
    "# Enforcement\n\n| Rule ID | Principle | Scope | Severity |\n| --- | --- | --- | --- |\n" +
    "| `sample-rule` | `PRINCIPLE_SAMPLE` | sample | error |\n" +
    "| `rule-a` | `PRINCIPLE_SAMPLE` | sample | error |\n" +
    "| `rule-b` | `PRINCIPLE_SAMPLE` | sample | error |\n" +
    "| `rule-c` | `PRINCIPLE_SAMPLE` | sample | error |\n"
  );
}

function fourRuleImplementationFiles(): Record<string, string> {
  return {
    [RULE_A_PATH]: ruleImplementation("rule-a"),
    [RULE_A_TEST_PATH]: "// rule-a contract test\n",
    [RULE_B_PATH]: ruleImplementation("rule-b"),
    [RULE_B_TEST_PATH]: "// rule-b contract test\n",
    [RULE_C_PATH]: ruleImplementation("rule-c"),
    [RULE_C_TEST_PATH]: "// rule-c contract test\n",
  };
}

describe("agentRegistryConsistency", () => {
  it("should pass when principle, manifest, implementation, test, and docs agree", () => {
    expect(agentRegistryConsistency.check(fixture())).toEqual([]);
  });

  it("should report duplicate principle and rule IDs", () => {
    const findings = agentRegistryConsistency.check(
      fixture({
        principles:
          "# Principles\n\n### `PRINCIPLE_SAMPLE`\n\nA.\n\n### `PRINCIPLE_SAMPLE`\n\nB.\n",
        manifest: [entry(), entry()],
      }),
    );

    expect(findings.filter((finding) => finding.match === "PRINCIPLE_SAMPLE")).toHaveLength(1);
    expect(findings.some((finding) => finding.message.includes("rule ID"))).toBe(true);
  });

  it("should reject a manifest reference to a missing principle", () => {
    expect(
      findingMatches(
        {
          principles: "# Principles\n\n### `PRINCIPLE_OTHER`\n\nOther.\n",
        },
        "PRINCIPLE_SAMPLE",
      ),
    ).toBe(true);
  });

  it("should reject a missing implementation or test target", () => {
    expect(
      findingMatches(
        {
          manifest: [entry({ implementation: "missing-rule.ts" })],
        },
        "missing-rule.ts",
      ),
    ).toBe(true);
    expect(
      findingMatches(
        {
          manifest: [entry({ test: "missing-rule.test.ts" })],
        },
        "missing-rule.test.ts",
      ),
    ).toBe(true);
  });

  it("should reject implementation id or severity drift", () => {
    const findings = agentRegistryConsistency.check(
      fixture({
        implementation:
          'import type { Rule } from "../types.ts";\nexport const sampleRule: Rule = { id: "renamed-rule", severity: "warning", check: () => [] };\n',
      }),
    );

    expect(findings.some((finding) => finding.filePath === IMPLEMENTATION_PATH)).toBe(true);
  });

  it("should reject an architecture rule that is absent from the manifest", () => {
    const orphanPath = ".claude/harness/src/rules/orphan-rule.ts";
    expect(
      findingMatches(
        {
          extraFiles: {
            [orphanPath]:
              'import type { Rule } from "../types.ts";\nexport const orphanRule: Rule = { id: "orphan-rule", severity: "error", check: () => [] };\n',
          },
        },
        orphanPath,
      ),
    ).toBe(true);
  });

  it("should reject human documentation drift", () => {
    expect(
      findingMatches(
        {
          enforcement: "# Enforcement\n\nPRINCIPLE_SAMPLE is review-only.\n",
        },
        "sample-rule",
      ),
    ).toBe(true);
  });

  it("should reject a principle with no enforcement or review coverage", () => {
    expect(
      findingMatches(
        {
          principles:
            "# Principles\n\n### `PRINCIPLE_SAMPLE`\n\nSample.\n\n### `PRINCIPLE_ORPHAN`\n\nOrphan.\n",
        },
        "PRINCIPLE_ORPHAN",
      ),
    ).toBe(true);
  });

  it("should reject malformed manifest data", () => {
    const findings = agentRegistryConsistency.check(fixture({ manifest: [{ id: "partial" }] }));
    expect(findings.some((finding) => finding.match === "invalid manifest")).toBe(true);
  });

  it("should ignore unrelated staged changes", () => {
    const context = fixture();
    expect(
      agentRegistryConsistency.check({
        ...context,
        files: ["README.md"],
      }),
    ).toEqual([]);
  });

  it("should pass when CLAUDE.md points at the registry without enumerating rule IDs", () => {
    const findings = agentRegistryConsistency.check(
      fixture({
        extraFiles: {
          [CLAUDE_MD_PATH]: "See docs/architecture/enforcement-registry.md for the rule list.\n",
        },
      }),
    );
    expect(findings.some((finding) => finding.filePath === CLAUDE_MD_PATH)).toBe(false);
  });

  it("should reject CLAUDE.md re-growing a partial machine-rule list (reproduces the 13-of-16 drift)", () => {
    const findings = agentRegistryConsistency.check(
      fixture({
        manifest: fourRuleManifest(),
        enforcement: fourRuleEnforcementDoc(),
        extraFiles: {
          ...fourRuleImplementationFiles(),
          [CLAUDE_MD_PATH]: "- `sample-rule` — sample.\n- `rule-a` — a.\n",
        },
      }),
    );
    expect(findings.some((finding) => finding.filePath === CLAUDE_MD_PATH)).toBe(true);
  });

  it("should reject the harness skill re-growing a partial machine-rule list", () => {
    const findings = agentRegistryConsistency.check(
      fixture({
        manifest: fourRuleManifest(),
        enforcement: fourRuleEnforcementDoc(),
        extraFiles: {
          ...fourRuleImplementationFiles(),
          [HARNESS_SKILL_PATH]: "- `sample-rule` — sample.\n- `rule-a` — a.\n",
        },
      }),
    );
    expect(findings.some((finding) => finding.filePath === HARNESS_SKILL_PATH)).toBe(true);
  });

  it("should not flag CLAUDE.md when it enumerates every currently registered rule ID", () => {
    const findings = agentRegistryConsistency.check(
      fixture({
        manifest: fourRuleManifest(),
        enforcement: fourRuleEnforcementDoc(),
        extraFiles: {
          ...fourRuleImplementationFiles(),
          [CLAUDE_MD_PATH]: "- `sample-rule`\n- `rule-a`\n- `rule-b`\n- `rule-c`\n",
        },
      }),
    );
    expect(findings.some((finding) => finding.filePath === CLAUDE_MD_PATH)).toBe(false);
  });

  it("should detect CLAUDE.md rule-list drift even when CLAUDE.md is the only staged file", () => {
    const context = fixture({
      manifest: fourRuleManifest(),
      enforcement: fourRuleEnforcementDoc(),
      extraFiles: {
        ...fourRuleImplementationFiles(),
        [CLAUDE_MD_PATH]: "- `sample-rule` — sample.\n- `rule-a` — a.\n",
      },
    });
    const findings = agentRegistryConsistency.check({ ...context, files: [CLAUDE_MD_PATH] });
    expect(findings.some((finding) => finding.filePath === CLAUDE_MD_PATH)).toBe(true);
  });
});
