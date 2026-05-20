import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sumHintPenalties } from "../hints";
import { getTemplateName } from "../problem-loader";
import { extractFlagFromTemplate } from "../template-inspector";
import type { DryRunKindInput, DryRunResult } from "./types";

export function runFlagDryRun(input: DryRunKindInput): DryRunResult {
  const { args, dir, meta, scoring, lines } = input;
  const expectedKey = scoring.flagOutputKey;
  const cfnTemplate = getTemplateName(meta);
  const templatePath = join(dir, cfnTemplate);
  if (!existsSync(templatePath)) {
    return { ok: false, summary: `template ${cfnTemplate} not found`, lines };
  }
  const yaml = readFileSync(templatePath, "utf8");
  const expectedFlag = extractFlagFromTemplate(yaml, String(expectedKey));
  const points = Number(scoring.points ?? 0);
  const submitted = args.submitted ?? "";
  const correct = expectedFlag !== null && submitted === expectedFlag;
  const hintsRevealed = args.revealHints ?? 0;
  const hints = Array.isArray(scoring.hints) ? scoring.hints : [];
  const penaltyTotal = sumHintPenalties(hints, hintsRevealed);
  const earned = correct ? Math.max(0, points - penaltyTotal) : 0;

  lines.push(`kind:           flag`);
  lines.push(`flagOutputKey:  ${String(expectedKey)}`);
  lines.push(
    `expectedFlag:   ${expectedFlag === null ? "(could not extract from template — set Value directly to test)" : expectedFlag}`,
  );
  lines.push(`submitted:      ${submitted || "(empty)"}`);
  lines.push(`correct:        ${correct ? "yes" : "no"}`);
  lines.push(`baseline:       ${points} pt`);
  lines.push(`hintsRevealed:  ${hintsRevealed} (penalty -${penaltyTotal})`);
  lines.push(`earned:         ${earned} pt`);

  return {
    ok: true,
    summary: `flag dry-run: ${correct ? "正解" : "不正解"} → earned=${earned}`,
    lines,
  };
}
