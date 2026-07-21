import { describe, expect, it } from "vitest";
import { agentRegistryConsistency } from "./agent-registry-consistency.ts";

const PRINCIPLES_PATH = "docs/architecture/principles.md";
const ENFORCEMENT_DOC_PATH = "docs/architecture/enforcement-registry.md";
const MANIFEST_PATH = "docs/architecture/enforcement-rules.json";
const IMPLEMENTATION_PATH = ".claude/harness/src/rules/sample-rule.ts";
const TEST_PATH = ".claude/harness/src/rules/sample-rule.test.ts";

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
    [PRINCIPLES_PATH]:
      options.principles ?? "# Principles\n\n### `PRINCIPLE_SAMPLE`\n\nSample.\n",
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
  return agentRegistryConsistency.check(fixture(options)).some((finding) => finding.match === match);
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
});
