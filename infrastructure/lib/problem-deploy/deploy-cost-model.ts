/**
 * Issue #2291: the Step Functions cost model for the Lambda deploy path, and the poll
 * interval it is tuned against.
 *
 * The migration off CodeBuild replaced a 5-15 min `.sync` build (billed as CodeBuild compute — the
 * design note pegs a 750-deploy wave at ≈$37.50 of "sleeping while CloudFormation settles") with a
 * Lambda that fires CreateStack and returns, plus a Step Functions Wait + DescribeStacks poll loop.
 * SFN Standard bills per **state transition** ($0.025 / 1,000), so the wave cost is now driven by how
 * many times the poll loop iterates, i.e. by the poll interval.
 *
 * Per deploy the Lambda-path state machine runs:
 *   - {@link DEPLOY_FIXED_TRANSITIONS} fixed states: MarkInProgress + InvokeCfnDeploy + MarkSucceeded
 *   - {@link DEPLOY_POLL_CYCLE_TRANSITIONS} per poll cycle: WaitBeforePoll + DescribeStack + RoutePollStatus
 *
 * so `transitions(deploy) = FIXED + CYCLE * ceil(deploySeconds / pollIntervalSeconds)`.
 *
 * At {@link DEPLOY_STATUS_POLL_INTERVAL_SECONDS} = 30s a typical 5-min deploy is ≈33 transitions, so a
 * 750-deploy wave is ≈24.75k transitions ≈ $0.62 — validating the ≈$0.7/wave estimate. A
 * 15s interval doubled the poll count (≈$1.18/wave for the same wave) and bought no meaningful UX on a
 * multi-minute operation, so it overshot the target. The interval is a single shared constant so the
 * create and delete poll loops stay in sync and the cost model stays valid.
 */

/** SFN Standard price per 1,000 state transitions (us-east-1 / ap-northeast-1, 2026). */
export const SFN_STANDARD_USD_PER_1K_TRANSITIONS = 0.025;

/** Fixed (non-poll) state transitions per deploy: MarkInProgress + InvokeCfnDeploy + MarkSucceeded. */
export const DEPLOY_FIXED_TRANSITIONS = 3;

/** State transitions per poll cycle: WaitBeforePoll + DescribeStack + RoutePollStatus. */
export const DEPLOY_POLL_CYCLE_TRANSITIONS = 3;

/**
 * Interval between DescribeStacks polls in the Lambda deploy path (create + delete). 30s keeps a
 * 750-deploy wave at ≈$0.62 (see module header) while adding at most 30s of completion-detection
 * latency to a 5-15 min operation.
 */
export const DEPLOY_STATUS_POLL_INTERVAL_SECONDS = 30;

/** Hard timeout shared by DeployCreate's Standard Workflow definition. */
export const DEPLOY_STATE_MACHINE_TIMEOUT_MINUTES = 60;

/**
 * Extra time after the workflow timeout before the scheduled reconciler declares a non-terminal
 * create row abandoned. This prevents a tick at the exact timeout boundary from racing the final
 * workflow write.
 */
export const DEPLOY_STUCK_RECOVERY_GRACE_MINUTES = 5;

/**
 * PENDING/IN_PROGRESS age at which the independent reconciler may conditionally mark a deploy
 * FAILED. The threshold stays derived from the workflow timeout so the two recovery contracts
 * cannot drift independently.
 */
export const DEPLOY_STUCK_RECOVERY_THRESHOLD_MS =
  (DEPLOY_STATE_MACHINE_TIMEOUT_MINUTES + DEPLOY_STUCK_RECOVERY_GRACE_MINUTES) * 60 * 1_000;

/**
 * State transitions one Lambda-path deploy execution costs, given how long CloudFormation takes to
 * settle and the poll interval. `deploySeconds` <= 0 means the stack was already terminal on the
 * first poll (one cycle). Both inputs must be finite; the poll interval must be positive.
 */
export function deployTransitionCount(deploySeconds: number, pollIntervalSeconds: number): number {
  if (!Number.isFinite(deploySeconds) || !Number.isFinite(pollIntervalSeconds)) {
    throw new Error("deploySeconds and pollIntervalSeconds must be finite numbers");
  }
  if (pollIntervalSeconds <= 0) {
    throw new Error("pollIntervalSeconds must be greater than zero");
  }
  const cycles = Math.max(1, Math.ceil(deploySeconds / pollIntervalSeconds));
  return DEPLOY_FIXED_TRANSITIONS + DEPLOY_POLL_CYCLE_TRANSITIONS * cycles;
}

export interface DeployWaveCostInput {
  /** Number of problem deploys in one bulk wave (design target: 750). */
  readonly deploys: number;
  /** How long each stack takes to reach a terminal status, in seconds. */
  readonly deploySeconds: number;
  /** Poll interval; defaults to {@link DEPLOY_STATUS_POLL_INTERVAL_SECONDS}. */
  readonly pollIntervalSeconds?: number;
}

/**
 * Estimated SFN Standard cost (USD) of one bulk deploy wave. Ignores the SFN free tier (4,000
 * transitions/month) on purpose — the estimate is the steady-state per-wave marginal cost.
 */
export function estimateDeployWaveCostUsd(input: DeployWaveCostInput): number {
  if (!Number.isFinite(input.deploys) || input.deploys < 0) {
    throw new Error("deploys must be a non-negative finite number");
  }
  const interval = input.pollIntervalSeconds ?? DEPLOY_STATUS_POLL_INTERVAL_SECONDS;
  const transitions = input.deploys * deployTransitionCount(input.deploySeconds, interval);
  return (transitions * SFN_STANDARD_USD_PER_1K_TRANSITIONS) / 1000;
}
