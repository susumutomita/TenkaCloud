import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it } from "vitest";
import { observeProcessIdentity } from "../../../scripts/local-play/process-identity";

/**
 * Issue #2527 Slice 0: characterization tests for the tenkacloud-local CLI's command
 * dispatch and session state transitions, ahead of the Slice 6 refactor that splits
 * scripts/tenkacloud-local.ts into command/use-case, session-state, process-adapter, and
 * presentation modules.
 *
 * The existing tenkacloud-local.test.ts covers only the exported pure helpers with injected
 * fakes; the command bodies (`main` dispatch, `status`, `evaluate`, `down`) were entirely
 * uncharacterized. This suite drives the real CLI as a subprocess (`bun run`, the same
 * pattern as participant-portal-runtime-config.test.ts) against a temp
 * `TENKACLOUD_LOCAL_DIR` and an in-test stub Participant API, pinning the observable
 * contract: exit codes, user-facing messages, request routing, and state-file cleanup.
 *
 * Out of scope here (they need Docker or would touch the real
 * apps/participant-portal/public/runtime-config.json): `up`, `serve`'s container lifecycle,
 * and `down` with a recorded session. Their orchestration gets seams in Slice 6 and the
 * characterization then extends to them.
 */

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "scripts", "tenkacloud-local.ts");
// Mirrors the unexported `paths().runtimeConfigPath` in scripts/tenkacloud-local.ts — the CLI
// offers no seam to inject it yet (that seam is Slice 6 work); this pin is the characterization.
const RUNTIME_CONFIG_PATH = join(
  REPO_ROOT,
  "apps",
  "participant-portal",
  "public",
  "runtime-config.json",
);
// Each test spawns a bun subprocess (cold transpile) and `status` against a dead API
// polls for 3s before failing — give every test the same generous ceiling.
const CLI_TIMEOUT_MS = 30_000;
const TEST_PARTICIPANT_TOKEN = "t".repeat(43);

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

const tempDirs: string[] = [];
const stubServers: Server[] = [];

function makeLocalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tenkacloud-local-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    stubServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/**
 * Run the CLI asynchronously — the stub Participant API lives on this test process's event
 * loop, so a blocking spawnSync would deadlock the CLI's fetch against it.
 */
