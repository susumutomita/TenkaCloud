#!/usr/bin/env bun
/**
 * Issue #2977: read-only Lite residual-resource scanner entrypoint.
 *
 * The ownership file is a pre-teardown, run-scoped exact-resource artifact. This command refuses a
 * missing/malformed/mismatched artifact instead of guessing ownership from prefixes. It only calls
 * STS and read/list/describe/tag APIs; it has no deletion or write path.
 *
 * Usage:
 *   bun run scripts/ops/scan-lite-residual-resources.ts \
 *     --run-id=<correlation-id> \
 *     --environment=development \
 *     --expected-account=<12-digit-id> \
 *     --expected-region=ap-northeast-1 \
 *     --release-version=1.2.3-rc.1 \
 *     --platform-commit=<40-character-git-commit> \
 *     --catalog-commit=<40-character-git-commit> \
 *     --simulator-image=<repository>@sha256:<64-character-digest> \
 *     --ownership-file=<pre-teardown-ownership.json>
 */

import { readFileSync } from "node:fs";
import {
  type LiteResidualOwnershipEvidence,
  type LiteResidualReleaseIdentity,
  liteResidualScanExitCode,
  parseLiteResidualOwnershipEvidence,
  parseLiteResidualReleaseIdentity,
  scanLiteResidualResources,
  serializeLiteResidualScanReport,
} from "../lib/lite-residual-scan";
import {
  type AwsCliRunner,
  createAwsCliLiteResidualInventory,
  runAwsCli,
} from "../lib/lite-residual-scan-aws";

const EXIT_USAGE = 64;
const VALUE_FLAGS = new Set([
  "--run-id",
  "--environment",
  "--expected-account",
  "--expected-region",
  "--release-version",
  "--platform-commit",
  "--catalog-commit",
  "--simulator-image",
  "--ownership-file",
]);

export interface LiteResidualScanCliArgs {
  readonly runId: string;
  readonly environment: string;
  readonly expectedAccountId: string;
  readonly expectedRegion: string;
  readonly releaseIdentity: LiteResidualReleaseIdentity;
  readonly ownershipFile: string;
}

function addExactValue(argument: string, values: Map<string, string>): void {
  const separator = argument.indexOf("=");
  const key = separator > 0 ? argument.slice(0, separator) : argument;
  if (!VALUE_FLAGS.has(key)) throw new Error(`unknown argument: ${argument}`);
  if (separator < 1) throw new Error(`${key} requires =<exact-value>`);
  if (values.has(key)) throw new Error(`${key} was provided more than once`);
  const value = argument.slice(separator + 1).trim();
  if (!value) throw new Error(`${key} requires a non-empty exact value`);
  values.set(key, value);
}

export function parseLiteResidualScanCliArgs(argv: readonly string[]): LiteResidualScanCliArgs {
  const values = new Map<string, string>();
  for (const argument of argv) addExactValue(argument, values);
  const runId = values.get("--run-id");
  const environment = values.get("--environment");
  const expectedAccountId = values.get("--expected-account");
  const expectedRegion = values.get("--expected-region");
  const releaseVersion = values.get("--release-version");
  const platformCommit = values.get("--platform-commit");
  const catalogCommit = values.get("--catalog-commit");
  const simulatorImage = values.get("--simulator-image");
  const ownershipFile = values.get("--ownership-file");
  if (
    !runId ||
    !environment ||
    !expectedAccountId ||
    !expectedRegion ||
    !releaseVersion ||
    !platformCommit ||
    !catalogCommit ||
    !simulatorImage ||
    !ownershipFile
  ) {
    throw new Error(
      "run, account, region, release identity, and ownership file arguments are required",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) {
    throw new Error("--run-id must be a non-empty correlation ID (max 128 characters)");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(environment)) {
    throw new Error("--environment must match the deployed Environment tag");
  }
  if (!/^\d{12}$/.test(expectedAccountId)) {
    throw new Error("--expected-account must be a 12 digit AWS account ID");
  }
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(expectedRegion)) {
    throw new Error("--expected-region must be an explicit AWS region");
  }
  const releaseIdentity = parseLiteResidualReleaseIdentity({
    releaseVersion,
    platformCommit,
    catalogCommit,
    simulatorImage,
  });
  return {
    runId,
    environment,
    expectedAccountId,
    expectedRegion,
    releaseIdentity,
    ownershipFile,
  };
}

export interface LiteResidualScanCliDeps {
  readonly runAws?: AwsCliRunner;
  readonly readTextFile?: (path: string) => string;
  readonly now?: () => Date;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export async function runLiteResidualScanCli(
  argv: readonly string[],
  deps: LiteResidualScanCliDeps = {},
): Promise<number> {
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  let args: LiteResidualScanCliArgs;
  try {
    args = parseLiteResidualScanCliArgs(argv);
  } catch (error) {
    stderr(
      `scan-lite-residual-resources: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_USAGE;
  }

  let ownershipValue: unknown;
  try {
    const readTextFile = deps.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
    ownershipValue = JSON.parse(readTextFile(args.ownershipFile));
  } catch (error) {
    stderr(
      `scan-lite-residual-resources: ownership file is unreadable or invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return EXIT_USAGE;
  }

  let ownership: LiteResidualOwnershipEvidence;
  try {
    ownership = parseLiteResidualOwnershipEvidence(ownershipValue);
  } catch (error) {
    stderr(
      `scan-lite-residual-resources: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_USAGE;
  }

  const report = await scanLiteResidualResources(
    {
      runId: args.runId,
      environment: args.environment,
      expectedAccountId: args.expectedAccountId,
      region: args.expectedRegion,
      releaseIdentity: args.releaseIdentity,
      ownership,
    },
    {
      inventory: createAwsCliLiteResidualInventory(deps.runAws ?? runAwsCli),
      ...(deps.now ? { now: deps.now } : {}),
    },
  );
  (deps.stdout ?? ((text: string) => process.stdout.write(text)))(
    serializeLiteResidualScanReport(report),
  );
  return liteResidualScanExitCode(report.decision);
}

if (import.meta.main) {
  runLiteResidualScanCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(
        `scan-lite-residual-resources: unexpected failure: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exit(2);
    });
}
