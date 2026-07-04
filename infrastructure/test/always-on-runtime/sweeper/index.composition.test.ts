import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers the two real-edge composition seams of the sweeper entrypoint that can only be exercised
 * with the AWS/GitHub adapters stubbed out:
 *   - {@link runSweeper} — wires a real `CloudFormationClient` + adapters and runs one sweep.
 *   - the `import.meta`/`process.argv` entrypoint guard — runs the sweep only when invoked directly.
 *
 * The three sibling adapter modules ({@link cfn-stacks-client}, {@link github-issue-filer},
 * {@link sweep}) and the AWS SDK client are mocked, so the sweep never touches the network.
 */

const { sweepMock, createCfnStacksClientMock, createGitHubIssueFilerMock } = vi.hoisted(() => ({
  sweepMock: vi.fn(),
  createCfnStacksClientMock: vi.fn(() => ({
    listManagedStacks: vi.fn(async () => []),
    deleteStack: vi.fn(async () => {}),
  })),
  createGitHubIssueFilerMock: vi.fn(() => ({ openCleanupFailureIssue: vi.fn(async () => {}) })),
}));

vi.mock("@aws-sdk/client-cloudformation", () => ({ CloudFormationClient: vi.fn() }));
vi.mock("../../../lib/always-on-runtime/sweeper/cfn-stacks-client", () => ({
  createCfnStacksClient: createCfnStacksClientMock,
}));
vi.mock("../../../lib/always-on-runtime/sweeper/github-issue-filer", () => ({
  createGitHubIssueFiler: createGitHubIssueFilerMock,
}));
vi.mock("../../../lib/always-on-runtime/sweeper/sweep", () => ({
  sweepExpiredRuntimes: sweepMock,
}));

import { runSweeper } from "../../../lib/always-on-runtime/sweeper/index";

/** Absolute path of the module under test — what its `import.meta.url` resolves to at runtime. */
const INDEX_PATH = fileURLToPath(
  new URL("../../../lib/always-on-runtime/sweeper/index.ts", import.meta.url),
);

const DIRECT_ENV_KEYS = ["AWS_REGION", "GITHUB_REPOSITORY", "GITHUB_TOKEN"] as const;

const SWEEPER_ENV: NodeJS.ProcessEnv = {
  AWS_REGION: "ap-northeast-1",
  GITHUB_REPOSITORY: "susumutomita/TenkaCloud",
  GITHUB_TOKEN: "gh-token",
};

let savedArgv1: string;
let savedExitCode: typeof process.exitCode;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedArgv1 = process.argv[1];
  savedExitCode = process.exitCode;
  savedEnv = Object.fromEntries(DIRECT_ENV_KEYS.map((key) => [key, process.env[key]]));
  sweepMock.mockReset();
  createCfnStacksClientMock.mockClear();
  createGitHubIssueFilerMock.mockClear();
});

afterEach(() => {
  process.argv[1] = savedArgv1;
  process.exitCode = savedExitCode;
  for (const key of DIRECT_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Point `process.env` at the required sweeper vars for the direct-invocation guard tests. */
function setSweeperEnv(): void {
  for (const key of DIRECT_ENV_KEYS) {
    process.env[key] = SWEEPER_ENV[key];
  }
}

describe("runSweeper", () => {
  it("should wire the real edges, run one sweep, and log the summary", async () => {
    const summary = { scanned: 3, expired: 2, deleted: 2, failed: 0 };
    sweepMock.mockResolvedValueOnce(summary);
    const log = vi.fn();
    const now = new Date("2026-07-04T00:00:00.000Z");

    const result = await runSweeper({ env: SWEEPER_ENV, now, log });

    expect(result).toEqual(summary);
    expect(createCfnStacksClientMock).toHaveBeenCalledTimes(1);
    expect(createGitHubIssueFilerMock).toHaveBeenCalledWith({
      repo: "susumutomita/TenkaCloud",
      token: "gh-token",
    });
    expect(sweepMock).toHaveBeenCalledTimes(1);
    const [deps, whenArg] = sweepMock.mock.calls[0];
    expect(whenArg).toBe(now);
    expect(deps).toHaveProperty("stacks");
    expect(deps).toHaveProperty("issues");
    expect(log).toHaveBeenCalledWith(
      "always-on-runtime cleanup sweep: scanned=3 expired=2 deleted=2 failed=0",
    );
  });

  it("should default now to the current time and log to console.log", async () => {
    const summary = { scanned: 0, expired: 0, deleted: 0, failed: 0 };
    sweepMock.mockResolvedValueOnce(summary);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await runSweeper({ env: SWEEPER_ENV });

    expect(result).toEqual(summary);
    expect(sweepMock).toHaveBeenCalledTimes(1);
    expect(sweepMock.mock.calls[0][1]).toBeInstanceOf(Date);
    expect(consoleSpy).toHaveBeenCalledWith(
      "always-on-runtime cleanup sweep: scanned=0 expired=0 deleted=0 failed=0",
    );
  });
});

describe("sweeper direct-invocation guard", () => {
  it("should run the sweep when the module is invoked as the entrypoint", async () => {
    sweepMock.mockResolvedValueOnce({ scanned: 0, expired: 0, deleted: 0, failed: 0 });
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv[1] = INDEX_PATH;
    setSweeperEnv();

    vi.resetModules();
    await import("../../../lib/always-on-runtime/sweeper/index");

    await vi.waitFor(() => expect(sweepMock).toHaveBeenCalledTimes(1));
    expect(createCfnStacksClientMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(1);
  });

  it("should set exit code 1 and log the message when a direct sweep rejects with an Error", async () => {
    sweepMock.mockRejectedValueOnce(new Error("cfn exploded"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv[1] = INDEX_PATH;
    setSweeperEnv();

    vi.resetModules();
    await import("../../../lib/always-on-runtime/sweeper/index");

    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(errorSpy).toHaveBeenCalledWith(
      "always-on-runtime cleanup sweep failed:",
      "cfn exploded",
    );
  });

  it("should stringify a non-Error rejection when a direct sweep fails", async () => {
    sweepMock.mockRejectedValueOnce("string boom");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv[1] = INDEX_PATH;
    setSweeperEnv();

    vi.resetModules();
    await import("../../../lib/always-on-runtime/sweeper/index");

    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(errorSpy).toHaveBeenCalledWith("always-on-runtime cleanup sweep failed:", "string boom");
  });

  it("should not run the sweep when argv[1] is absent", async () => {
    // A falsy argv[1] exercises the `process.argv[1] ? ... : ""` fallback and the non-match guard.
    process.argv[1] = "";
    setSweeperEnv();

    vi.resetModules();
    await import("../../../lib/always-on-runtime/sweeper/index");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sweepMock).not.toHaveBeenCalled();
  });
});
