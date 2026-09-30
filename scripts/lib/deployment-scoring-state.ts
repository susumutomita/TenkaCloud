/** Pure scoring state shared by Lambda and the AWS-free local Simulator. */
export interface ActiveDisruptionEffect {
  readonly disruptionId: string;
  readonly points: number;
  readonly expiresAtMs: number;
}

export interface DeploymentScoringState {
  readonly bonusAwarded?: Readonly<Record<string, boolean>>;
  readonly attackCount?: number;
  readonly firedDisruptions?: readonly string[];
  readonly activeEffects?: readonly ActiveDisruptionEffect[];
}
