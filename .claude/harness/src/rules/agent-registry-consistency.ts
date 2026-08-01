import type { Finding, Rule, RuleContext, Severity } from "../types.ts";

const PRINCIPLES_PATH = "docs/architecture/principles.md";
const ENFORCEMENT_DOC_PATH = "docs/architecture/enforcement-registry.md";
const ENFORCEMENT_MANIFEST_PATH = "docs/architecture/enforcement-rules.json";
const RULES_PREFIX = ".claude/harness/src/rules/";
// Prose surfaces that have re-grown a hand-maintained, drifting copy of the rule catalog
// before (CLAUDE.md's "Machine-checked enforcement rules" section once listed 13 of 16
// registered rules). These two are checked for partial rule-ID enumeration below.
const CLAUDE_MD_PATH = "CLAUDE.md";
const HARNESS_SKILL_PATH = ".claude/skills/harness/SKILL.md";
const PRINCIPLE_HEADING = /^### `(?<id>PRINCIPLE_[A-Z0-9_]+)`$/gm;
const RULE_CONTRACT =
  /:\s*Rule\s*=\s*\{[\s\S]*?\bid:\s*"(?<id>[a-z0-9-]+)"[\s\S]*?\bseverity:\s*"(?<severity>error|warning|info)"/;
const BACKTICK_TOKEN = /`([^`]+)`/g;

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
  const match = source.match(RULE_CONTRACT);
  const id = match?.groups?.id;
  const severity = match?.groups?.severity as Severity | undefined;
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
    path === CLAUDE_MD_PATH ||
    path === HARNESS_SKILL_PATH ||
    path.startsWith(RULES_PREFIX)
  );
}

/** Rule IDs from `ruleIds` that appear as a backtick-quoted token in `source`. */
function collectMentionedRuleIds(source: string, ruleIds: ReadonlySet<string>): Set<string> {
  const mentioned = new Set<string>();
  for (const match of source.matchAll(BACKTICK_TOKEN)) {
    const token = match[1];
    if (token !== undefined && ruleIds.has(token)) mentioned.add(token);
  }
  return mentioned;
}

/**
 * Prose lists drift: a hand-maintained rule catalog in CLAUDE.md / the harness skill has
 * fallen out of sync with the manifest before (13-of-16 rules listed). A file that mentions
 * 2+ registered rule IDs but not the full current set is re-growing that drifting list —
 * either it should point at the registry instead, or it must stay exhaustive.
 */
function checkProseRuleListDrift(
  ctx: RuleContext,
  manifest: readonly EnforcementEntry[],
): readonly Finding[] {
  const manifestIdSet = new Set(manifest.map((entry) => entry.id));
  const findings: Finding[] = [];
  for (const path of [CLAUDE_MD_PATH, HARNESS_SKILL_PATH]) {
    const source = readOptional(ctx, path);
    if (source === undefined) continue;
    const mentioned = collectMentionedRuleIds(source, manifestIdSet);
    if (mentioned.size < 2 || mentioned.size === manifestIdSet.size) continue;
    findings.push(
      finding(
        path,
        [...mentioned].sort().join(", "),
        `${path} が machine rule ID を部分的に列挙しています (${mentioned.size}/${manifestIdSet.size})。`,
        "手書きの rule 一覧を Enforcement Registry (docs/architecture/enforcement-registry.md / enforcement-rules.json) へのポインタに置き換えてください。",
      ),
    );
  }
  return findings;
}

export const agentRegistryConsistency: Rule = {
  id: "agent-registry-consistency",
  severity: "error",
  // This rule is an intentionally linear registry audit: each invariant reports its own precise
  // source location, and splitting the audit would make the shared finding context harder to keep
  // consistent. The individual validation helpers above remain complexity-bounded.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: registry audit orchestration
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

    findings.push(...checkProseRuleListDrift(ctx, manifest));

    return findings;
  },
};
