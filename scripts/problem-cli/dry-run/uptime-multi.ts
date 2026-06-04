import { sumHintPenalties } from "../hints";
import { pushPatternLengthNote } from "../report";
import type { DryRunKindInput, DryRunResult } from "./types";

export function runUptimeMultiDryRun(input: DryRunKindInput): DryRunResult {
  const { args, scoring, lines } = input;
  const pointsAllOk = Number(scoring.pointsAllOk ?? 0);
  const failurePenalty = Number(scoring.failurePenalty ?? 0);
  const probedSlots = Array.isArray(scoring.probedSlots) ? scoring.probedSlots : [];
  const slotCount = probedSlots.length;
  if (slotCount === 0) {
    return {
      ok: false,
      summary: "uptime-multi metadata has no scoring.probedSlots; cannot dry-run",
      lines,
    };
  }
  const cycles = args.cycles ?? 10;
  const pattern = args.pattern ?? "s".repeat(cycles);
  pushPatternLengthNote({
    lines,
    patternLength: pattern.length,
    cycles,
    message: `note: pattern length (${pattern.length}) !== cycles (${cycles})。 pattern を cycles に揃えてください。`,
  });
  let score = 0;
  let allOkCycles = 0;
  let failCycles = 0;
  for (let i = 0; i < cycles; i += 1) {
    const sym = pattern[i % pattern.length];
    if (sym === "s") {
      score += pointsAllOk;
      allOkCycles += 1;
    } else {
      // failurePenalty は加算デルタ (負値で減点、 runUptimeMultiKind と同契約)。 `-=` だと符号反転
      // して負値が加点になる latent bug だった (= failurePenalty=0 の問題でだけ露見しなかった)。
      score += failurePenalty;
      failCycles += 1;
    }
  }
  const hintsRevealed = args.revealHints ?? 0;
  const hintsList = Array.isArray(scoring.hints) ? scoring.hints : [];
  const hintPenalty = sumHintPenalties(hintsList, hintsRevealed);
  const earned = Math.max(0, score - hintPenalty);
  lines.push(`kind:             uptime-multi`);
  lines.push(`probedSlots:      ${slotCount} (= 全 slot OK で加点)`);
  lines.push(`pointsAllOk:      ${pointsAllOk}`);
  lines.push(`failurePenalty:   ${failurePenalty}`);
  lines.push(`cycles:           ${cycles}`);
  lines.push(`pattern:          ${pattern} (s=全 slot OK, f=any fail)`);
  lines.push(`allOkCycles:      ${allOkCycles}`);
  lines.push(`failCycles:       ${failCycles}`);
  lines.push(`subtotal:         ${score} pt`);
  lines.push(`hintsRevealed:    ${hintsRevealed} (penalty -${hintPenalty})`);
  lines.push(`earned:           ${earned} pt`);
  return {
    ok: true,
    summary: `uptime-multi dry-run: ${cycles} cycles → earned=${earned}`,
    lines,
  };
}
