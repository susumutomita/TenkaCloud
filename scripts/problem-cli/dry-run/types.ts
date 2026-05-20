export interface DryRunArgs {
  problemId: string;
  submitted?: string;
  revealHints?: number;
  cycles?: number;
  pattern?: string;
}

export interface DryRunResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly lines: readonly string[];
}

export interface DryRunKindInput {
  readonly args: DryRunArgs;
  readonly dir: string;
  readonly meta: Record<string, unknown>;
  readonly scoring: Record<string, unknown>;
  readonly lines: string[];
  readonly kind: string;
}
