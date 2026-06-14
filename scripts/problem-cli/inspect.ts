import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "./constants";
import { findProblemDir, getTemplateName, readProblemMetadata } from "./problem-loader";
import { inspectTemplateSections } from "./template-inspector";

/**
 * Issue #951 sub #5: problem author 向け debug inspector。
 */
export interface InspectResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly lines: readonly string[];
}

export function runInspect(args: { problemId: string }): InspectResult {
  const dir = findProblemDir(args.problemId);
  if (!dir) {
    return { ok: false, summary: `Problem dir not found for id="${args.problemId}"`, lines: [] };
  }
  const metaPath = join(dir, "metadata.json");
  if (!existsSync(metaPath)) {
    return { ok: false, summary: "metadata.json not found", lines: [] };
  }
  const meta = readProblemMetadata(dir);
  const lines: string[] = [];
  const scoring = (meta.scoring ?? {}) as Record<string, unknown>;
  const kind = String(scoring.kind ?? "");
  const endpoints = Array.isArray(meta.endpoints) ? meta.endpoints : [];

  appendProblemHeader(lines, args.problemId, dir, meta);
  appendScoring(lines, kind, scoring);
  appendEndpointRegistry(lines, endpoints);
  appendPhases(lines, meta);
  appendDisruptions(lines, meta);
  appendPortalSlots(lines, dir, meta);
  appendTemplateInspection(lines, dir, meta, kind, scoring, endpoints);

  return { ok: true, summary: `inspect ${args.problemId} (kind=${kind})`, lines };
}

function appendProblemHeader(
  lines: string[],
  problemId: string,
  dir: string,
  meta: Record<string, unknown>,
): void {
  lines.push(`=== Problem ${problemId} ===`);
  lines.push(`directory:        ${dir.replace(REPO_ROOT, "")}`);
  lines.push(`name:             ${String(meta.name ?? "(none)")}`);
  lines.push(`category:         ${String(meta.category ?? "(none)")}`);
  lines.push(`status:           ${String(meta.status ?? "(none)")}`);
  lines.push(`visibility:       ${String(meta.visibility ?? "public")}`);
  lines.push(`difficulty:       ${String(meta.difficulty ?? "(none)")}`);
  lines.push(`estimatedDuration: ${String(meta.estimatedDuration ?? "(none)")}`);
  lines.push("");
}

function appendScoring(lines: string[], kind: string, scoring: Record<string, unknown>): void {
  lines.push(`--- Scoring engine view ---`);
  lines.push(`kind:             ${kind || "(none)"}`);
  appendKindScoring(lines, kind, scoring);
  appendHints(lines, scoring);
  lines.push("");
}

function appendKindScoring(lines: string[], kind: string, scoring: Record<string, unknown>): void {
  if (kind === "flag") appendFlagScoring(lines, scoring);
  else if (kind === "multi-flag") appendMultiFlagScoring(lines, scoring);
  else if (kind === "uptime-flat" || kind === "uptime") appendUptimeFlatScoring(lines, scoring);
  else if (kind === "uptime-multi") appendUptimeMultiScoring(lines, scoring);
  else if (kind === "phased-polling") appendPhasedPollingScoring(lines, scoring);
  else if (kind === "attack-detection") appendAttackDetectionScoring(lines, scoring);
}

function appendFlagScoring(lines: string[], scoring: Record<string, unknown>): void {
  lines.push(`flagOutputKey:    ${String(scoring.flagOutputKey ?? "(missing)")}`);
  lines.push(`points:           ${String(scoring.points ?? "(missing)")}`);
  if (scoring.wrongAnswerPenalty)
    lines.push(`wrongAnswerPenalty: ${String(scoring.wrongAnswerPenalty)}`);
}

function appendMultiFlagScoring(lines: string[], scoring: Record<string, unknown>): void {
  const flags = Array.isArray(scoring.flags) ? scoring.flags : [];
  const total = (flags as Array<Record<string, unknown>>).reduce(
    (sum, f) => sum + (typeof f.points === "number" ? f.points : 0),
    0,
  );
  lines.push(`flags:            ${flags.length} (= 各 flag 個別提出 / 部分点 合計 ${total})`);
  for (const f of flags as Array<Record<string, unknown>>) {
    const penalty = f.wrongAnswerPenalty ? ` penalty=${String(f.wrongAnswerPenalty)}` : "";
    lines.push(
      `                  - id=${String(f.id ?? "?")} key=${String(f.flagOutputKey ?? "?")} points=${String(f.points ?? "?")}${penalty}`,
    );
  }
}

