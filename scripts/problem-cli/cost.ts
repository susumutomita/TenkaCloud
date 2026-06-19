import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  analyzeProblemCost,
  formatHours,
  formatUsd,
  type ProblemCostEstimate,
} from "../lib/problem-cost";
import { findProblemDir, getTemplateName, readProblemMetadata } from "./problem-loader";

export interface CostArgs {
  readonly problemId: string;
}

export interface CostResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly lines: readonly string[];
  readonly estimate?: ProblemCostEstimate;
}

export function runCost(args: CostArgs): CostResult {
  const dir = findProblemDir(args.problemId);
  if (!dir) {
    return { ok: false, summary: `problemId not found: ${args.problemId}`, lines: [] };
  }

  const meta = readProblemMetadata(dir);
  const templateName = getTemplateName(meta);
  const templatePath = join(dir, templateName);
  if (!existsSync(templatePath)) {
    return {
      ok: false,
      summary: `template not found for ${args.problemId}: ${templateName}`,
      lines: [],
    };
  }

  const estimate = analyzeProblemCost(
    readFileSync(templatePath, "utf8"),
    typeof meta.estimatedDuration === "string" ? meta.estimatedDuration : undefined,
  );
  return {
    ok: true,
    summary: `${args.problemId}: ${formatUsd(estimate.totalHourlyUsd)}/hour`,
    lines: renderCostReport(args.problemId, templateName, meta.estimatedDuration, estimate),
    estimate,
  };
}

function renderCostReport(
  problemId: string,
  templateName: string,
  estimatedDuration: unknown,
  estimate: ProblemCostEstimate,
): readonly string[] {
  return [
    `=== Cost estimate ${problemId} ===`,
    `template: ${templateName}`,
    `estimatedDuration: ${typeof estimatedDuration === "string" ? estimatedDuration : "(none)"}`,
    `parsedDuration: ${formatHours(estimate.sessionHours)}`,
    "",
    ...renderResources(estimate),
    "",
    ...renderTotals(estimate),
    ...renderAlwaysOnWarnings(estimate),
    ...renderManualReview(estimate),
  ];
}

function renderResources(estimate: ProblemCostEstimate): string[] {
  const lines = ["Resources:"];
  if (estimate.resources.length === 0) {
    lines.push("  (no CloudFormation Resources found)");
    return lines;
  }

  for (const resource of estimate.resources) {
    lines.push(
      `  - ${resource.logicalId}: ${resource.resourceType} hourly=${formatUsd(resource.roughHourlyUsd)} risk=${resource.riskLevel} alwaysOn=${resource.alwaysOn ? "yes" : "no"}`,
    );
    for (const note of resource.notes) lines.push(`      ${note}`);
  }
  return lines;
}

function renderTotals(estimate: ProblemCostEstimate): string[] {
  return [
    "Totals:",
    `  perHour: ${formatUsd(estimate.totalHourlyUsd)}`,
    `  perTypicalSession: ${formatUsd(estimate.perSessionUsd)}`,
    `  perDayIfLeftRunning: ${formatUsd(estimate.perDayIfLeftRunningUsd)}`,
  ];
}

function renderAlwaysOnWarnings(estimate: ProblemCostEstimate): string[] {
  if (estimate.alwaysOnWarnings.length === 0) return [];
  const lines = ["", "Always-on warnings:"];
  for (const resource of estimate.alwaysOnWarnings) {
    lines.push(
      `  - ${resource.logicalId}: ${resource.resourceType} can bill while left running (${formatUsd(resource.roughHourlyUsd)}/hour).`,
    );
  }
  return lines;
}

function renderManualReview(estimate: ProblemCostEstimate): string[] {
  if (estimate.unpricedResourceTypes.length === 0) return [];
  const lines = ["", "Manual review:"];
  for (const resourceType of estimate.unpricedResourceTypes) {
    lines.push(`  - ${resourceType}: no offline heuristic yet; verify whether it can bill.`);
  }
  return lines;
}
