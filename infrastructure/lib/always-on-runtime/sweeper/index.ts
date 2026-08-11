import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { createCfnStacksClient } from "./cfn-stacks-client.js";
import { createGitHubIssueFiler } from "./github-issue-filer.js";
import { type SweepSummary, sweepExpiredRuntimes } from "./sweep.js";

/**
 * Issue #2293 — the composition root that wires the real CloudFormation +
 * GitHub edges to the pure sweeper core ({@link ./sweep.ts}) and runs one sweep. Run manually
 * (`bun run infrastructure/lib/always-on-runtime/sweeper/index.ts` with AWS credentials +
 * `GITHUB_REPOSITORY` / `GITHUB_TOKEN`); the nightly GitHub Actions schedule was removed because
 * its AWS OIDC environment was never provisioned and the workflow only produced failure noise —
 * re-add a scheduled wrapper at Always-On GA (#2294) once `ALWAYS_ON_DEPLOY_ROLE_ARN` exists.
 *
 * The env-reading and log-formatting are extracted into pure, fully-testable helpers; the thin
 * real-client composition in {@link runSweeper} is what stays uncovered offline (it needs AWS).
 * Logging is stack-name / count only — never account IDs.
 */

/** Required env names read by the sweeper (surfaced for tests + docs). */
export const ENV_AWS_REGION = "AWS_REGION";
export const ENV_GITHUB_REPOSITORY = "GITHUB_REPOSITORY";
export const ENV_GITHUB_TOKEN = "GITHUB_TOKEN";

export interface SweeperConfig {
  readonly region: string;
  readonly repo: string;
  readonly token: string;
}

/** Read a required env var, failing loud (empty / unset) rather than defaulting silently. */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is required to run the always-on-runtime cleanup sweeper. ` +
        "Set AWS_REGION (plus AWS credentials) and GITHUB_REPOSITORY / GITHUB_TOKEN " +
        "in the invoking shell.",
    );
  }
  return value;
}

/** Resolve the required sweeper config from an env bag (pure — no AWS/GitHub calls). */
export function resolveSweeperConfig(env: NodeJS.ProcessEnv): SweeperConfig {
  return {
    region: requireEnv(env, ENV_AWS_REGION),
    repo: requireEnv(env, ENV_GITHUB_REPOSITORY),
    token: requireEnv(env, ENV_GITHUB_TOKEN),
  };
}

/** Render the one-line sweep summary. Counts only — no account IDs ever appear here. */
export function formatSummaryLog(summary: SweepSummary): string {
  return (
    "always-on-runtime cleanup sweep: " +
    `scanned=${summary.scanned} expired=${summary.expired} ` +
    `deleted=${summary.deleted} failed=${summary.failed}`
  );
}

export interface RunSweeperOptions {
  /** Env bag to resolve config from (production: `process.env`). */
  readonly env: NodeJS.ProcessEnv;
  /** Sweep reference time (defaults to `new Date()`). */
  readonly now?: Date;
  /** Line sink (defaults to `console.log`). */
  readonly log?: (message: string) => void;
}

/** Wire the real edges from env and run one sweep, logging the summary. */
export async function runSweeper(options: RunSweeperOptions): Promise<SweepSummary> {
  const config = resolveSweeperConfig(options.env);
  const now = options.now ?? new Date();
  const log = options.log ?? ((message: string) => console.log(message));

  const cfn = new CloudFormationClient({ region: config.region });
  const stacks = createCfnStacksClient(cfn, new LambdaClient({ region: config.region }));
  const issues = createGitHubIssueFiler({ repo: config.repo, token: config.token });

  const summary = await sweepExpiredRuntimes({ stacks, issues }, now);
  log(formatSummaryLog(summary));
  return summary;
}

// thin entrypoint shim: run only when invoked directly (`bun run .../sweeper/index.ts`), not when
// imported by vitest. Set a non-zero exit code on failure so the invoking shell fails loud.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runSweeper({ env: process.env }).catch((err: unknown) => {
    console.error(
      "always-on-runtime cleanup sweep failed:",
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  });
}
