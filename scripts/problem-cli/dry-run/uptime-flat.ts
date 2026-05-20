import { sumHintPenalties } from "../hints";
import { pushPatternLengthNote } from "../report";
import type { DryRunKindInput, DryRunResult } from "./types";

export function runUptimeFlatDryRun(input: DryRunKindInput): DryRunResult {
  const { args, scoring, lines, kind } = input;
  const pointsPerSuccess = Number(scoring.pointsPerSuccess ?? 0);
  const failurePenalty = Number(scoring.failurePenalty ?? 0);
  const endpointsInScoring = Array.isArray(scoring.endpoints) ? scoring.endpoints : [];
  const endpointCount = endpointsInScoring.length;
  if (endpointCount === 0) {
    return {
      ok: false,
      summary: "uptime-flat metadata has no scoring.endpoints; cannot dry-run",
      lines,
    };
  }

  const cycles = args.cycles ?? 10;
  const pattern = args.pattern ?? "s".repeat(cycles);
  pushPatternLengthNote({
    lines,
    patternLength: pattern.length,
    cycles,
    message: `note: pattern length (${pattern.length}) !== cycles (${cycles}). Pattern を cycles に揃えるか、 cycles を pattern.length に合わせてください。`,
  });

  let score = 0;
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < cycles; i += 1) {
    const sym = pattern[i % pattern.length];
    if (sym === "s") {
      score += pointsPerSuccess * endpointCount;
      okCount += 1;
    } else {
      score -= failurePenalty * endpointCount;
      failCount += 1;
    }
  }

  const hintsRevealed = args.revealHints ?? 0;
  const hints = Array.isArray(scoring.hints) ? scoring.hints : [];
  const penaltyTotal = sumHintPenalties(hints, hintsRevealed);
  const earned = Math.max(0, score - penaltyTotal);

  lines.push(`kind:             ${kind}`);
  lines.push(`endpoints:        ${endpointCount}`);
  lines.push(`pointsPerSuccess: ${pointsPerSuccess}`);
  lines.push(`failurePenalty:   ${failurePenalty}`);
  lines.push(`cycles:           ${cycles}`);
  lines.push(`pattern:          ${pattern} (s=success, f=fail)`);
  lines.push(`okCycles:         ${okCount}`);
  lines.push(`failCycles:       ${failCount}`);
  lines.push(`subtotal:         ${score} pt`);
  lines.push(`hintsRevealed:    ${hintsRevealed} (penalty -${penaltyTotal})`);
  lines.push(`earned:           ${earned} pt`);

  return {
    ok: true,
    summary: `${kind} dry-run: ${cycles} cycles → earned=${earned}`,
    lines,
  };
}
