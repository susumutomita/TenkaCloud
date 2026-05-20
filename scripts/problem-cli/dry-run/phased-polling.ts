import { pushPatternLengthNote } from "../report";
import type { DryRunKindInput, DryRunResult } from "./types";

export function runPhasedPollingDryRun(input: DryRunKindInput): DryRunResult {
  const { args, meta, scoring, lines } = input;
  const intervalMinutes = Number(scoring.intervalMinutes ?? 1);
  const platformRules = (scoring.platformRules ?? {}) as Record<string, Record<string, unknown>>;
  const cycles = args.cycles ?? 10;
  const pattern = args.pattern ?? "e".repeat(cycles); // default 全 cycle EC2 と仮定
  const phases = Array.isArray(meta.phases) ? meta.phases : [];
  pushPatternLengthNote({
    lines,
    patternLength: pattern.length,
    cycles,
    message: `note: pattern length (${pattern.length}) !== cycles (${cycles})。 1 char = 1 cycle に揃えてください。`,
  });
  const platformChar: Record<string, string> = {
    e: "ec2",
    l: "lambda",
    c: "ecs",
    a: "apprunner",
  };
  let score = 0;
  const cycleLog: string[] = [];
  for (let i = 0; i < cycles; i += 1) {
    const cycle = buildCycleResult({
      cycleIndex: i,
      cycles,
      intervalMinutes,
      pattern,
      phases,
      platformChar,
      platformRules,
    });
    const { earnedThis } = cycle;
    score += earnedThis;
    cycleLog.push(cycle.line);
  }
  lines.push(`kind:           phased-polling`);
  lines.push(`intervalMin:    ${intervalMinutes}`);
  lines.push(`platforms:      ${Object.keys(platformRules).join(", ")}`);
  lines.push(`phases:         ${phases.length}`);
  lines.push(`pattern:        ${pattern} (e=ec2, l=lambda, c=ecs, a=apprunner)`);
  lines.push(...cycleLog);
  lines.push(`earned:         ${score} pt`);
  return {
    ok: true,
    summary: `phased-polling dry-run: ${cycles} cycles → earned=${score}`,
    lines,
  };
}

interface PhasedCycleInput {
  readonly cycleIndex: number;
  readonly cycles: number;
  readonly intervalMinutes: number;
  readonly pattern: string;
  readonly phases: unknown[];
  readonly platformChar: Record<string, string>;
  readonly platformRules: Record<string, Record<string, unknown>>;
}

function buildCycleResult(input: PhasedCycleInput): { earnedThis: number; line: string } {
  const platform = resolvePlatform(input.pattern, input.cycleIndex, input.platformChar);
  const minutesElapsed = (input.cycleIndex + 1) * input.intervalMinutes;
  const degradedPlatforms = collectDegradedPlatforms(input.phases, minutesElapsed);
  const earnedThis = scorePlatform(platform, degradedPlatforms, input.platformRules);
  const degradedLabel = degradedPlatforms.has(platform) ? "(DEGRADED)" : "";
  return {
    earnedThis,
    line: `  cycle ${input.cycleIndex + 1}/${input.cycles} (minute ${minutesElapsed}) platform=${platform} ${degradedLabel} → +${earnedThis}`,
  };
}

function resolvePlatform(
  pattern: string,
  cycleIndex: number,
  platformChar: Record<string, string>,
): string {
  const sym = pattern[cycleIndex % pattern.length] ?? "e";
  return platformChar[sym] ?? "ec2";
}

function collectDegradedPlatforms(phases: unknown[], minutesElapsed: number): Set<string> {
  const degradedPlatforms = new Set<string>();
  for (const ph of phases as Array<Record<string, unknown>>) {
    const after = Number(ph.afterMinutes ?? 0);
    if (minutesElapsed < after) continue;
    const effect = ph.effect as Record<string, unknown> | undefined;
    const list = effect?.switchPlatformToDegraded;
    if (Array.isArray(list)) for (const p of list) degradedPlatforms.add(String(p));
  }
  return degradedPlatforms;
}

function scorePlatform(
  platform: string,
  degradedPlatforms: Set<string>,
  platformRules: Record<string, Record<string, unknown>>,
): number {
  const rule = platformRules[platform] ?? {};
  const pointsFull = Number(rule.points ?? 0);
  const pointsDegraded = Number(rule.degradedPoints ?? 0);
  return degradedPlatforms.has(platform) ? pointsDegraded : pointsFull;
}