function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const baseEnv = { ...process.env };
    // The CLI reads these; a developer's shell must not leak into the characterization.
    delete baseEnv.PROBLEM;
    delete baseEnv.TENKACLOUD_LOCAL_DIR;
    delete baseEnv.LOCAL_API_PORT;
    const child = spawn("bun", ["run", SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { ...baseEnv, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, status: code ?? 1 }));
  });
}

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** A stub Participant API answering every route with one JSON payload, recording requests. */
function startStubApi(
  payload: unknown,
  statusCode: number = StatusCodes.OK,
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      res.writeHead(statusCode, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  stubServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

/**
 * An address that never yields an HTTP answer: the listener accepts each connection and
 * destroys it immediately, so every fetch rejects. Staying bound for the test's lifetime
 * avoids the port-reuse race of the bind-close-reuse trick (the OS could hand the freed
 * port to another process before the CLI polls it).
 */
function unreachableUrl(): Promise<string> {
  const server = createServer();
  server.on("connection", (socket) => socket.destroy());
  stubServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function writeState(
  localDir: string,
  state: { apiBaseUrl: string; problemIds: readonly string[] },
): void {
  const processIdentity = observeProcessIdentity(process.pid);
  if (!processIdentity) throw new Error("test process identity is unavailable");
  writeFileSync(
    join(localDir, "state.json"),
    JSON.stringify(
      {
        pid: process.pid,
        processIdentity,
        deploymentPath: join(localDir, "deployment.json"),
        runtimeConfigPath: RUNTIME_CONFIG_PATH,
        participantToken: TEST_PARTICIPANT_TOKEN,
        ...state,
      },
      null,
      2,
    ),
  );
}

/** Arrange a recorded session: temp local dir + stub API + state.json pointing at it. */
async function startSession(options: {
  problemIds: readonly string[];
  payload: unknown;
  statusCode?: number;
}): Promise<{ localDir: string; url: string; requests: RecordedRequest[] }> {
  const localDir = makeLocalDir();
  const stub = await startStubApi(options.payload, options.statusCode);
  writeState(localDir, { apiBaseUrl: stub.url, problemIds: options.problemIds });
  return { localDir, url: stub.url, requests: stub.requests };
}

describe("tenkacloud-local CLI — command dispatch (#2527 Slice 0)", () => {
  it(
    "should print usage and exit 0 when no command is given",
    async () => {
      const result = await runCli([]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: bun run scripts/tenkacloud-local.ts <command>");
      expect(result.stdout).toContain("evaluate <flag>");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should print usage and exit 1 for an unknown command",
    async () => {
      const result = await runCli(["frobnicate"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Usage: bun run scripts/tenkacloud-local.ts <command>");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should require a deployment state path for serve",
    async () => {
      const result = await runCli(["serve"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("serve requires a deployment state path");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should fail loudly when the serve deployment state file is missing",
    async () => {
      const localDir = makeLocalDir();
      const missing = join(localDir, "missing-deployment.json");
      const result = await runCli(["serve", missing], { TENKACLOUD_LOCAL_DIR: localDir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Local deployment state was not found: ${missing}`);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should require a flag for evaluate",
    async () => {
      const result = await runCli(["evaluate"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("evaluate requires a flag");
    },
    CLI_TIMEOUT_MS,
  );
});

describe("tenkacloud-local CLI — status (#2527 Slice 0)", () => {
  it(
    "should report not-running and exit 1 when no session state exists",
    async () => {
      const result = await runCli(["status"], { TENKACLOUD_LOCAL_DIR: makeLocalDir() });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Local play is not running.");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should report a warm on-demand session when nothing was pre-started",
    async () => {
      const session = await startSession({ problemIds: [], payload: { status: "ok" } });

      const result = await runCli(["status"], { TENKACLOUD_LOCAL_DIR: session.localDir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Local play is running (on-demand, none pre-started).");
      expect(result.stdout).toContain(`Participant API: ${session.url}`);
      expect(session.requests.some((r) => r.url === "/healthz")).toBe(true);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should list the pre-started problem ids when present",
    async () => {
      const session = await startSession({
        problemIds: ["hello-world", "s3-secure"],
        payload: { status: "ok" },
      });

      const result = await runCli(["status"], { TENKACLOUD_LOCAL_DIR: session.localDir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Local play is running (hello-world, s3-secure).");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should time out and exit 1 when the recorded API is no longer reachable",
    async () => {
      const localDir = makeLocalDir();
      const deadUrl = await unreachableUrl();
      writeState(localDir, { apiBaseUrl: deadUrl, problemIds: [] });

      const result = await runCli(["status"], { TENKACLOUD_LOCAL_DIR: localDir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Timed out waiting for local Participant API: ${deadUrl}/healthz`,
      );
    },
    CLI_TIMEOUT_MS,
  );
});

describe("tenkacloud-local CLI — evaluate (#2527 Slice 0)", () => {
  it(
    "should report not-running and exit 1 when no session state exists",
    async () => {
      const result = await runCli(["evaluate", "FLAG{x}"], {
        TENKACLOUD_LOCAL_DIR: makeLocalDir(),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Local play is not running.");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should fail when the session has no problems to evaluate against",
    async () => {
      const session = await startSession({ problemIds: [], payload: { kind: "correct" } });

      const result = await runCli(["evaluate", "FLAG{x}"], {
        TENKACLOUD_LOCAL_DIR: session.localDir,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Local play has no problems to evaluate against.");
      expect(session.requests).toHaveLength(0);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should submit the flag for the first session problem and print the outcome",
    async () => {
      const session = await startSession({
        problemIds: ["hello-world"],
        payload: { kind: "correct", pointsAwarded: 100 },
      });

      const result = await runCli(["evaluate", "FLAG{tenka}"], {
        TENKACLOUD_LOCAL_DIR: session.localDir,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ kind: "correct", pointsAwarded: 100 });

      expect(session.requests).toHaveLength(1);
      const request = session.requests[0];
      expect(request?.method).toBe("POST");
      expect(request?.url).toBe("/portal/me/submit-flag");
      expect(request?.authorization).toBe(`Bearer ${TEST_PARTICIPANT_TOKEN}`);
      expect(JSON.parse(request?.body ?? "")).toEqual({
        problemId: "hello-world",
        flag: "FLAG{tenka}",
      });
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should route the submission to the PROBLEM env problem when it is in the session",
    async () => {
      const session = await startSession({
        problemIds: ["p-one", "p-two"],
        payload: { kind: "correct" },
      });

      const result = await runCli(["evaluate", "FLAG{x}"], {
        TENKACLOUD_LOCAL_DIR: session.localDir,
        PROBLEM: "p-two",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(session.requests[0]?.body ?? "")).toMatchObject({ problemId: "p-two" });
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should fall back to the first session problem when PROBLEM is not in the session",
    async () => {
      const session = await startSession({
        problemIds: ["p-one", "p-two"],
        payload: { kind: "correct" },
      });

      const result = await runCli(["evaluate", "FLAG{x}"], {
        TENKACLOUD_LOCAL_DIR: session.localDir,
        PROBLEM: "not-in-session",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(session.requests[0]?.body ?? "")).toMatchObject({ problemId: "p-one" });
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should exit 1 when the outcome is wrong",
    async () => {
      const session = await startSession({
        problemIds: ["hello-world"],
        payload: { kind: "wrong" },
      });

      const result = await runCli(["evaluate", "FLAG{nope}"], {
        TENKACLOUD_LOCAL_DIR: session.localDir,
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ kind: "wrong" });
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "should exit 1 when the API rejects the submission",
    async () => {
      const session = await startSession({
        problemIds: ["hello-world"],
        payload: { kind: "invalid_flag" },
        statusCode: StatusCodes.BAD_REQUEST,
      });

      const result = await runCli(["evaluate", "not-a-flag"], {
        TENKACLOUD_LOCAL_DIR: session.localDir,
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ kind: "invalid_flag" });
    },
    CLI_TIMEOUT_MS,
  );
});

describe("tenkacloud-local CLI — down (#2527 Slice 0)", () => {
  it(
    "should clean up crash leftovers and clear progress when no session state exists",
    async () => {
      const localDir = makeLocalDir();
      // A crashed `up` can leave deployment.json behind without state.json.
      const leftoverDeployment = join(localDir, "deployment.json");
      writeFileSync(leftoverDeployment, JSON.stringify({ problems: [] }));
      const runtimeConfigBefore = existsSync(RUNTIME_CONFIG_PATH)
        ? readFileSync(RUNTIME_CONFIG_PATH, "utf8")
        : undefined;

      const result = await runCli(["down"], { TENKACLOUD_LOCAL_DIR: localDir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Local play stopped and progress cleared.");
      expect(existsSync(leftoverDeployment)).toBe(false);
      // Without a backup the developer's live portal config must be left alone.
      const runtimeConfigAfter = existsSync(RUNTIME_CONFIG_PATH)
        ? readFileSync(RUNTIME_CONFIG_PATH, "utf8")
        : undefined;
      expect(runtimeConfigAfter).toBe(runtimeConfigBefore);
    },
    CLI_TIMEOUT_MS,
  );
});
