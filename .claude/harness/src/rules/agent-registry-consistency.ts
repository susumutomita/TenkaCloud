import type { Finding, Rule, RuleContext, Severity } from "../types.ts";

const PRINCIPLES_PATH = "docs/architecture/principles.md";
const ENFORCEMENT_DOC_PATH = "docs/architecture/enforcement-registry.md";
const ENFORCEMENT_MANIFEST_PATH = "docs/architecture/enforcement-rules.json";
const RULES_PREFIX = ".claude/harness/src/rules/";
const PRINCIPLE_HEADING = /^### `(?<id>PRINCIPLE_[A-Z0-9_]+)`$/gm;
const RULE_ID = /\bid:\s*"(?<id>[a-z0-9-]+)"/;
const RULE_SEVERITY = /\bseverity:\s*"(?<severity>error|warning|info)"/;

interface EnforcementEntry {
  readonly id: string;
  readonly principle: string;
  readonly implementation: string;
  readonly test: string;
  readonly timing: string;
  readonly severity: Severity;
  readonly scope: string;
  readonly exception: string;
}

function finding(
  filePath: string,
  match: string,
  message: string,
  recommendation: string,
): Finding {
  return {
    ruleId: "agent-registry-consistency",
    severity: "error",
    filePath,
    match,
    message,
    recommendation,
  };
}

function readOptional(ctx: RuleContext, path: string): string | undefined {
  try {
    return ctx.readFile(path);
  } catch {
    return undefined;
  }
}

function collectPrincipleIds(source: string): string[] {
  return [...source.matchAll(PRINCIPLE_HEADING)]
    .map((match) => match.groups?.id)
    .filter((id): id is string => id !== undefined);
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function isEnforcementEntry(value: unknown): value is EnforcementEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<EnforcementEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.principle === "string" &&
    typeof entry.implementation === "string" &&
    typeof entry.test === "string" &&
    typeof entry.timing === "string" &&
    (entry.severity === "error" || entry.severity === "warning" || entry.severity === "info") &&
    typeof entry.scope === "string" &&
    typeof entry.exception === "string"
  );
}

