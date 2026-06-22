import { type Probe, type ProbeContext, type ProbeOutcome, runProbe } from "./probe.js";

/**
 * Issue #1973: 1 ステージ = 複数 probe。 全 probe pass でそのステージ clear。
 * probe は参加者エンドポイントへ順番に投げる (= 一斉に叩かず相手に優しく)。
 */
export interface StageDefinition {
  readonly id: string;
  readonly title: string;
  readonly probes: readonly Probe[];
}

export interface StageResult {
  readonly stageId: string;
  readonly title: string;
  readonly passed: boolean;
  readonly probes: readonly ProbeOutcome[];
}

export async function evaluateStage(
  baseUrl: URL,
  stage: StageDefinition,
  ctx: ProbeContext,
): Promise<StageResult> {
  const probes: ProbeOutcome[] = [];
  for (const probe of stage.probes) {
    probes.push(await runProbe(baseUrl, probe, ctx));
  }
  return {
    stageId: stage.id,
    title: stage.title,
    passed: probes.every((o) => o.passed),
    probes,
  };
}