function appendUptimeFlatScoring(lines: string[], scoring: Record<string, unknown>): void {
  const eps = Array.isArray(scoring.endpoints) ? scoring.endpoints : [];
  lines.push(`endpoints:        ${eps.length}`);
  for (const ep of eps as Array<Record<string, unknown>>) {
    lines.push(
      `                  - slot=${String(ep.slot ?? "?")} path=${String(ep.path ?? "?")} expect=${JSON.stringify(ep.expectStatus ?? [])}`,
    );
  }
  lines.push(`pointsPerSuccess: ${String(scoring.pointsPerSuccess ?? "(missing)")}`);
  if (scoring.failurePenalty !== undefined)
    lines.push(`failurePenalty:   ${String(scoring.failurePenalty)}`);
}

function appendUptimeMultiScoring(lines: string[], scoring: Record<string, unknown>): void {
  const slots = Array.isArray(scoring.probedSlots) ? scoring.probedSlots : [];
  lines.push(`probedSlots:      ${slots.length} (= 全部 OK で加点)`);
  for (const s of slots as Array<Record<string, unknown>>) {
    lines.push(
      `                  - slot=${String(s.slot ?? "?")} path=${String(s.path ?? "?")} expect=${JSON.stringify(s.expectStatus ?? [])}`,
    );
  }
  lines.push(`pointsAllOk:      ${String(scoring.pointsAllOk ?? "(missing)")}`);
  lines.push(`failurePenalty:   ${String(scoring.failurePenalty ?? "0")}`);
}

function appendPhasedPollingScoring(lines: string[], scoring: Record<string, unknown>): void {
  lines.push(`intervalMinutes:  ${String(scoring.intervalMinutes ?? "(missing)")}`);
  const platforms = scoring.platformRules as Record<string, unknown> | undefined;
  lines.push(`platformRules:    ${platforms ? Object.keys(platforms).join(", ") : "(missing)"}`);
  const probe = scoring.probe as Record<string, unknown> | undefined;
  lines.push(
    `probe paths:      meta=${String(probe?.metaPath ?? "?")} score=${String(probe?.scorePath ?? "?")}`,
  );
}

function appendAttackDetectionScoring(lines: string[], scoring: Record<string, unknown>): void {
  lines.push(`statsOutputKey:   ${String(scoring.statsOutputKey ?? "(missing)")}`);
  lines.push(`pointsPerAttack:  ${String(scoring.pointsPerAttack ?? "(missing)")}`);
}

function appendHints(lines: string[], scoring: Record<string, unknown>): void {
  const hints = Array.isArray(scoring.hints) ? scoring.hints : [];
  if (hints.length > 0) {
    lines.push(`hints:            ${hints.length} 件`);
    hints.forEach((h, i) => {
      if (typeof h === "string") {
        lines.push(`                  [${i + 1}] (legacy v1, penalty=0) ${h.slice(0, 60)}…`);
      } else if (h && typeof h === "object") {
        const ho = h as Record<string, unknown>;
        lines.push(
          `                  [${i + 1}] id=${String(ho.id)} penalty=${String(ho.penalty)} content="${String(ho.content).slice(0, 50)}…"`,
        );
      }
    });
  }
}

function appendEndpointRegistry(lines: string[], endpoints: unknown[]): void {
  if (endpoints.length > 0) {
    lines.push(`--- Endpoint registry (= metadata.endpoints) ---`);
    for (const ep of endpoints as Array<Record<string, unknown>>) {
      const def = ep.default as Record<string, unknown> | undefined;
      lines.push(
        `  slot=${String(ep.slot)} default-from=${String(def?.from ?? "?")} default-key=${String(def?.key ?? "?")} overridable=${String(ep.overridable ?? false)}`,
      );
    }
    lines.push("");
  }
}

function appendPhases(lines: string[], meta: Record<string, unknown>): void {
  const phases = Array.isArray(meta.phases) ? meta.phases : [];
  if (phases.length > 0) {
    lines.push(`--- Phases ---`);
    for (const ph of phases as Array<Record<string, unknown>>) {
      lines.push(
        `  name=${String(ph.name)} afterMinutes=${String(ph.afterMinutes ?? "?")} effect=${JSON.stringify(ph.effect ?? {})}`,
      );
    }
    lines.push("");
  }
}

function appendDisruptions(lines: string[], meta: Record<string, unknown>): void {
  const disruptions = Array.isArray(meta.disruptions) ? meta.disruptions : [];
  if (disruptions.length > 0) {
    lines.push(`--- Disruptions ---`);
    for (const d of disruptions as Array<Record<string, unknown>>) {
      lines.push(
        `  id=${String(d.id)} name=${String(d.name)} default=${String(d.defaultAfterMinutes ?? "?")}min`,
      );
    }
    lines.push("");
  }
}