function parseManifest(source: string): readonly EnforcementEntry[] | undefined {
  try {
    const parsed: unknown = JSON.parse(source);
    return Array.isArray(parsed) && parsed.every(isEnforcementEntry) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractRuleContract(source: string): { id: string; severity: Severity } | undefined {
  const id = source.match(RULE_ID)?.groups?.id;
  const severity = source.match(RULE_SEVERITY)?.groups?.severity as Severity | undefined;
  return id && severity ? { id, severity } : undefined;
}

function isRuleSourcePath(path: string): boolean {
  return (
    path.startsWith(RULES_PREFIX) &&
    path.endsWith(".ts") &&
    !path.endsWith(".test.ts") &&
    path !== `${RULES_PREFIX}index.ts`
  );
}

function relevantChange(path: string): boolean {
  return (
    path === PRINCIPLES_PATH ||
    path === ENFORCEMENT_DOC_PATH ||
    path === ENFORCEMENT_MANIFEST_PATH ||
    path.startsWith(RULES_PREFIX)
  );
}

export const agentRegistryConsistency: Rule = {
  id: "agent-registry-consistency",
  severity: "error",
  check(ctx: RuleContext): readonly Finding[] {
    if (!ctx.files.some(relevantChange)) return [];

    const findings: Finding[] = [];
    const principlesSource = readOptional(ctx, PRINCIPLES_PATH);
    const enforcementSource = readOptional(ctx, ENFORCEMENT_DOC_PATH);
    const manifestSource = readOptional(ctx, ENFORCEMENT_MANIFEST_PATH);
    if (principlesSource === undefined) {
      findings.push(
        finding(
          PRINCIPLES_PATH,
          PRINCIPLES_PATH,
          "Principle Registry が存在しません。",
          "判断原則の正本を復元し、安定した PRINCIPLE_* ID を登録してください。",
        ),
      );
    }
    if (enforcementSource === undefined) {
      findings.push(
        finding(
          ENFORCEMENT_DOC_PATH,
          ENFORCEMENT_DOC_PATH,
          "Enforcement Registry の説明文書が存在しません。",
          "machine rule と gate の人間向け索引を復元してください。",
        ),
      );
    }
    if (manifestSource === undefined) {
      findings.push(
        finding(
          ENFORCEMENT_MANIFEST_PATH,
          ENFORCEMENT_MANIFEST_PATH,
          "machine-readable enforcement manifest が存在しません。",
          "rule ID、principle、implementation、test、timing、severity、scope、exception を登録してください。",
        ),
      );
    }
    if (!principlesSource || !enforcementSource || !manifestSource) return findings;

    const principleIds = collectPrincipleIds(principlesSource);
    for (const duplicate of duplicateValues(principleIds)) {
      findings.push(
        finding(
          PRINCIPLES_PATH,
          duplicate,
          `Principle ID が重複しています: ${duplicate}`,
          "各原則へ一意な安定 ID を割り当ててください。",
        ),
      );
    }
    const principleSet = new Set(principleIds);

    const manifest = parseManifest(manifestSource);
    if (!manifest) {
      findings.push(
        finding(
          ENFORCEMENT_MANIFEST_PATH,
          "invalid manifest",
          "enforcement manifest が期待 schema に一致しません。",
          "全 entry に id / principle / implementation / test / timing / severity / scope / exception を設定してください。",
        ),
      );
      return findings;
    }

    for (const duplicate of duplicateValues(manifest.map((entry) => entry.id))) {
      findings.push(
        finding(
          ENFORCEMENT_MANIFEST_PATH,
          duplicate,
          `Enforcement rule ID が重複しています: ${duplicate}`,
          "rule ID を一意にし、rename 時は implementation / test / docs を同じ PR で更新してください。",
        ),
      );
    }
    for (const duplicate of duplicateValues(manifest.map((entry) => entry.implementation))) {
      findings.push(
        finding(
          ENFORCEMENT_MANIFEST_PATH,
          duplicate,
          `複数 rule が同じ implementation を指しています: ${duplicate}`,
          "1 implementation file を 1 rule ID に対応させてください。",
        ),
      );
    }

    const registeredImplementationPaths = new Set(manifest.map((entry) => entry.implementation));
    for (const entry of manifest) {
      if (!principleSet.has(entry.principle)) {
        findings.push(
          finding(
            ENFORCEMENT_MANIFEST_PATH,
            entry.principle,
            `${entry.id} が存在しない Principle ID を参照しています: ${entry.principle}`,
            "Principle Registry の既存 ID を参照するか、原則を同じ PR で追加してください。",
          ),
        );
      }

      const implementationSource = readOptional(ctx, entry.implementation);
      if (implementationSource === undefined) {
        findings.push(
          finding(
            ENFORCEMENT_MANIFEST_PATH,
            entry.implementation,
            `${entry.id} の implementation file が存在しません。`,
            "stale manifest entry を削除するか、rule implementation を復元してください。",
          ),
        );
      } else {
        const contract = extractRuleContract(implementationSource);
        if (!contract || contract.id !== entry.id || contract.severity !== entry.severity) {
          findings.push(
            finding(
              entry.implementation,
              entry.id,
              `${entry.id} の manifest と implementation の id / severity が一致しません。`,
              "manifest と Rule object を同じ ID / severity に揃えてください。",
            ),
          );
        }
      }

      if (readOptional(ctx, entry.test) === undefined) {
        findings.push(
          finding(
            ENFORCEMENT_MANIFEST_PATH,
            entry.test,
            `${entry.id} の test file が存在しません。`,
            "正常、違反、境界、誤検知防止を pin する test を追加してください。",
          ),
        );
      }

      const documentationRow = `| \`${entry.id}\` | \`${entry.principle}\` |`;
      if (!enforcementSource.includes(documentationRow)) {
        findings.push(
          finding(
            ENFORCEMENT_DOC_PATH,
            entry.id,
            `${entry.id} が人間向け Enforcement Registry に登録されていません。`,
            `Architecture harness table に ${documentationRow} で始まる行を追加してください。`,
          ),
        );
      }
    }

    const repositoryFiles = ctx.allFiles ?? ctx.files;
    for (const path of repositoryFiles.filter(isRuleSourcePath)) {
      const source = readOptional(ctx, path);
      if (!source || !extractRuleContract(source)) continue;
      if (!registeredImplementationPaths.has(path)) {
        findings.push(
          finding(
            path,
            path,
            "architecture rule implementation が machine-readable manifest から孤立しています。",
            "rule metadata と test、Enforcement Registry の行を同じ PR で追加してください。",
          ),
        );
      }
    }

    for (const principleId of principleIds) {
      if (!enforcementSource.includes(principleId)) {
        findings.push(
          finding(
            ENFORCEMENT_DOC_PATH,
            principleId,
            `${principleId} が enforcement / review coverage から孤立しています。`,
            "machine gate、review skill、または principle-only coverage として Enforcement Registry に紐付けてください。",
          ),
        );
      }
    }

    return findings;
  },
};
