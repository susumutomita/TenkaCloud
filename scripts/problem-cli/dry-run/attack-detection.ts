import { pushPatternLengthNote } from "../report";
import type { DryRunKindInput, DryRunResult } from "./types";

export function runAttackDetectionDryRun(input: DryRunKindInput): DryRunResult {
  const { args, scoring, lines } = input;
  const pointsPerAttack = Number(scoring.pointsPerAttack ?? 0);
  const cycles = args.cycles ?? 10;
  const pattern = args.pattern ?? "1".repeat(cycles); // default 各 cycle で +1 attack
  pushPatternLengthNote({
    lines,
    patternLength: pattern.length,
    cycles,
    message: `note: pattern length (${pattern.length}) !== cycles (${cycles})。 1 char (0-9) = その cycle で何件 +increment したかを表す。`,
  });
  let totalDelta = 0;
  let score = 0;
  const cycleLog: string[] = [];
  for (let i = 0; i < cycles; i += 1) {
    const ch = pattern[i % pattern.length] ?? "0";
    const delta = Number.parseInt(ch, 10);
    if (!Number.isFinite(delta) || delta < 0 || delta > 9) {
      cycleLog.push(`  cycle ${i + 1}: invalid char "${ch}" → skip`);
      continue;
    }
    totalDelta += delta;
    const earnedThis = delta * pointsPerAttack;
    score += earnedThis;
    cycleLog.push(`  cycle ${i + 1}: +${delta} detections (×${pointsPerAttack}) → +${earnedThis}`);
  }
  lines.push(`kind:           attack-detection`);
  lines.push(`pointsPerAttack: ${pointsPerAttack}`);
  lines.push(`pattern:        ${pattern} (1 char = increment per cycle, 0-9)`);
  lines.push(...cycleLog);
  lines.push(`totalDetections: ${totalDelta}`);
  lines.push(`earned:         ${score} pt`);
  return {
    ok: true,
    summary: `attack-detection dry-run: ${cycles} cycles, total ${totalDelta} detections → earned=${score}`,
    lines,
  };
}