function appendPortalSlots(lines: string[], dir: string, meta: Record<string, unknown>): void {
  const dashboard = meta.dashboard as Record<string, unknown> | undefined;
  const slots = dashboard?.slots as Record<string, unknown> | undefined;
  if (slots) {
    lines.push(`--- Portal slots ---`);
    for (const [slot, file] of Object.entries(slots)) {
      const physical = join(dir, String(file));
      const exists = existsSync(physical);
      lines.push(`  ${slot}: ${String(file)} ${exists ? "(OK)" : "(MISSING!)"}`);
    }
    lines.push("");
  }
}

function appendTemplateInspection(
  lines: string[],
  dir: string,
  meta: Record<string, unknown>,
  kind: string,
  scoring: Record<string, unknown>,
  endpoints: unknown[],
): void {
  const cfnTemplate = getTemplateName(meta);
  const templatePath = join(dir, cfnTemplate);
  if (existsSync(templatePath)) {
    const yaml = readFileSync(templatePath, "utf8");
    lines.push(`--- Template (${cfnTemplate}) ---`);
    const { parameterNames, resourceNames, outputNames } = inspectTemplateSections(yaml);
    lines.push(`  Parameters: ${parameterNames.join(", ") || "(none)"}`);
    lines.push(`  Resources:  ${resourceNames.join(", ") || "(none)"}`);
    lines.push(`  Outputs:    ${outputNames.join(", ") || "(none)"}`);

    const crossRefIssues = collectCrossRefIssues({
      kind,
      scoring,
      endpoints,
      resourceNames,
      outputNames,
    });
    if (crossRefIssues.length > 0) {
      lines.push(`  Cross-ref issues:`);
      for (const issue of crossRefIssues) lines.push(`    ✗ ${issue}`);
    } else {
      lines.push(`  Cross-ref:  OK (= all scoring / endpoint keys resolve to Outputs)`);
    }
  } else {
    lines.push(`  Template "${cfnTemplate}" NOT FOUND`);
  }
}

function collectCrossRefIssues(args: {
  kind: string;
  scoring: Record<string, unknown>;
  endpoints: unknown[];
  resourceNames: readonly string[];
  outputNames: readonly string[];
}): string[] {
  const crossRefIssues: string[] = [];
  appendScoringCrossRefIssues(crossRefIssues, args.kind, args.scoring, args.outputNames);
  appendEndpointCrossRefIssues(crossRefIssues, args.endpoints, args.outputNames);
  if (!args.resourceNames.includes("ParticipantViewerRole")) {
    crossRefIssues.push("ParticipantViewerRole resource not declared (= ADR-002 Phase 2.1)");
  }
  if (!args.outputNames.includes("ParticipantViewerRoleArn")) {
    crossRefIssues.push("ParticipantViewerRoleArn output not declared (= sso.ts が読む)");
  }
  return crossRefIssues;
}

function appendScoringCrossRefIssues(
  issues: string[],
  kind: string,
  scoring: Record<string, unknown>,
  outputNames: readonly string[],
): void {
  if (kind === "flag") {
    const k = String(scoring.flagOutputKey ?? "");
    if (k && !outputNames.includes(k)) issues.push(`flagOutputKey="${k}" not in Outputs`);
  }
  if (kind === "multi-flag") {
    appendMultiFlagCrossRefIssues(issues, scoring, outputNames);
  }
  if (kind === "attack-detection") {
    const k = String(scoring.statsOutputKey ?? "");
    if (k && !outputNames.includes(k)) issues.push(`statsOutputKey="${k}" not in Outputs`);
  }
}

/**
 * multi-flag (#1796): flags[] の各 flagOutputKey が Outputs に居るかを個別検査する。
 */
function appendMultiFlagCrossRefIssues(
  issues: string[],
  scoring: Record<string, unknown>,
  outputNames: readonly string[],
): void {
  const flags = Array.isArray(scoring.flags) ? scoring.flags : [];
  for (const f of flags as Array<Record<string, unknown>>) {
    const k = String(f.flagOutputKey ?? "");
    if (k && !outputNames.includes(k)) {
      issues.push(`flags[id=${String(f.id)}].flagOutputKey="${k}" not in Outputs`);
    }
  }
}

function appendEndpointCrossRefIssues(
  issues: string[],
  endpoints: unknown[],
  outputNames: readonly string[],
): void {
  for (const ep of endpoints as Array<Record<string, unknown>>) {
    const def = ep.default as Record<string, unknown> | undefined;
    if (
      def?.from === "cfn-output" &&
      typeof def.key === "string" &&
      !outputNames.includes(def.key)
    ) {
      issues.push(`endpoints[slot=${String(ep.slot)}].default.key="${def.key}" not in Outputs`);
    }
  }
}
