import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it } from "vitest";
import { handleLocalPlayRequest } from "../../../scripts/local-play/api";
import { createLocalPlayState, type LocalPlayRequest } from "../../../scripts/local-play/api-state";
import { waitForReachable } from "../../../scripts/local-play/docker-adapter";
import { observeProcessIdentity } from "../../../scripts/local-play/process-identity";
import {
  createSimulatorClient,
  loadSimulatedCloudProblems,
  type SimulatedCloudProblem,
  simulatorTemplateBody,
} from "../../../scripts/local-play/simulator";
import {
  createSimulatorLaunchSecret,
  decodeSimulatorLaunchSecret,
  issueSimulatorLaunchToken,
  simulatorConsoleUrl,
  simulatorLaunchTokenExpiresAt,
} from "../../../scripts/local-play/simulator-auth";
import {
  DEFAULT_SIMULATOR_IMAGE,
  launchPreparedSimulator,
  launchSimulator,
  prepareSimulatorLaunch,
  reconcileSimulatorLaunchIntent,
  resolveSimulatorSource,
  type SimulatorLauncherRecord,
  simulatorLaunchIntentPath,
  stopSimulatorLauncher,
  writeSimulatorLaunchIntent,
} from "../../../scripts/local-play/simulator-launcher";
import {
  cleanupRecordedSimulatorSession,
  SimulatorLocalRuntime,
  type SimulatorRuntimeOptions,
  type SimulatorSessionRecord,
} from "../../../scripts/local-play/simulator-runtime";
import { runSimulatorScoreCycle } from "../../../scripts/local-play/simulator-scoring";
import {
  readSimulatorSessionRecord,
  simulatorSessionSecretPath,
  writeSimulatorSessionRecord,
} from "../../../scripts/local-play/simulator-session-record";

const PROCESS_FIXTURE = resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "simulator-conformance-process.mjs",
);
const IGNORE_SIGTERM_PROCESS_FIXTURE = resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "simulator-ignore-sigterm.mjs",
);

const runningRuntimes: SimulatorLocalRuntime[] = [];

afterEach(async () => {
  for (const runtime of runningRuntimes.splice(0)) await runtime.close();
});

function post(path: string): LocalPlayRequest {
  return { method: "POST", path, query: {}, body: undefined };
}

function problem(problemDir: string): SimulatedCloudProblem {
  return {
    problemId: "hello-world",
    name: "Hello World",
    category: "challenges",
    description: "Read the simulated parameter.",
    instructions: "Open the Simulator console.",
    problemDir,
    runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    templateBody: "Resources: {}\n",
    metadata: {
      id: "hello-world",
      scoring: { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
      disruptions: [
        {
          id: "auth-probe",
          name: "Auth probe",
          eventDetailType: "AttackFired",
          parameters: { probe: "redteam/probes/sqli-auth-bypass.sh" },
        },
        {
          id: "service-stop",
          name: "Stop service",
          eventDetailType: "OutageDisruptionFired",
          action: {
            kind: "ssm-run-command",
            targetRef: "InstanceId",
            documentName: "AWS-RunShellScript",
            paramTemplate: { commands: ["systemctl stop app"] },
            revert: {
              afterSeconds: 60,
              documentName: "AWS-RunShellScript",
              paramTemplate: { commands: ["systemctl start app"] },
            },
          },
        },
      ],
    },
    scoring: { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
    simulationOverlay: {
      schemaVersion: "1",
      requirements: [
        {
          targetId: "default",
          service: "ssm",
          resourceType: "AWS::SSM::Command",
          operation: "SendCommand",
          fidelity: "L3",
          plane: "operator",
        },
      ],
    },
  };
}

function compositeProblem(problemDir: string): SimulatedCloudProblem {
  return {
    problemId: "hello-multicloud",
    name: "Hello Multicloud",
    category: "challenges",
    description: "Probe every provider.",
    instructions: "Keep both targets healthy.",
    problemDir,
    runtime: {
      kind: "composite",
      targets: [
        { id: "aws", provider: "aws", engine: "cloudformation", entry: "template.yaml" },
        { id: "gcp", provider: "gcp", engine: "infra-manager", entry: "gcp/terraform" },
      ],
    },
    templateBody: "{}",
    metadata: {
      scoring: {
        kind: "composite-probe",
        success: "all",
        pointsAllOk: 100,
        targets: [
          { targetId: "aws", probe: "https", outputKey: "Url" },
          { targetId: "gcp", probe: "https", outputKey: "Url" },
        ],
      },
    },
  };
}

function phasedProblem(problemDir: string): SimulatedCloudProblem {
  return {
    problemId: "phased-battle",
    name: "Phased Battle",
    category: "battles",
    description: "Keep the simulated workload healthy.",
    instructions: "Observe phase transitions.",
    problemDir,
    runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    templateBody: "Resources: {}\n",
    metadata: {
      id: "phased-battle",
      scoring: {
        kind: "phased-polling",
        intervalMinutes: 1,
        probe: { metaPath: "/meta", scorePath: "/score" },
        platformRules: { ec2: { points: 100, degradedPoints: 10 } },
        failurePenalty: -100,
        responsePenalties: [],
        bonuses: [],
      },
      endpoints: [
        {
          slot: "frontend",
          default: { from: "cfn-output", key: "BaseUrl", appendPath: "/workload" },
          overridable: true,
        },
      ],
      phases: [
        {
          name: "degraded",
          afterMinutes: 60,
          effect: { switchPlatformToDegraded: ["ec2"] },
        },
      ],
    },
  };
}

function attackProbeProblem(problemDir: string): SimulatedCloudProblem {
  return {
    problemId: "attack-probe-battle",
    name: "Attack Probe Battle",
    category: "battles",
    description: "Keep the simulated endpoint healthy and defended.",
    instructions: "Observe the scoring probe.",
    problemDir,
    runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    templateBody: "Resources: {}\n",
    metadata: {
      id: "attack-probe-battle",
      scoring: {
        kind: "uptime-multi",
        probedSlots: [
          { slot: "frontend", path: "/workload/score", expectStatus: [StatusCodes.OK] },
        ],
        pointsAllOk: 100,
        attackProbes: [
          {
            slot: "api",
            path: "/api/v1/auth",
            method: "POST",
            body: '{"username":"\' OR \'1\'=\'1\' -- ","password":"x"}',
            vulnerableStatus: [StatusCodes.OK],
            penalty: 20,
          },
        ],
      },
      endpoints: [
        {
          slot: "frontend",
          default: { from: "cfn-output", key: "BaseUrl" },
          overridable: true,
        },
        {
          slot: "api",
          default: { from: "cfn-output", key: "BaseUrl" },
          overridable: true,
        },
      ],
    },
  };
}

function runtimeOptions(root: string): SimulatorRuntimeOptions {
  const stateDir = join(root, "simulator-state");
  const env = {
    ...process.env,
    TENKACLOUD_SIMULATOR_COMMAND: process.execPath,
    TENKACLOUD_SIMULATOR_ARGS: JSON.stringify([PROCESS_FIXTURE]),
    TENKACLOUD_SIMULATOR_IMAGE: undefined,
    TENKACLOUD_SIMULATOR_URL: undefined,
  };
  return {
    sessionPath: join(root, "simulator-session.json"),
    stateDir,
    logPath: join(root, "simulator.log"),
    participantEnvPath: join(root, "simulator-native.env"),
    nativeProxyBaseUrl: "http://127.0.0.1:3199",
    env,
  };
}

function emptyExternalSession(port: number): SimulatorSessionRecord {
  return {
    protocolVersion: "2026-07-11",
    launcher: {
      kind: "external",
      baseUrl: `http://127.0.0.1:${port}`,
      launchSecret: createSimulatorLaunchSecret(),
      nativeCredentials: {
        awsAccessKeyId: "TCSIM12345678901",
        awsSecretAccessKey: "tcsim_1234567890123456",
        azureCredential: "tcsim_1234567890123456",
        gcpCredential: "tcsim_1234567890123456",
        sakuraCredential: "tcsim_1234567890123456:tcsim_abcdefghijklmnop",
      },
    },
    deployments: [],
  };
}

type PlacementResponseMode = "credentials" | "malformed" | "partial" | "server-error" | "unbound";

function placementResponseFetch(mode: () => PlacementResponseMode): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/operations/DescribeEndpointPlacement")) {
      return fetch(input, init);
    }
    if (mode() === "unbound") {
      return new Response('{"error":{"code":"EndpointPlacementNotFound"}}', {
        status: StatusCodes.NOT_FOUND,
      });
    }
    if (mode() === "server-error") {
      return new Response('{"error":{"code":"Unavailable"}}', {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
      });
    }
    const command = JSON.parse(String(init?.body)) as {
      deploymentId: string;
      targetId: string;
      input: { Slot: string };
    };
    if (mode() === "partial" && command.input.Slot === "secondary") {
      return new Response('{"error":{"code":"Unavailable"}}', {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
      });
    }
    if (mode() === "malformed") return Response.json({ Slot: command.input.Slot });
    return Response.json({
      DeploymentId: command.deploymentId,
      TargetId: command.targetId,
      Slot: command.input.Slot,
      EffectiveUrl:
        mode() === "credentials"
          ? "http://user:password@127.0.0.1:18080/workload"
          : "http://127.0.0.1:18080/workload",
      VerifiedPlatform: "ec2",
    });
  };
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} did not exit`);
}

async function workloadServer() {
  const server = createServer((_request, response) => {
    response.writeHead(StatusCodes.OK, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => accept());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("workload did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((accept) => server.close(() => accept())),
  };
}

async function platformWorkloadServer(platform: "lambda" | "ecs" | "apprunner") {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.writeHead(StatusCodes.OK, { "content-type": "application/json" });
    response.end(path.endsWith("/meta") ? JSON.stringify({ platform }) : '{"ok":true}');
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => accept());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("workload did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((accept) => server.close(() => accept())),
  };
}

describe("Simulator launch authorization", () => {
  it("should time out a Simulator call that never responds", async () => {
    const client = createSimulatorClient(
      "http://127.0.0.1:7777",
      () => new Promise<Response>(() => {}),
      undefined,
      10,
    );

    await expect(client.capabilities()).rejects.toThrow("timed out after 10ms");
  });

  it("should give synchronous world deletion its longer cleanup deadline", async () => {
    const client = createSimulatorClient(
      "http://127.0.0.1:7777",
      () => new Promise<Response>(() => {}),
      "launch-token",
      5,
      20,
    );

    await expect(client.deleteWorld("world")).rejects.toThrow("timed out after 20ms");
  });

  it("should time out a Simulator response body that stalls after headers", async () => {
    const client = createSimulatorClient(
      "http://127.0.0.1:7777",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"protocolVersion":'));
            },
          }),
          { status: StatusCodes.OK, headers: { "content-type": "application/json" } },
        ),
      undefined,
      10,
    );

    const outcome = await Promise.race([
      client.capabilities().then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 50)),
    ]);

    expect(outcome).toContain("timed out after 10ms");
  });

  it("should cap Simulator response bodies before parsing", async () => {
    const client = createSimulatorClient("http://127.0.0.1:7777", async () => {
      return new Response(new Uint8Array(1_000_001), { status: StatusCodes.OK });
    });

    await expect(client.capabilities()).rejects.toThrow(
      "Simulator response exceeded 1000000 bytes",
    );
  });

  it("should redact a non-success Simulator response body from errors", async () => {
    const reflectedSecret = "tc_sim_v1.reflected-secret";
    const client = createSimulatorClient(
      "http://127.0.0.1:7777",
      async () => new Response(reflectedSecret, { status: StatusCodes.BAD_GATEWAY }),
    );

    const message = await client.capabilities().then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(message).toBe("capabilities failed (HTTP 502)");
    expect(message).not.toContain(reflectedSecret);
  });

  it("should select the reviewed immutable image when no explicit source is configured", () => {
    expect(resolveSimulatorSource({})).toEqual({
      kind: "container",
      image: DEFAULT_SIMULATOR_IMAGE,
    });
    expect(DEFAULT_SIMULATOR_IMAGE).toBe(
      "ghcr.io/susumutomita/tenkacloud-simulator@sha256:049c6c165f9947b386b2c5864983aebefba26e996ec62859dae0e9814c52d505",
    );
  });

  it("should clear a pre-spawn process intent without creating ownership files", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-process-intent-only-"));
    const options = runtimeOptions(root);
    const prepared = await prepareSimulatorLaunch(options, options.sessionPath);
    if (prepared.kind !== "owned" || prepared.intent.kind !== "process") {
      throw new Error("test requires a prepared process launch");
    }
    writeSimulatorLaunchIntent(options.sessionPath, prepared.intent);

    expect(statSync(simulatorLaunchIntentPath(options.sessionPath)).mode & 0o777).toBe(0o600);
    expect(existsSync(prepared.intent.ownershipLeasePath)).toBe(false);
    expect(existsSync(prepared.intent.registrationPath)).toBe(false);

    await reconcileSimulatorLaunchIntent(options.sessionPath, undefined, options.env, 1);

    expect(existsSync(simulatorLaunchIntentPath(options.sessionPath))).toBe(false);
    expect(existsSync(prepared.intent.ownershipLeasePath)).toBe(false);
    expect(existsSync(prepared.intent.registrationPath)).toBe(false);
  });

  it("should reclaim a registered process after its parent loses the launch response", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-process-launch-crash-"));
    const options = runtimeOptions(root);
    const nonEnglishLocaleEnv = {
      ...options.env,
      LANG: "fr_FR.UTF-8",
      LC_ALL: "fr_FR.UTF-8",
    };
    const prepared = await prepareSimulatorLaunch(
      {
        ...options,
        env: nonEnglishLocaleEnv,
      },
      options.sessionPath,
    );
    if (prepared.kind !== "owned" || prepared.intent.kind !== "process") {
      throw new Error("test requires a prepared process launch");
    }
    writeSimulatorLaunchIntent(options.sessionPath, prepared.intent);
    const launcher = await launchPreparedSimulator(prepared.intent, nonEnglishLocaleEnv);
    if (launcher.kind !== "process" || launcher.pid === undefined) {
      throw new Error("test requires a process launcher");
    }

    expect(existsSync(prepared.intent.ownershipLeasePath)).toBe(true);
    expect(existsSync(prepared.intent.registrationPath)).toBe(true);
    await reconcileSimulatorLaunchIntent(options.sessionPath, undefined, options.env);
    await waitForProcessExit(launcher.pid);

    expect(existsSync(simulatorLaunchIntentPath(options.sessionPath))).toBe(false);
    expect(existsSync(prepared.intent.ownershipLeasePath)).toBe(false);
    expect(existsSync(prepared.intent.registrationPath)).toBe(false);
  });

  it("should recover a direct launch when the caller dies before session commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-direct-launch-crash-"));
    const options = runtimeOptions(root);
    const launcher = await launchSimulator(options);
    if (launcher.kind !== "process" || launcher.pid === undefined) {
      throw new Error("test requires a process launcher");
    }
    expect(existsSync(simulatorLaunchIntentPath(options.sessionPath))).toBe(true);
    expect(existsSync(launcher.ownershipLeasePath ?? "missing")).toBe(true);
    expect(existsSync(launcher.registrationPath ?? "missing")).toBe(true);

    await cleanupRecordedSimulatorSession(options.sessionPath, fetch, options.env);
    await waitForProcessExit(launcher.pid);

    expect(existsSync(simulatorLaunchIntentPath(options.sessionPath))).toBe(false);
    expect(existsSync(launcher.ownershipLeasePath ?? "missing")).toBe(false);
    expect(existsSync(launcher.registrationPath ?? "missing")).toBe(false);
  });

  it("should keep the process lease after commit and release it only when stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-process-launch-commit-"));
    const options = runtimeOptions(root);
    const prepared = await prepareSimulatorLaunch(options, options.sessionPath);
    if (prepared.kind !== "owned" || prepared.intent.kind !== "process") {
      throw new Error("test requires a prepared process launch");
    }
    writeSimulatorLaunchIntent(options.sessionPath, prepared.intent);
    const launcher = await launchPreparedSimulator(prepared.intent, options.env);
    if (launcher.kind !== "process" || launcher.pid === undefined) {
      throw new Error("test requires a process launcher");
    }
    writeSimulatorSessionRecord(options.sessionPath, {
      protocolVersion: "2026-07-11",
      launcher,
      deployments: [],
    });

    await reconcileSimulatorLaunchIntent(options.sessionPath, launcher, options.env);

    expect(existsSync(simulatorLaunchIntentPath(options.sessionPath))).toBe(false);
    expect(existsSync(prepared.intent.ownershipLeasePath)).toBe(true);
    expect(existsSync(prepared.intent.registrationPath)).toBe(true);
    const publicRecord = readFileSync(options.sessionPath, "utf8");
    expect(publicRecord).not.toMatch(
      /launchSecret|nativeCredentials|ownershipLeasePath|registrationPath/,
    );

    await stopSimulatorLauncher(launcher, options.env);
    await waitForProcessExit(launcher.pid);
    expect(existsSync(prepared.intent.ownershipLeasePath)).toBe(false);
    expect(existsSync(prepared.intent.registrationPath)).toBe(false);
  });

  it("should cancel the command when reconciliation races its supervisor registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-process-registration-race-"));
    const commandPath = join(root, "owned-command.mjs");
    const commandPidPath = join(root, "owned-command.pid");
    writeFileSync(
      commandPath,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(commandPidPath)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
    );
    const options = runtimeOptions(root);
    const prepared = await prepareSimulatorLaunch(
      {
        ...options,
        env: {
          ...options.env,
          TENKACLOUD_SIMULATOR_ARGS: JSON.stringify([commandPath]),
        },
      },
      options.sessionPath,
    );
    if (prepared.kind !== "owned" || prepared.intent.kind !== "process") {
      throw new Error("test requires a prepared process launch");
    }
    writeSimulatorLaunchIntent(options.sessionPath, prepared.intent);
    const launcher = await launchPreparedSimulator(prepared.intent, options.env);
    if (launcher.kind !== "process" || launcher.pid === undefined) {
      throw new Error("test requires a process launcher");
    }

    await reconcileSimulatorLaunchIntent(options.sessionPath, undefined, options.env);
    await waitForProcessExit(launcher.pid);
    if (existsSync(commandPidPath)) {
      await waitForProcessExit(Number(readFileSync(commandPidPath, "utf8")));
    }
  });

  it("should reclaim a command that kills its supervisor before launch acknowledgement", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-supervisor-killed-"));
    const commandPidPath = join(root, "kill-supervisor.pid");
    const options = runtimeOptions(root);
    const prepared = await prepareSimulatorLaunch(
      {
        ...options,
        env: {
          ...options.env,
          TENKACLOUD_SIMULATOR_COMMAND: "/bin/sh",
          TENKACLOUD_SIMULATOR_ARGS: JSON.stringify([
            "-c",
            'kill -STOP "$PPID"; printf "%s" "$$" > "$1"; kill -KILL "$PPID"; while :; do sleep 1; done',
            "kill-supervisor",
            commandPidPath,
          ]),
        },
      },
      options.sessionPath,
    );
    if (prepared.kind !== "owned" || prepared.intent.kind !== "process") {
      throw new Error("test requires a prepared process launch");
    }
    writeSimulatorLaunchIntent(options.sessionPath, prepared.intent);

    let commandPid: number | undefined;
    try {
      await launchPreparedSimulator(prepared.intent, options.env).catch(() => undefined);
      const pidDeadline = Date.now() + 3_000;
      while (!existsSync(commandPidPath) && Date.now() < pidDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(commandPidPath)).toBe(true);
      commandPid = Number(readFileSync(commandPidPath, "utf8"));

      await reconcileSimulatorLaunchIntent(options.sessionPath, undefined, options.env);
      await waitForProcessExit(commandPid);

      expect(existsSync(simulatorLaunchIntentPath(options.sessionPath))).toBe(false);
      expect(existsSync(prepared.intent.ownershipLeasePath)).toBe(false);
      expect(existsSync(prepared.intent.registrationPath)).toBe(false);
    } finally {
      if (commandPid !== undefined) {
        const identity = observeProcessIdentity(commandPid);
        if (identity) {
          await stopSimulatorLauncher(
            {
              kind: "process",
              baseUrl: prepared.intent.baseUrl,
              launchSecret: prepared.intent.launchSecret,
              nativeCredentials: prepared.intent.nativeCredentials,
              pid: commandPid,
              processIdentity: identity,
            },
            options.env,
          );
        }
      }
    }
  });

  it("should reclaim a deterministic container intent before and after spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-container-launch-intent-"));
    const callsPath = join(root, "docker-calls.log");
    const docker = join(root, "docker-fixture.mjs");
    writeFileSync(
      docker,
      `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n"); if (process.argv[2] === "run") process.stdout.write("fixture-container-id\\n");\n`,
    );
    chmodSync(docker, 0o700);
    const options = {
      stateDir: join(root, "state"),
      logPath: join(root, "simulator.log"),
      sessionPath: join(root, "simulator-session.json"),
      env: { TENKACLOUD_SIMULATOR_DOCKER_CLI: docker },
    };

    const beforeSpawn = await prepareSimulatorLaunch(options, options.sessionPath);
    if (beforeSpawn.kind !== "owned" || beforeSpawn.intent.kind !== "container") {
      throw new Error("test requires a prepared container launch");
    }
    writeSimulatorLaunchIntent(options.sessionPath, beforeSpawn.intent);
    await reconcileSimulatorLaunchIntent(options.sessionPath, undefined, options.env);

    const afterSpawn = await prepareSimulatorLaunch(options, options.sessionPath);
    if (afterSpawn.kind !== "owned" || afterSpawn.intent.kind !== "container") {
      throw new Error("test requires a prepared container launch");
    }
    writeSimulatorLaunchIntent(options.sessionPath, afterSpawn.intent);
    await launchPreparedSimulator(afterSpawn.intent, options.env);
    await reconcileSimulatorLaunchIntent(options.sessionPath, undefined, options.env);

    const calls = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toEqual([
      ["stop", "--time", "5", beforeSpawn.intent.containerName],
      expect.arrayContaining(["run", "--name", afterSpawn.intent.containerName]),
      ["stop", "--time", "5", afterSpawn.intent.containerName],
    ]);
    expect(existsSync(simulatorLaunchIntentPath(options.sessionPath))).toBe(false);
  });

  it("should keep the local-play docs pinned to the reviewed immutable image", () => {
    const root = resolve(import.meta.dirname, "..", "..", "..");
    for (const path of [
      "docs/local-play.md",
      "docs/architecture/adr-051-local-multicloud-simulator.html",
      "docs/vision.md",
    ]) {
      expect(readFileSync(join(root, path), "utf8")).toContain(DEFAULT_SIMULATOR_IMAGE);
    }
  });

  it("should bound the Simulator control container itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-control-bounds-"));
    const argumentsPath = join(root, "docker-arguments.json");
    const docker = join(root, "docker-fixture.mjs");
    writeFileSync(
      docker,
      `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write("fixture-container-id\\n");\n`,
    );
    chmodSync(docker, 0o700);

    const launcher = await launchSimulator({
      stateDir: join(root, "state"),
      logPath: join(root, "simulator.log"),
      sessionPath: join(root, "simulator-session.json"),
      env: { TENKACLOUD_SIMULATOR_DOCKER_CLI: docker },
    });

    const args = JSON.parse(
      readFileSync(argumentsPath, "utf8").trim().split("\n")[0] ?? "[]",
    ) as string[];
    expect(args).toContain("--memory=536870912");
    expect(args).toContain("--cpus=1");
    expect(args).toContain("--pids-limit=128");
    await stopSimulatorLauncher(launcher, { TENKACLOUD_SIMULATOR_DOCKER_CLI: docker });
  });

  it("should let one explicit source replace the default and reject ambiguous overrides", () => {
    expect(
      resolveSimulatorSource({ TENKACLOUD_SIMULATOR_COMMAND: "/opt/tenkacloud-simulator" }),
    ).toEqual({ kind: "process", command: "/opt/tenkacloud-simulator" });
    expect(() =>
      resolveSimulatorSource({
        TENKACLOUD_SIMULATOR_COMMAND: "/opt/tenkacloud-simulator",
        TENKACLOUD_SIMULATOR_IMAGE: DEFAULT_SIMULATOR_IMAGE,
      }),
    ).toThrow("exactly one Simulator source");
  });

  it("should issue the canonical HMAC token with namespace and expiry claims", () => {
    const secret = createSimulatorLaunchSecret();
    const token = issueSimulatorLaunchToken(
      secret,
      { tenantId: "tenant", eventId: "event", teamId: "team", deploymentId: "deployment" },
      60,
      1_000,
    );
    const [prefix, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const expected = createHmac("sha256", decodeSimulatorLaunchSecret(secret))
      .update(`${prefix}.${payload}`)
      .digest("base64url");

    expect(prefix).toBe("tc_sim_v1");
    expect(signature).toBe(expected);
    expect(claims).toMatchObject({
      tenantId: "tenant",
      eventId: "event",
      teamId: "team",
      deploymentId: "deployment",
      issuedAt: 1_000,
      expiresAt: 61_000,
    });
    expect(claims.nonce).toEqual(expect.any(String));
    expect(simulatorLaunchTokenExpiresAt(token, secret)).toBe(61_000);
    expect(simulatorLaunchTokenExpiresAt(token, createSimulatorLaunchSecret())).toBeUndefined();
  });

  it("should reject pre-tokenized Simulator console URLs instead of stripping their secrets", () => {
    const base = "http://127.0.0.1:42123";
    expect(() => simulatorConsoleUrl(`${base}/console?token=leaked`, "fresh", base)).toThrow(
      "same loopback origin",
    );
    expect(() => simulatorConsoleUrl(`${base}/console#token=leaked`, "fresh", base)).toThrow(
      "same loopback origin",
    );
  });

  it("should reject a short external launch secret and a mutable image tag", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-launch-"));
    await expect(
      launchSimulator({
        stateDir: join(root, "state-a"),
        logPath: join(root, "a.log"),
        env: {
          TENKACLOUD_SIMULATOR_URL: "http://127.0.0.1:42123",
          TENKACLOUD_SIMULATOR_LAUNCH_SECRET: Buffer.from("short").toString("base64url"),
        },
      }),
    ).rejects.toThrow("at least 32 bytes");
    await expect(
      launchSimulator({
        stateDir: join(root, "state-b"),
        logPath: join(root, "b.log"),
        env: { TENKACLOUD_SIMULATOR_IMAGE: "ghcr.io/tenkacloud/simulator:latest" },
      }),
    ).rejects.toThrow("digest-pinned");
    await expect(
      launchSimulator({
        stateDir: join(root, "state-c"),
        logPath: join(root, "c.log"),
        workloadImages: ["busybox:latest"],
        env: { TENKACLOUD_SIMULATOR_COMMAND: process.execPath },
      }),
    ).rejects.toThrow("workload images must be digest-pinned");
  });
});

describe("Simulator artifact bundle", () => {
  it("should keep a single-file runtime wire-compatible without overlay artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-single-artifact-"));
    writeFileSync(join(root, "template.yaml"), "Resources: {}\n");

    expect(
      simulatorTemplateBody(root, {
        provider: "aws",
        engine: "cloudformation",
        entry: "template.yaml",
      }),
    ).toBe("Resources: {}\n");
  });

  it("should preserve every target artifact in canonical order", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-artifacts-"));
    mkdirSync(join(root, "gcp", "terraform"), { recursive: true });
    writeFileSync(join(root, "template.yaml"), "Resources: {}\n");
    writeFileSync(join(root, "gcp", "terraform", "variables.tf"), 'variable "name" {}\n');
    writeFileSync(
      join(root, "gcp", "terraform", "main.tf"),
      'resource "google_cloud_run_v2_service" "hello" {}\n',
    );

    const body = simulatorTemplateBody(root, {
      kind: "composite",
      targets: [
        { id: "gcp-hello", provider: "gcp", engine: "infra-manager", entry: "gcp/terraform" },
        { id: "aws-hello", provider: "aws", engine: "cloudformation", entry: "template.yaml" },
      ],
    });
    const bundle = JSON.parse(body) as {
      format: string;
      targets: Array<{ id: string; artifacts: Array<{ path: string }> }>;
    };

    expect(bundle.format).toBe("tenkacloud.simulator.artifacts.v1");
    expect(bundle.targets.map((target) => target.id)).toEqual(["aws-hello", "gcp-hello"]);
    expect(bundle.targets[1].artifacts.map((artifact) => artifact.path)).toEqual([
      "gcp/terraform/main.tf",
      "gcp/terraform/variables.tf",
    ]);
  });

  it("should load a validated simulation overlay and reject a stale artifact digest", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-overlay-"));
    const catalogRoot = join(root, "challenges");
    const problemDir = join(catalogRoot, "overlay-problem");
    mkdirSync(problemDir, { recursive: true });
    const artifactPath = join(problemDir, "workload.json");
    const artifact = '{"healthy":true}\n';
    writeFileSync(join(problemDir, "template.yaml"), "Resources: {}\n");
    writeFileSync(artifactPath, artifact);
    writeFileSync(
      join(problemDir, "metadata.json"),
      JSON.stringify({
        id: "overlay-problem",
        name: "Overlay Problem",
        description: "Validate a simulation overlay.",
        instructions: "Inspect the workload.",
        runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
        scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
        simulationOverlay: { schemaVersion: "1", entry: "simulation.json" },
      }),
    );
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    const overlay = {
      schemaVersion: "1",
      requirements: [
        {
          targetId: "default",
          service: "workload",
          resourceType: "HTTP::Endpoint",
          operation: "Materialize",
          fidelity: "L3",
          plane: "workload",
          artifact: {
            path: "workload.json",
            sha256: artifactSha256,
          },
        },
      ],
      workloads: [
        {
          id: "catalog-workload",
          targetId: "default",
          resourceRef: "BaseUrl",
          image: `ghcr.io/tenkacloud/workload@sha256:${"a".repeat(64)}`,
          containerPort: 8080,
          artifact: { path: "workload.json", sha256: artifactSha256 },
        },
      ],
    };
    writeFileSync(join(problemDir, "simulation.json"), JSON.stringify(overlay));

    const [loaded] = loadSimulatedCloudProblems([catalogRoot]);
    expect(loaded.simulationOverlay).toEqual(overlay);
    const bundle = JSON.parse(loaded.templateBody) as {
      format: string;
      targets: Array<{ id: string; artifacts: Array<{ path: string; content: string }> }>;
    };
    expect(bundle.format).toBe("tenkacloud.simulator.artifacts.v1");
    expect(bundle.targets).toEqual([
      {
        id: "default",
        provider: "aws",
        engine: "cloudformation",
        entry: "template.yaml",
        artifacts: [
          { path: "template.yaml", content: "Resources: {}\n" },
          { path: "workload.json", content: artifact },
        ],
      },
    ]);

    writeFileSync(artifactPath, '{"healthy":false}\n');
    expect(() => loadSimulatedCloudProblems([catalogRoot])).toThrow("sha256 is stale");
  });
});

describe("provider-neutral local runtime", () => {
  it("should preserve the previous generation when the protected commit fails", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-secret-commit-failure-"));
    const options = runtimeOptions(root);
    const original = emptyExternalSession(42_123);
    writeSimulatorSessionRecord(options.sessionPath, original);
    const originalPublic = readFileSync(options.sessionPath, "utf8");
    const originalSecret = readFileSync(simulatorSessionSecretPath(options.sessionPath), "utf8");

    expect(() =>
      writeSimulatorSessionRecord(options.sessionPath, emptyExternalSession(42_124), {
        beforeSecretCommit: () => {
          throw new Error("injected protected commit failure");
        },
      }),
    ).toThrow("injected protected commit failure");

    expect(readFileSync(options.sessionPath, "utf8")).toBe(originalPublic);
    expect(readFileSync(simulatorSessionSecretPath(options.sessionPath), "utf8")).toBe(
      originalSecret,
    );
    expect(readSimulatorSessionRecord(options.sessionPath).launcher.baseUrl).toBe(
      original.launcher.baseUrl,
    );
  });

  it("should recover the newest protected generation after a public commit interruption", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-public-commit-failure-"));
    const options = runtimeOptions(root);
    const original = emptyExternalSession(42_123);
    const replacement = emptyExternalSession(42_124);
    writeSimulatorSessionRecord(options.sessionPath, original);

    expect(() =>
      writeSimulatorSessionRecord(options.sessionPath, replacement, {
        afterSecretCommit: () => {
          throw new Error("injected public commit interruption");
        },
      }),
    ).toThrow("injected public commit interruption");
    expect(JSON.parse(readFileSync(options.sessionPath, "utf8"))).toMatchObject({
      launcher: { baseUrl: original.launcher.baseUrl },
    });

    expect(readSimulatorSessionRecord(options.sessionPath).launcher.baseUrl).toBe(
      replacement.launcher.baseUrl,
    );
    const recoveredPublic = readFileSync(options.sessionPath, "utf8");
    expect(recoveredPublic).toContain(replacement.launcher.baseUrl);
    expect(recoveredPublic).not.toMatch(/launchSecret|launchToken|nativeCredentials|#token=/);
    expect(statSync(options.sessionPath).mode & 0o777).toBe(0o600);
    expect(statSync(simulatorSessionSecretPath(options.sessionPath)).mode & 0o777).toBe(0o600);

    unlinkSync(options.sessionPath);
    expect(() => new SimulatorLocalRuntime(options)).not.toThrow();
    expect(readFileSync(options.sessionPath, "utf8")).toContain(replacement.launcher.baseUrl);
  });

  it("should stop an owned launcher and allow retry when its first protected commit fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-first-persist-failure-"));
    const launched: SimulatorLauncherRecord[] = [];
    let failProtectedCommit = true;
    const options: SimulatorRuntimeOptions = {
      ...runtimeOptions(root),
      sessionWriteHooks: {
        beforeSecretCommit: () => {
          if (!failProtectedCommit) return;
          failProtectedCommit = false;
          throw new Error("injected first protected commit failure");
        },
      },
      onLauncherStarted: (launcher) => launched.push(launcher),
    };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);

    await expect(runtime.start(problem(root))).rejects.toThrow(
      "injected first protected commit failure",
    );
    const failedLauncher = launched[0];
    if (failedLauncher?.kind !== "process" || failedLauncher.pid === undefined) {
      throw new Error("test requires an owned process launcher");
    }
    await waitForProcessExit(failedLauncher.pid);
    expect(existsSync(options.sessionPath)).toBe(false);
    expect(existsSync(simulatorSessionSecretPath(options.sessionPath))).toBe(false);

    await expect(runtime.start(problem(root))).resolves.toMatchObject({ status: "running" });
    expect(launched).toHaveLength(2);
  });

  it("should recover a missing public projection before crash cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-secret-only-cleanup-"));
    const options = runtimeOptions(root);
    const original = emptyExternalSession(42_123);
    const launchToken = "stale-token";
    const deployment = {
      problemId: "secret-only",
      worldId: "world-secret-only",
      deploymentId: "deployment-secret-only",
      launchToken,
      status: "running" as const,
      outputs: { ParameterValue: "TC{secret}" },
      consoleUrl: simulatorConsoleUrl(
        `${original.launcher.baseUrl}/console/secret-only`,
        launchToken,
        original.launcher.baseUrl,
      ),
      nativeCredentials: original.launcher.nativeCredentials,
      clockObservedAtMs: 1,
    };
    writeSimulatorSessionRecord(options.sessionPath, {
      ...original,
      deployments: [deployment],
    });
    unlinkSync(options.sessionPath);
    let deletedPath: string | undefined;

    await cleanupRecordedSimulatorSession(
      options.sessionPath,
      async (input) => {
        deletedPath = new URL(String(input)).pathname;
        return new Response(null, { status: StatusCodes.NO_CONTENT });
      },
      {},
      options.participantEnvPath,
      20,
    );

    expect(deletedPath).toBe("/v1/worlds/world-secret-only");
    expect(existsSync(options.sessionPath)).toBe(false);
    expect(existsSync(simulatorSessionSecretPath(options.sessionPath))).toBe(false);
  });

  it("should reconcile a deleted world when stop persistence fails once", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-stop-persist-retry-"));
    let failNextProtectedCommit = false;
    const options: SimulatorRuntimeOptions = {
      ...runtimeOptions(root),
      sessionWriteHooks: {
        beforeSecretCommit: () => {
          if (!failNextProtectedCommit) return;
          failNextProtectedCommit = false;
          throw new Error("injected stop persistence failure");
        },
      },
    };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    await runtime.start(problem(root));

    failNextProtectedCommit = true;
    await expect(runtime.stop("hello-world")).rejects.toThrow("injected stop persistence failure");
    expect(readSimulatorSessionRecord(options.sessionPath).deployments).toHaveLength(1);

    await expect(runtime.stop("hello-world")).resolves.toBeUndefined();
    expect(readSimulatorSessionRecord(options.sessionPath).deployments).toEqual([]);
    expect(JSON.parse(readFileSync(join(options.stateDir, "worlds.json"), "utf8"))).toEqual([]);
  });

  it("should delete and reconcile a new world when its first record update is interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-deployment-persist-failure-"));
    let committedProtectedGenerations = 0;
    const options: SimulatorRuntimeOptions = {
      ...runtimeOptions(root),
      sessionWriteHooks: {
        afterSecretCommit: () => {
          committedProtectedGenerations += 1;
          if (committedProtectedGenerations === 3) {
            throw new Error("injected deployment public commit interruption");
          }
        },
      },
    };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);

    await expect(runtime.start(problem(root))).rejects.toThrow(
      "injected deployment public commit interruption",
    );
    expect(readSimulatorSessionRecord(options.sessionPath).deployments).toEqual([]);
    expect(JSON.parse(readFileSync(join(options.stateDir, "worlds.json"), "utf8"))).toEqual([]);

    await expect(runtime.start(problem(root))).resolves.toMatchObject({ status: "running" });
  });

  it("should persist retained world ownership when first record commit and delete both fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-retained-world-"));
    let protectedCommit = 0;
    let failDelete = true;
    const options: SimulatorRuntimeOptions = {
      ...runtimeOptions(root),
      sessionWriteHooks: {
        beforeSecretCommit: () => {
          protectedCommit += 1;
          if (protectedCommit === 3) {
            throw new Error("injected first deployment protected commit failure");
          }
        },
      },
      fetchFn: async (input, init) => {
        if (failDelete && init?.method === "DELETE") {
          throw new Error("injected world delete failure");
        }
        return fetch(input, init);
      },
    };
    const simulator = new SimulatorLocalRuntime(options);
    runningRuntimes.push(simulator);
    const state = createLocalPlayState(
      { problems: [], simulatedProblems: [problem(root)] },
      { simulator, maxRunning: 1 },
    );

    const started = await handleLocalPlayRequest(
      post("/portal/me/problems/hello-world/start"),
      state,
    );
    expect(started.status).toBe(StatusCodes.BAD_GATEWAY);
    expect(state.lifecycle.cleanupRequired("hello-world")).toBe(true);
    expect(readSimulatorSessionRecord(options.sessionPath).deployments).toMatchObject([
      { problemId: "hello-world", worldId: expect.any(String) },
    ]);

    failDelete = false;
    const stopped = await handleLocalPlayRequest(
      post("/portal/me/problems/hello-world/stop"),
      state,
    );
    expect(stopped).toEqual({ status: StatusCodes.OK, body: { status: "stopped" } });
    expect(state.lifecycle.cleanupRequired("hello-world")).toBe(false);
    expect(readSimulatorSessionRecord(options.sessionPath).deployments).toEqual([]);
  });

  it("should share one launcher and atomic session across concurrent problem starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-cross-problem-start-"));
    const launchers: SimulatorLauncherRecord[] = [];
    const runtime = new SimulatorLocalRuntime({
      ...runtimeOptions(root),
      onLauncherStarted: (launcher) => launchers.push(launcher),
    });
    runningRuntimes.push(runtime);
    const second = {
      ...problem(root),
      problemId: "hello-two",
      metadata: { ...problem(root).metadata, id: "hello-two" },
    };

    const [firstDeployment, secondDeployment] = await Promise.all([
      runtime.start(problem(root)),
      runtime.start(second),
    ]);

    expect(launchers).toHaveLength(1);
    expect(firstDeployment.worldId).not.toBe(secondDeployment.worldId);
    const recorded = readSimulatorSessionRecord(runtimeOptions(root).sessionPath);
    expect(recorded.launcher).toMatchObject({
      pid: launchers[0]?.pid,
      processIdentity: launchers[0]?.processIdentity,
    });
    expect(recorded.deployments.map((deployment) => deployment.problemId).sort()).toEqual([
      "hello-two",
      "hello-world",
    ]);
  });

  it("should reject a Simulator console URL outside the launcher loopback origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-console-origin-"));
    const observed: string[] = [];
    const runtime = new SimulatorLocalRuntime({
      ...runtimeOptions(root),
      fetchFn: async (input, init) => {
        const url = String(input);
        observed.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        if (url.endsWith("/v1/capabilities")) {
          return Response.json({
            protocolVersion: "2026-07-11",
            providers: {
              aws: {
                engines: {
                  cloudformation: {
                    operations: ["deploy", "delete", "get", "capabilities", "world"],
                  },
                },
              },
            },
          });
        }
        if (url.endsWith("/v1/worlds") && init?.method === "POST") {
          return Response.json(
            { worldId: "world-hostile-console", consoleUrl: "http://127.0.0.1:1/console" },
            { status: StatusCodes.CREATED },
          );
        }
        if (url.endsWith("/v1/worlds/world-hostile-console") && init?.method === "DELETE") {
          return new Response(null, { status: StatusCodes.NO_CONTENT });
        }
        throw new Error(`unexpected Simulator request: ${init?.method ?? "GET"} ${url}`);
      },
    });
    runningRuntimes.push(runtime);

    await expect(runtime.start(problem(root))).rejects.toThrow("same loopback origin");
    expect(observed).toContain("DELETE /v1/worlds/world-hostile-console");
    expect(JSON.parse(readFileSync(runtimeOptions(root).sessionPath, "utf8"))).toMatchObject({
      deployments: [],
    });
  });

  it("should mark an unready recorded launcher for replacement on the next start", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-stale-launcher-"));
    const options = {
      ...runtimeOptions(root),
      startTimeoutMs: 20,
      requestTimeoutMs: 5,
      retryDelayMs: 1,
    };
    const stale: SimulatorSessionRecord = {
      protocolVersion: "2026-07-11",
      launcher: {
        kind: "external",
        baseUrl: "http://127.0.0.1:1",
        launchSecret: createSimulatorLaunchSecret(),
        nativeCredentials: {
          awsAccessKeyId: "TCSIM12345678901",
          awsSecretAccessKey: "tcsim_1234567890123456",
          azureCredential: "tcsim_1234567890123456",
          gcpCredential: "tcsim_1234567890123456",
          sakuraCredential: "tcsim_1234567890123456:tcsim_abcdefghijklmnop",
        },
      },
      deployments: [],
    };
    writeSimulatorSessionRecord(options.sessionPath, stale);

    await expect(new SimulatorLocalRuntime(options).start(problem(root))).rejects.toThrow(
      "Simulator did not become ready",
    );
    expect(JSON.parse(readFileSync(options.sessionPath, "utf8"))).toMatchObject({
      launcherNeedsReplacement: true,
    });

    const recovered = new SimulatorLocalRuntime({
      ...runtimeOptions(root),
      startTimeoutMs: 3_000,
    });
    runningRuntimes.push(recovered);
    await expect(recovered.start(problem(root))).resolves.toMatchObject({
      problemId: "hello-world",
      status: "running",
    });
    expect(JSON.parse(readFileSync(options.sessionPath, "utf8"))).not.toHaveProperty(
      "launcherNeedsReplacement",
    );
  });

  it("should migrate a legacy single-file session before restart without losing outputs", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-legacy-restart-"));
    const options = runtimeOptions(root);
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    await runtime.start(problem(root));
    const legacyRecord = readSimulatorSessionRecord(options.sessionPath);
    writeFileSync(options.sessionPath, `${JSON.stringify(legacyRecord, null, 2)}\n`);
    unlinkSync(simulatorSessionSecretPath(options.sessionPath));

    const recovered = new SimulatorLocalRuntime(options);
    await expect(recovered.fireDisruption(problem(root), "service-stop")).resolves.toMatchObject({
      provider: "aws",
      operation: "SendCommand",
    });
    const migratedPublicRecord = readFileSync(options.sessionPath, "utf8");
    expect(migratedPublicRecord).not.toMatch(/launchSecret|launchToken|nativeCredentials|#token=/);
    expect(statSync(simulatorSessionSecretPath(options.sessionPath)).mode & 0o777).toBe(0o600);
  });

  it("should rotate an expired persisted launch token before resumed access and cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-token-renewal-"));
    const options = runtimeOptions(root);
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    await runtime.start(problem(root));
    const recorded = readSimulatorSessionRecord(options.sessionPath);
    const deployment = recorded.deployments[0];
    if (!deployment) throw new Error("expected a recorded deployment");
    const expiredToken = issueSimulatorLaunchToken(
      recorded.launcher.launchSecret,
      {
        tenantId: "local",
        eventId: "local",
        teamId: "local",
        deploymentId: deployment.deploymentId,
      },
      86_400,
      Date.now() - 86_400_001,
    );
    const consoleBase = new URL(deployment.consoleUrl);
    consoleBase.hash = "";
    writeSimulatorSessionRecord(options.sessionPath, {
      ...recorded,
      deployments: [
        {
          ...deployment,
          launchToken: expiredToken,
          consoleUrl: simulatorConsoleUrl(
            consoleBase.toString(),
            expiredToken,
            recorded.launcher.baseUrl,
          ),
        },
      ],
    });

    const recovered = new SimulatorLocalRuntime(options);
    const resumed = await recovered.start(problem(root));
    expect(resumed.launchToken).not.toBe(expiredToken);
    expect(
      simulatorLaunchTokenExpiresAt(resumed.launchToken, recorded.launcher.launchSecret),
    ).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1_000);
    await expect(recovered.consoleUrl(problem(root).problemId)).resolves.toContain(
      `#token=${encodeURIComponent(resumed.launchToken)}`,
    );
    if (!options.participantEnvPath) throw new Error("participant env path is missing");
    expect(readFileSync(options.participantEnvPath, "utf8")).not.toContain(expiredToken);
  });

  it("should migrate and clean up a legacy single-file session during local-down recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-legacy-cleanup-"));
    const options = runtimeOptions(root);
    const launchToken = "legacy-launch-token";
    const nativeCredentials = {
      awsAccessKeyId: "TCSIM12345678901",
      awsSecretAccessKey: "tcsim_1234567890123456",
      azureCredential: "tcsim_1234567890123456",
      gcpCredential: "tcsim_1234567890123456",
      sakuraCredential: "tcsim_1234567890123456:tcsim_abcdefghijklmnop",
    };
    const launcher = {
      kind: "external" as const,
      baseUrl: "http://127.0.0.1:42123",
      launchSecret: createSimulatorLaunchSecret(),
      nativeCredentials,
    };
    const legacyRecord = {
      protocolVersion: "2026-07-11" as const,
      launcher,
      deployments: [
        {
          problemId: "legacy",
          worldId: "legacy-world",
          deploymentId: "legacy-deployment",
          launchToken,
          status: "running" as const,
          outputs: { InstanceId: "i-legacy" },
          consoleUrl: simulatorConsoleUrl(
            `${launcher.baseUrl}/console/legacy`,
            launchToken,
            launcher.baseUrl,
          ),
          nativeCredentials,
          clockObservedAtMs: 1,
        },
      ],
    } satisfies SimulatorSessionRecord;
    writeFileSync(options.sessionPath, `${JSON.stringify(legacyRecord, null, 2)}\n`);
    if (!options.participantEnvPath) throw new Error("participant env path is missing");
    writeFileSync(options.participantEnvPath, "legacy credentials\n");
    let observedAuthorization: string | null = null;

    await cleanupRecordedSimulatorSession(
      options.sessionPath,
      async (_input, init) => {
        observedAuthorization = new Headers(init?.headers).get("authorization");
        return new Response(null, { status: StatusCodes.NO_CONTENT });
      },
      {},
      options.participantEnvPath,
      20,
    );

    expect(observedAuthorization).toMatch(/^Bearer tc_sim_v1\./);
    expect(observedAuthorization).not.toBe(`Bearer ${launchToken}`);
    expect(existsSync(options.sessionPath)).toBe(false);
    expect(existsSync(simulatorSessionSecretPath(options.sessionPath))).toBe(false);
    expect(existsSync(options.participantEnvPath)).toBe(false);
  });

  it("should attempt every recorded world and retain only failed cleanup work", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-cleanup-retry-"));
    const options = runtimeOptions(root);
    const launchSecret = createSimulatorLaunchSecret();
    const launcher = {
      kind: "external" as const,
      baseUrl: "http://127.0.0.1:42123",
      launchSecret,
      nativeCredentials: {
        awsAccessKeyId: "TCSIM12345678901",
        awsSecretAccessKey: "tcsim_1234567890123456",
        azureCredential: "tcsim_1234567890123456",
        gcpCredential: "tcsim_1234567890123456",
        sakuraCredential: "tcsim_1234567890123456:tcsim_abcdefghijklmnop",
      },
    };
    const deployments = ["deleted", "retry"].map((problemId) => {
      const launchToken = `token-${problemId}`;
      return {
        problemId,
        worldId: `world-${problemId}`,
        deploymentId: `deployment-${problemId}`,
        launchToken,
        status: "running" as const,
        outputs: {},
        consoleUrl: simulatorConsoleUrl(
          `${launcher.baseUrl}/console/${problemId}`,
          launchToken,
          launcher.baseUrl,
        ),
        nativeCredentials: launcher.nativeCredentials,
        clockObservedAtMs: 1,
      };
    });
    writeSimulatorSessionRecord(options.sessionPath, {
      protocolVersion: "2026-07-11",
      launcher,
      deployments,
    });
    if (!options.participantEnvPath) throw new Error("participant env path is missing");
    writeFileSync(options.participantEnvPath, "private");
    const attempted: string[] = [];
    const firstFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      attempted.push(url);
      if (url.endsWith("/world-retry")) throw new Error("transient delete failure");
      return new Response(null, { status: StatusCodes.NO_CONTENT });
    };

    await expect(
      cleanupRecordedSimulatorSession(
        options.sessionPath,
        firstFetch,
        {},
        options.participantEnvPath,
        20,
      ),
    ).rejects.toThrow("can be retried");
    expect(attempted).toHaveLength(2);
    const retryRecord = JSON.parse(readFileSync(options.sessionPath, "utf8"));
    expect(retryRecord).toMatchObject({ deployments: [{ problemId: "retry" }] });
    expect(retryRecord).not.toHaveProperty("launcherNeedsReplacement");
    expect(existsSync(options.participantEnvPath)).toBe(true);

    await cleanupRecordedSimulatorSession(
      options.sessionPath,
      async () => new Response(null, { status: StatusCodes.NO_CONTENT }),
      {},
      options.participantEnvPath,
      20,
    );
    expect(existsSync(options.sessionPath)).toBe(false);
    expect(existsSync(options.participantEnvPath)).toBe(false);
  });

  it("should keep an owned launcher alive until failed world cleanup can retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-owned-cleanup-retry-"));
    const options = runtimeOptions(root);
    const launcher = await launchSimulator(options);
    if (launcher.kind !== "process" || launcher.pid === undefined) {
      throw new Error("test requires an owned process launcher");
    }
    const launchToken = "token-retry";
    const deployment = {
      problemId: "retry",
      worldId: "world-retry",
      deploymentId: "deployment-retry",
      launchToken,
      status: "running" as const,
      outputs: {},
      consoleUrl: simulatorConsoleUrl(
        `${launcher.baseUrl}/console/retry`,
        launchToken,
        launcher.baseUrl,
      ),
      nativeCredentials: launcher.nativeCredentials,
      clockObservedAtMs: 1,
    };
    writeSimulatorSessionRecord(options.sessionPath, {
      protocolVersion: "2026-07-11",
      launcher,
      deployments: [deployment],
    } satisfies SimulatorSessionRecord);
    try {
      await expect(
        cleanupRecordedSimulatorSession(
          options.sessionPath,
          async () => {
            throw new Error("transient delete failure");
          },
          options.env,
          options.participantEnvPath,
          20,
        ),
      ).rejects.toThrow("can be retried");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => process.kill(launcher.pid ?? 0, 0)).not.toThrow();
      expect(JSON.parse(readFileSync(options.sessionPath, "utf8"))).toMatchObject({
        deployments: [{ problemId: "retry" }],
      });

      await cleanupRecordedSimulatorSession(
        options.sessionPath,
        async () => new Response(null, { status: StatusCodes.NO_CONTENT }),
        options.env,
        options.participantEnvPath,
        20,
      );
      expect(existsSync(options.sessionPath)).toBe(false);
      await waitForProcessExit(launcher.pid);
    } finally {
      if (existsSync(options.sessionPath)) await stopSimulatorLauncher(launcher, options.env);
    }
  });

  it("should continue runtime cleanup after one world deletion fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-close-aggregate-"));
    const options = runtimeOptions(root);
    const launchSecret = createSimulatorLaunchSecret();
    const nativeCredentials = {
      awsAccessKeyId: "TCSIM12345678901",
      awsSecretAccessKey: "tcsim_1234567890123456",
      azureCredential: "tcsim_1234567890123456",
      gcpCredential: "tcsim_1234567890123456",
      sakuraCredential: "tcsim_1234567890123456:tcsim_abcdefghijklmnop",
    };
    const launcher = {
      kind: "external" as const,
      baseUrl: "http://127.0.0.1:42123",
      launchSecret,
      nativeCredentials,
    };
    const deployments = ["one", "two"].map((problemId) => {
      const launchToken = `token-${problemId}`;
      return {
        problemId,
        worldId: `world-${problemId}`,
        deploymentId: `deployment-${problemId}`,
        launchToken,
        status: "running" as const,
        outputs: {},
        consoleUrl: simulatorConsoleUrl(
          `${launcher.baseUrl}/console/${problemId}`,
          launchToken,
          launcher.baseUrl,
        ),
        nativeCredentials,
        clockObservedAtMs: 1,
      };
    });
    writeSimulatorSessionRecord(options.sessionPath, {
      protocolVersion: "2026-07-11",
      launcher,
      deployments,
    } satisfies SimulatorSessionRecord);
    const attempted: string[] = [];
    const runtime = new SimulatorLocalRuntime({
      ...options,
      fetchFn: async (input) => {
        attempted.push(String(input));
        throw new Error("delete failed");
      },
      requestTimeoutMs: 20,
    });

    await expect(runtime.close()).rejects.toThrow("Simulator cleanup failed");
    expect(attempted).toHaveLength(2);
    const closeRecord = JSON.parse(readFileSync(options.sessionPath, "utf8"));
    expect(closeRecord).toMatchObject({
      deployments: [{ problemId: "one" }, { problemId: "two" }],
    });
    expect(closeRecord).not.toHaveProperty("launcherNeedsReplacement");
  });

  it("should not mark a launcher replaced when its stop operation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-close-launcher-failure-"));
    const options = runtimeOptions(root);
    const nativeCredentials = {
      awsAccessKeyId: "TCSIM12345678901",
      awsSecretAccessKey: "tcsim_1234567890123456",
      azureCredential: "tcsim_1234567890123456",
      gcpCredential: "tcsim_1234567890123456",
      sakuraCredential: "tcsim_1234567890123456:tcsim_abcdefghijklmnop",
    };
    writeSimulatorSessionRecord(options.sessionPath, {
      protocolVersion: "2026-07-11",
      launcher: {
        kind: "container",
        baseUrl: "http://127.0.0.1:42123",
        launchSecret: createSimulatorLaunchSecret(),
        nativeCredentials,
        containerName: "simulator-stop-must-fail",
      },
      deployments: [],
    } satisfies SimulatorSessionRecord);
    const runtime = new SimulatorLocalRuntime({
      ...options,
      env: { ...options.env, TENKACLOUD_SIMULATOR_DOCKER_CLI: "/usr/bin/false" },
    });

    await expect(runtime.close()).rejects.toThrow("Simulator cleanup failed");
    expect(JSON.parse(readFileSync(options.sessionPath, "utf8"))).not.toHaveProperty(
      "launcherNeedsReplacement",
    );
  });

  it("should reject unsupported cloud scoring kinds before world creation", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-unsupported-scoring-"));
    const unsupported = [
      {
        kind: "multi-flag",
        flags: [{ id: "one", label: "One", flagOutputKey: "FlagOne", points: 50 }],
      },
      {
        kind: "multi-verify",
        checks: [
          { id: "one", label: "One", points: 50 },
          { id: "two", label: "Two", points: 50 },
        ],
      },
    ] as const;

    for (const scoring of unsupported) {
      expect(() =>
        createLocalPlayState({
          problems: [],
          simulatedProblems: [
            { ...problem(root), metadata: { ...problem(root).metadata, scoring } },
          ],
        }),
      ).toThrow(`Simulator local play does not support scoring kind ${scoring.kind}`);
    }
  });

  it("should expose composite-probe hints in the participant view", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-composite-hints-"));
    const composite: SimulatedCloudProblem = {
      ...problem(root),
      problemId: "composite-hints",
      runtime: {
        kind: "composite",
        targets: [
          {
            id: "aws-app",
            provider: "aws",
            engine: "cloudformation",
            entry: "template.yaml",
          },
        ],
      },
      metadata: {
        scoring: {
          kind: "composite-probe",
          success: "all",
          pointsAllOk: 100,
          targets: [
            {
              targetId: "aws-app",
              probe: "https",
              outputKey: "ServiceUrl",
            },
          ],
          hints: [{ id: "first-step", content: "Check both targets.", penalty: 5 }],
        },
      },
    };
    const state = createLocalPlayState({ problems: [], simulatedProblems: [composite] });

    const response = await handleLocalPlayRequest(
      { method: "GET", path: "/portal/me", query: {}, body: undefined },
      state,
    );
    const view = (
      response.body as { problems: Array<{ scoring?: { hints?: readonly unknown[] } }> }
    ).problems[0];

    expect(view.scoring?.hints).toEqual([{ id: "first-step", penalty: 5, revealed: false }]);
    // fairness contract (platform #1124 / SCHEMA): `description` is the
    // admin/authoring field (scoring rules, hardened state, red-team playbook).
    // The simulated view must drop it exactly like the Docker view does.
    expect(view).not.toHaveProperty("description");
  });

  it("should launch a real process, drive portal lifecycle, persist, snapshot, and delete the world", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-runtime-"));
    const options = runtimeOptions(root);
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const state = createLocalPlayState(
      { problems: [], simulatedProblems: [problem(root)] },
      { simulator: runtime, simulatorSnapshotDir: join(root, "snapshots") },
    );

    const started = await handleLocalPlayRequest(
      post("/portal/me/problems/hello-world/start"),
      state,
    );
    expect(started.body).toEqual({ status: "running" });
    const recoveredRuntime = new SimulatorLocalRuntime(options);
    await expect(
      recoveredRuntime.fireDisruption(problem(root), "service-stop"),
    ).resolves.toMatchObject({
      provider: "aws",
      operation: "SendCommand",
    });
    const simulatedRuntime = state.simulatedRuntimes.get("hello-world");
    if (!simulatedRuntime?.deployment) throw new Error("simulated deployment is missing");
    simulatedRuntime.deployment = {
      ...simulatedRuntime.deployment,
      outputs: {
        ...simulatedRuntime.deployment.outputs,
        SimulatorConsoleUrl: "http://127.0.0.1/console#token=must-not-reach-api",
        SimulatorAwsAccessKeyId: "TCSIMMUSTNOTREACHAPI",
        SimulatorAzureCredential: "azure-must-not-reach-api",
        SimulatorGcpCredential: "gcp-must-not-reach-api",
        SimulatorSakuraCredential: "sakura-must-not-reach-api",
        "aws-hello.SimulatorConsoleUrl":
          "http://127.0.0.1/console#token=namespaced-must-not-reach-api",
        "gcp-app.SimulatorGcpCredential": "namespaced-gcp-must-not-reach-api",
        ParameterConsoleUrl:
          "https://us-east-1.console.aws.amazon.com/systems-manager/parameters/local/hello",
        StaleAlbUrl: "https://abc123.elb.us-east-1.amazonaws.com/",
        StaleFunctionUrl: "https://fn123.lambda-url.us-east-1.on.aws/",
        ExternalDocsUrl: "https://example.com/local-play-guide",
      },
    };

    const team = await handleLocalPlayRequest(
      { method: "GET", path: "/portal/me", query: {}, body: undefined },
      state,
    );
    const view = (
      team.body as {
        problems: Array<{
          stackOutputs: Record<string, string>;
          lifecycle: { status: string; runtimeKind?: string };
        }>;
      }
    ).problems[0];
    expect(view.lifecycle).toEqual({ status: "running", runtimeKind: "simulated-cloud" });
    expect(view.stackOutputs.ParameterName).toBe("/local/hello");
    expect(view.stackOutputs).not.toHaveProperty("ParameterValue");
    expect(view.stackOutputs).not.toHaveProperty("SimulatorConsoleUrl");
    expect(view.stackOutputs).not.toHaveProperty("SimulatorAwsAccessKeyId");
    expect(view.stackOutputs).not.toHaveProperty("SimulatorAzureCredential");
    expect(view.stackOutputs).not.toHaveProperty("SimulatorGcpCredential");
    expect(view.stackOutputs).not.toHaveProperty("SimulatorSakuraCredential");
    expect(view.stackOutputs).not.toHaveProperty("aws-hello.SimulatorConsoleUrl");
    expect(view.stackOutputs).not.toHaveProperty("gcp-app.SimulatorGcpCredential");
    expect(view.stackOutputs).not.toHaveProperty("ParameterConsoleUrl");
    expect(view.stackOutputs).not.toHaveProperty("StaleAlbUrl");
    expect(view.stackOutputs).not.toHaveProperty("StaleFunctionUrl");
    expect(view.stackOutputs.ExternalDocsUrl).toBe("https://example.com/local-play-guide");
    expect(simulatedRuntime.deployment.outputs.ParameterConsoleUrl).toContain(
      "console.aws.amazon.com",
    );
    const serializedSession = readFileSync(options.sessionPath, "utf8");
    expect(serializedSession).not.toMatch(/launchSecret|launchToken|nativeCredentials|#token=/);
    expect(serializedSession).not.toMatch(/tcsim_[A-Za-z0-9_-]+/);
    expect(serializedSession).not.toContain("TC{simulated}");
    expect(statSync(options.sessionPath).mode & 0o777).toBe(0o600);
    const secretPath = simulatorSessionSecretPath(options.sessionPath);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    const serializedSecrets = readFileSync(secretPath, "utf8");
    expect(serializedSecrets).toMatch(/launchSecret|launchToken/);
    expect(serializedSecrets).toContain("TC{simulated}");
    expect(JSON.stringify(team.body)).not.toMatch(/tc_sim_v1|tcsim_[A-Za-z0-9_-]+/);
    if (!options.participantEnvPath) throw new Error("participant env path is missing");
    const participantEnvironment = readFileSync(options.participantEnvPath, "utf8");
    expect(statSync(options.participantEnvPath).mode & 0o777).toBe(0o600);
    expect(participantEnvironment).toContain(
      "AWS_ENDPOINT_URL='http://127.0.0.1:3199/local/simulator-native/hello-world/default'",
    );
    expect(participantEnvironment).toMatch(/AWS_SECRET_ACCESS_KEY='tcsim_[A-Za-z0-9_-]+'/);
    expect(participantEnvironment).toContain(`TENKACLOUD_SIMULATOR_WORLD_ID='world-`);
    expect(participantEnvironment).toContain("TENKACLOUD_SIMULATOR_TARGET_ID='default'");
    const worldsAfterStart = JSON.parse(
      readFileSync(join(options.stateDir, "worlds.json"), "utf8"),
    ) as Array<{ request?: { simulationOverlay?: unknown; metadata?: Record<string, unknown> } }>;
    expect(worldsAfterStart[0]?.request?.simulationOverlay).toEqual(
      problem(root).simulationOverlay,
    );
    expect(worldsAfterStart[0]?.request?.metadata).not.toHaveProperty("simulationOverlayDocument");

    const unauthenticatedHandoff = await handleLocalPlayRequest(
      {
        method: "POST",
        path: "/portal/me/problems/hello-world/console-handoff",
        query: {},
        body: undefined,
      },
      state,
    );
    expect(unauthenticatedHandoff.status).toBe(StatusCodes.UNAUTHORIZED);
    const wrongTokenHandoff = await handleLocalPlayRequest(
      {
        method: "POST",
        path: "/portal/me/problems/hello-world/console-handoff",
        query: {},
        body: undefined,
        authorization: "Bearer wrong-local-session",
      },
      state,
    );
    expect(wrongTokenHandoff.status).toBe(StatusCodes.UNAUTHORIZED);
    const issuedHandoff = await handleLocalPlayRequest(
      {
        method: "POST",
        path: "/portal/me/problems/hello-world/console-handoff",
        query: {},
        body: undefined,
        authorization: `Bearer ${state.participantToken}`,
      },
      state,
    );
    expect(JSON.stringify(issuedHandoff.body)).not.toMatch(/tc_sim_v1|#token=/);
    const handoffPath = (issuedHandoff.body as { handoffPath: string }).handoffPath;
    const handoffUrl = new URL(handoffPath, "http://local.invalid");
    const firstHandoff = await handleLocalPlayRequest(
      {
        method: "GET",
        path: handoffUrl.pathname,
        query: Object.fromEntries(handoffUrl.searchParams),
        body: undefined,
      },
      state,
    );
    expect(firstHandoff).toMatchObject({
      status: StatusCodes.SEE_OTHER,
      body: undefined,
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
    expect(firstHandoff.headers?.location).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/console\/[^#]+#token=tc_sim_v1\./,
    );
    const replayedHandoff = await handleLocalPlayRequest(
      {
        method: "GET",
        path: handoffUrl.pathname,
        query: Object.fromEntries(handoffUrl.searchParams),
        body: undefined,
      },
      state,
    );
    expect(replayedHandoff.status).toBe(StatusCodes.UNAUTHORIZED);

    const reset = await handleLocalPlayRequest(
      post("/portal/me/problems/hello-world/reset"),
      state,
    );
    expect(reset.body).toEqual({ status: "running" });
    const secondIssuedHandoff = await handleLocalPlayRequest(
      {
        method: "POST",
        path: "/portal/me/problems/hello-world/console-handoff",
        query: {},
        body: undefined,
        authorization: `Bearer ${state.participantToken}`,
      },
      state,
    );
    const secondHandoffUrl = new URL(
      (secondIssuedHandoff.body as { handoffPath: string }).handoffPath,
      "http://local.invalid",
    );
    const secondHandoff = await handleLocalPlayRequest(
      {
        method: "GET",
        path: secondHandoffUrl.pathname,
        query: Object.fromEntries(secondHandoffUrl.searchParams),
        body: undefined,
      },
      state,
    );
    expect(secondHandoff.headers?.location).not.toBe(firstHandoff.headers?.location);

    const submitted = await handleLocalPlayRequest(
      {
        method: "POST",
        path: "/portal/me/submit-flag",
        query: {},
        body: { problemId: "hello-world", flag: "TC{simulated}" },
      },
      state,
    );
    expect(submitted.body).toEqual({ kind: "ok", scoreDelta: 100, totalScore: 100 });

    const unauthenticatedSnapshot = await handleLocalPlayRequest(
      post("/local/operator/problems/hello-world/snapshots/latest/export"),
      state,
    );
    expect(unauthenticatedSnapshot.status).toBe(StatusCodes.UNAUTHORIZED);
    const exportSnapshot = await handleLocalPlayRequest(
      {
        ...post("/local/operator/problems/hello-world/snapshots/latest/export"),
        authorization: `Bearer ${state.participantToken}`,
      },
      state,
    );
    expect(exportSnapshot.status).toBe(StatusCodes.OK);
    const snapshotPath = join(root, "snapshots", "latest.json");
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toMatchObject({
      protocolVersion: "2026-07-11",
      namespace: { tenantId: "local", eventId: "local", teamId: "local" },
    });
    const importSnapshot = await handleLocalPlayRequest(
      {
        ...post("/local/operator/problems/hello-world/snapshots/latest/import"),
        authorization: `Bearer ${state.participantToken}`,
      },
      state,
    );
    expect(importSnapshot.status).toBe(StatusCodes.OK);
    const disruption = await runtime.fireDisruption(problem(root), "service-stop");
    expect(disruption).toMatchObject({ provider: "aws", operation: "SendCommand" });
    const attackProbe = await runtime.fireDisruption(problem(root), "auth-probe");
    expect(attackProbe).toMatchObject({
      provider: "aws",
      operation: "AttackProbe",
      StatusCode: StatusCodes.FORBIDDEN,
      Landed: false,
    });

    const stopped = await handleLocalPlayRequest(
      post("/portal/me/problems/hello-world/stop"),
      state,
    );
    expect(stopped.body).toEqual({ status: "stopped" });
    const worldsPath = join(options.stateDir, "worlds.json");
    expect(JSON.parse(readFileSync(worldsPath, "utf8"))).toEqual([]);
    expect(() => statSync(options.participantEnvPath ?? "")).toThrow();
  });

  it("should recover a lost restore response and replay the completed receipt after reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-snapshot-response-loss-"));
    let loseRestoreResponse = true;
    let restorePosts = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/snapshots")) {
        restorePosts += 1;
        const response = await fetch(input, init);
        if (loseRestoreResponse) {
          loseRestoreResponse = false;
          await response.arrayBuffer();
          throw new Error("injected lost restore response");
        }
        return response;
      }
      return fetch(input, init);
    };
    const options = { ...runtimeOptions(root), fetchFn, retryDelayMs: 1 };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const first = await runtime.start(problem(root));
    const snapshotPath = join(root, "response-loss-snapshot.json");
    await runtime.exportSnapshot(first.problemId, snapshotPath);

    await runtime.importSnapshot(first.problemId, snapshotPath);

    const afterRestore = readSimulatorSessionRecord(options.sessionPath);
    const restored = afterRestore.deployments[0];
    expect(restored?.worldId).not.toBe(first.worldId);
    expect(afterRestore.pendingSnapshotRestores).toBeUndefined();
    expect(afterRestore.completedSnapshotRestores).toMatchObject([
      {
        problemId: first.problemId,
        sourceWorldId: first.worldId,
        restoredWorldId: restored?.worldId,
        snapshotHash: "a".repeat(64),
      },
    ]);
    await expect(runtime.dataPlaneRoute(problem(root), "default")).resolves.toMatchObject({
      worldId: restored?.worldId,
    });
    expect(restorePosts).toBe(1);
    const publicRecord = readFileSync(options.sessionPath, "utf8");
    expect(publicRecord).not.toMatch(
      /completedSnapshotRestores|idempotencyKey|launchToken|restore-[a-f0-9]{64}/,
    );

    const recovered = new SimulatorLocalRuntime(options);
    await expect(recovered.importSnapshot(first.problemId, snapshotPath)).resolves.toBeUndefined();
    expect(restorePosts).toBe(1);
    runningRuntimes.splice(runningRuntimes.indexOf(runtime), 1);
    await recovered.stop(first.problemId);
    expect(JSON.parse(readFileSync(join(options.stateDir, "worlds.json"), "utf8"))).toEqual([]);
    expect(readSimulatorSessionRecord(options.sessionPath)).toMatchObject({
      deployments: [],
    });
    expect(
      readSimulatorSessionRecord(options.sessionPath).completedSnapshotRestores,
    ).toBeUndefined();
    await recovered.close();
  });

  it("should resume the same clone after source deletion fails and the runtime reloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-snapshot-delete-retry-"));
    let sourceWorldId = "";
    let failSourceDelete = true;
    let restorePosts = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/snapshots")) restorePosts += 1;
      if (
        failSourceDelete &&
        init?.method === "DELETE" &&
        url.pathname === `/v1/worlds/${encodeURIComponent(sourceWorldId)}`
      ) {
        failSourceDelete = false;
        throw new Error("injected source delete failure");
      }
      return fetch(input, init);
    };
    const options = { ...runtimeOptions(root), fetchFn, retryDelayMs: 1 };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const original = await runtime.start(problem(root));
    sourceWorldId = original.worldId;
    const snapshotPath = join(root, "delete-retry.json");
    await runtime.exportSnapshot(original.problemId, snapshotPath);

    await expect(runtime.importSnapshot(original.problemId, snapshotPath)).rejects.toThrow(
      "injected source delete failure",
    );
    const interrupted = readSimulatorSessionRecord(options.sessionPath);
    expect(interrupted.deployments[0]?.worldId).not.toBe(sourceWorldId);
    expect(interrupted.pendingSnapshotRestores?.[0]).toMatchObject({
      sourceWorldId,
      restoredWorldId: interrupted.deployments[0]?.worldId,
    });
    expect(JSON.parse(readFileSync(join(options.stateDir, "worlds.json"), "utf8"))).toHaveLength(2);

    const recovered = new SimulatorLocalRuntime(options);
    await expect(
      recovered.importSnapshot(original.problemId, snapshotPath),
    ).resolves.toBeUndefined();
    expect(restorePosts).toBe(1);
    expect(JSON.parse(readFileSync(join(options.stateDir, "worlds.json"), "utf8"))).toHaveLength(1);
    runningRuntimes.splice(runningRuntimes.indexOf(runtime), 1);
    await recovered.stop(original.problemId);
    expect(JSON.parse(readFileSync(join(options.stateDir, "worlds.json"), "utf8"))).toEqual([]);
    await recovered.close();
  });

  it("should reject symlinked, oversized, and invalid-hash snapshot files", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-snapshot-file-guard-"));
    const options = runtimeOptions(root);
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const deployment = await runtime.start(problem(root));
    const validPath = join(root, "valid.json");
    await runtime.exportSnapshot(deployment.problemId, validPath);

    const symlinkPath = join(root, "snapshot-link.json");
    symlinkSync(validPath, symlinkPath);
    await expect(runtime.importSnapshot(deployment.problemId, symlinkPath)).rejects.toThrow();

    const oversizedPath = join(root, "oversized.json");
    writeFileSync(oversizedPath, "x".repeat(16 * 1024 * 1024 + 1));
    await expect(runtime.importSnapshot(deployment.problemId, oversizedPath)).rejects.toThrow(
      "exceeds",
    );

    const invalidHashPath = join(root, "invalid-hash.json");
    const snapshot = JSON.parse(readFileSync(validPath, "utf8")) as Record<string, unknown>;
    writeFileSync(invalidHashPath, JSON.stringify({ ...snapshot, hash: "not-a-hash" }));
    await expect(runtime.importSnapshot(deployment.problemId, invalidHashPath)).rejects.toThrow();
  });

  it.each([
    ["intent-only", 4, false, false],
    ["restored-known", 5, true, false],
    ["active-switched", 6, true, false],
    ["completed-receipt", 7, false, true],
  ] as const)("should rehydrate and clean the %s snapshot generation", async (stage, failAtCommit, expectsPendingRestored, expectsCompleted) => {
    const root = mkdtempSync(join(tmpdir(), `tc-simulator-snapshot-${stage}-`));
    let commits = 0;
    const options: SimulatorRuntimeOptions = {
      ...runtimeOptions(root),
      retryDelayMs: 1,
      sessionWriteHooks: {
        afterSecretCommit: () => {
          commits += 1;
          if (commits === failAtCommit) {
            throw new Error(`injected ${stage} commit interruption`);
          }
        },
      },
    };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const original = await runtime.start(problem(root));
    const snapshotPath = join(root, `${stage}.json`);
    await runtime.exportSnapshot(original.problemId, snapshotPath);

    await expect(runtime.importSnapshot(original.problemId, snapshotPath)).rejects.toThrow(
      "world still requires cleanup",
    );
    let persisted = readSimulatorSessionRecord(options.sessionPath);
    expect(persisted.completedSnapshotRestores !== undefined).toBe(expectsCompleted);
    if (expectsCompleted) {
      expect(persisted.pendingSnapshotRestores).toBeUndefined();
    } else {
      expect(persisted.pendingSnapshotRestores).toHaveLength(1);
      expect(persisted.pendingSnapshotRestores?.[0]?.restoredWorldId !== undefined).toBe(
        expectsPendingRestored,
      );
    }
    expect(readFileSync(options.sessionPath, "utf8")).not.toMatch(
      /idempotencyKey|launchToken|completedSnapshotRestores/,
    );

    if (stage === "restored-known") {
      const expiredToken = issueSimulatorLaunchToken(
        persisted.launcher.launchSecret,
        {
          tenantId: "local",
          eventId: "local",
          teamId: "local",
          deploymentId: original.deploymentId,
        },
        1,
        0,
      );
      writeSimulatorSessionRecord(options.sessionPath, {
        ...persisted,
        deployments: persisted.deployments.map((deployment) => ({
          ...deployment,
          launchToken: expiredToken,
          consoleUrl: simulatorConsoleUrl(
            new URL(deployment.consoleUrl.split("#", 1)[0] ?? deployment.consoleUrl).toString(),
            expiredToken,
            persisted.launcher.baseUrl,
          ),
        })),
      });
      persisted = readSimulatorSessionRecord(options.sessionPath);
      expect(persisted.deployments[0]?.launchToken).toBe(expiredToken);
    }

    const recovered = new SimulatorLocalRuntime({ ...options, sessionWriteHooks: undefined });
    runningRuntimes.splice(runningRuntimes.indexOf(runtime), 1);
    await recovered.stop(original.problemId);
    expect(JSON.parse(readFileSync(join(options.stateDir, "worlds.json"), "utf8"))).toEqual([]);
    const cleaned = readSimulatorSessionRecord(options.sessionPath);
    expect(cleaned.deployments).toEqual([]);
    expect(cleaned.pendingSnapshotRestores).toBeUndefined();
    expect(cleaned.completedSnapshotRestores).toBeUndefined();
    await recovered.close();
  });

  it("should launch an injected executable through an argv-safe supervisor", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-process-"));
    const options = runtimeOptions(root);
    const launcher = await launchSimulator({
      ...options,
      env: {
        ...options.env,
        AWS_SECRET_ACCESS_KEY: "must-not-reach-simulator",
        AWS_SESSION_TOKEN: "must-not-reach-simulator",
        AZURE_CLIENT_SECRET: "must-not-reach-simulator",
        GOOGLE_APPLICATION_CREDENTIALS: "/must/not/reach/simulator.json",
        SAKURACLOUD_ACCESS_TOKEN: "must-not-reach-simulator",
      },
    });
    try {
      expect(launcher.kind).toBe("process");
      expect(launcher.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(launcher.launchSecret).not.toContain("=");
      expect(launcher.processIdentity).toMatch(/^[a-f0-9]{64}$/);
      await waitForReachable(
        `${launcher.baseUrl}/v1/capabilities`,
        "Simulator credential inheritance fixture",
        3_000,
      );
      const capabilities = (await (await fetch(`${launcher.baseUrl}/v1/capabilities`)).json()) as {
        inheritedHostCredentials?: readonly string[];
      };
      expect(capabilities.inheritedHostCredentials).toEqual([]);
      const {
        ownershipLeasePath: _ownershipLeasePath,
        registrationPath: _registrationPath,
        launchIntentPath: _launchIntentPath,
        childPid: _childPid,
        childProcessIdentity: _childProcessIdentity,
        ...launcherWithoutOwnershipFiles
      } = launcher;
      const { processIdentity: _missingIdentity, ...legacyLauncher } =
        launcherWithoutOwnershipFiles;
      await expect(stopSimulatorLauncher(legacyLauncher, options.env)).rejects.toThrow(
        "identity changed",
      );
      await expect(
        stopSimulatorLauncher(
          { ...launcherWithoutOwnershipFiles, processIdentity: "0".repeat(64) },
          options.env,
        ),
      ).resolves.toBeUndefined();
      expect(() => process.kill(launcher.pid ?? 0, 0)).not.toThrow();
    } finally {
      await stopSimulatorLauncher(launcher, options.env);
    }
  });

  it("should not expose conformance-process exception details over HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-error-response-"));
    const options = runtimeOptions(root);
    const launcher = await launchSimulator(options);
    try {
      await waitForReachable(
        `${launcher.baseUrl}/v1/capabilities`,
        "Simulator error-response fixture",
        3_000,
      );
      const response = await fetch(`${launcher.baseUrl}/v1/worlds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
      expect(await response.json()).toEqual({
        error: {
          code: "UnauthorizedOperation",
          message: "Simulator request was rejected",
        },
      });
    } finally {
      await stopSimulatorLauncher(launcher, options.env);
    }
  });

  it("should retain ownership when an injected process ignores SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-ignore-sigterm-"));
    const options = runtimeOptions(root);
    const launcher = await launchSimulator({
      ...options,
      env: {
        ...options.env,
        TENKACLOUD_SIMULATOR_ARGS: JSON.stringify([IGNORE_SIGTERM_PROCESS_FIXTURE]),
      },
    });
    if (launcher.kind !== "process" || launcher.pid === undefined) {
      throw new Error("test requires an owned process launcher");
    }
    try {
      // launchSimulator returns once the supervisor has registered the child PID. Under a
      // loaded test shard, the child module may not yet have installed its SIGTERM handler;
      // signalling during that gap makes this test pass the signal through and exit normally.
      const readyDeadline = Date.now() + 3_000;
      while (
        (!existsSync(options.logPath) ||
          !readFileSync(options.logPath, "utf8").includes("TENKACLOUD_IGNORE_SIGTERM_READY")) &&
        Date.now() < readyDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(readFileSync(options.logPath, "utf8")).toContain("TENKACLOUD_IGNORE_SIGTERM_READY");
      await expect(stopSimulatorLauncher(launcher, options.env, 50)).rejects.toThrow(
        "did not stop within 50ms",
      );
      expect(() => process.kill(launcher.pid ?? 0, 0)).not.toThrow();
    } finally {
      await stopSimulatorLauncher(launcher, options.env, 3_000, "SIGUSR1");
      await waitForProcessExit(launcher.pid);
      expect(existsSync(launcher.ownershipLeasePath ?? "missing")).toBe(false);
      expect(existsSync(launcher.registrationPath ?? "missing")).toBe(false);
    }
  });

  it("should count solved Simulator flag and composite challenges as complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-leaderboard-"));
    const state = createLocalPlayState({
      problems: [],
      simulatedProblems: [problem(root), compositeProblem(root)],
    });
    state.simulatedRuntimes.get("hello-world")?.solved.add("hello-world");
    state.simulatedRuntimes.get("hello-multicloud")?.solved.add("hello-multicloud");

    const leaderboard = await handleLocalPlayRequest(
      { method: "GET", path: "/portal/leaderboard", query: {}, body: undefined },
      state,
    );

    expect(
      (
        leaderboard.body as {
          entries: Array<{ completedProblems: number; totalProblems: number }>;
        }
      ).entries[0],
    ).toMatchObject({ completedProblems: 2, totalProblems: 2 });
  });

  it("should pass only the catalog workload allowlist and fixed quotas to a process runner", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-workload-policy-"));
    const workloadImage = `ghcr.io/tenkacloud/workload@sha256:${"a".repeat(64)}`;
    const launcher = await launchSimulator({
      ...runtimeOptions(root),
      workloadImages: [workloadImage],
    });
    try {
      await waitForReachable(
        `${launcher.baseUrl}/v1/capabilities`,
        "Simulator workload policy fixture",
        3_000,
      );
      const response = await fetch(`${launcher.baseUrl}/v1/capabilities`);
      const capabilities = (await response.json()) as {
        workloadPolicy?: Readonly<Record<string, unknown>>;
      };
      expect(capabilities.workloadPolicy).toEqual({
        allowedImages: JSON.stringify([
          "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662",
          workloadImage,
        ]),
        maxMemoryBytes: "536870912",
        maxMilliCpu: "1000",
        maxPids: "128",
        proxyImage:
          "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662",
      });
    } finally {
      await stopSimulatorLauncher(launcher);
    }
  });

  it("should advance the Simulator clock before scoring a phased problem", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-clock-"));
    const options = runtimeOptions(root);
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const state = createLocalPlayState(
      { problems: [], simulatedProblems: [phasedProblem(root)] },
      { simulator: runtime },
    );

    await handleLocalPlayRequest(post("/portal/me/problems/phased-battle/start"), state);
    const deployment = state.simulatedRuntimes.get("phased-battle")?.deployment;
    if (!deployment) throw new Error("phased deployment did not start");
    const scored = await handleLocalPlayRequest(
      post("/portal/me/problems/phased-battle/score"),
      state,
      deployment.clockObservedAtMs + 60_000,
    );

    expect(scored.status).toBe(StatusCodes.OK);
    const worlds = JSON.parse(
      readFileSync(join(options.stateDir, "worlds.json"), "utf8"),
    ) as Array<{
      clockAdvances?: number[];
    }>;
    expect(worlds[0]?.clockAdvances?.at(-1)).toBe(60_000);
  });

  it("should reset world telemetry without re-enabling session-scoped once awards", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-reset-scoring-state-"));
    const options = runtimeOptions(root);
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    let now = 1_000;
    const state = createLocalPlayState(
      { problems: [], simulatedProblems: [phasedProblem(root)] },
      { simulator: runtime, now: () => now },
    );
    await state.lifecycle.ensureRunning("phased-battle");
    const simulated = state.simulatedRuntimes.get("phased-battle");
    if (!simulated) throw new Error("phased runtime is missing");
    simulated.score = 5_000;
    simulated.scoringState = {
      bonusAwarded: { "all-slots-on-platforms": true },
      firedDisruptions: ["once-disruption"],
      attackCount: 7,
      activeEffects: [{ disruptionId: "old-world", points: -10, expiresAtMs: 9_999 }],
    };
    simulated.endpointsHealth = "old-health";
    simulated.attackProbes = "old-probes";
    simulated.posture = "old-posture";
    simulated.platform = "lambda";
    simulated.lastResult = "ok";
    const firstCreatedAt = simulated.createdAt;

    await state.lifecycle.stop("phased-battle");
    now = 2_000;
    await state.lifecycle.ensureRunning("phased-battle");

    expect(simulated.createdAt).not.toBe(firstCreatedAt);
    expect(simulated.score).toBe(5_000);
    expect(simulated.scoringState).toEqual({
      bonusAwarded: { "all-slots-on-platforms": true },
      firedDisruptions: ["once-disruption"],
    });
    expect(simulated).toMatchObject({
      endpointsHealth: undefined,
      attackProbes: undefined,
      posture: undefined,
      platform: undefined,
      lastResult: undefined,
    });
  });

  it("should not resurrect or score a world stopped during an in-flight clock advance", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-stop-during-score-"));
    let releaseAdvance = (): void => {};
    const advanceGate = new Promise<void>((resolve) => {
      releaseAdvance = resolve;
    });
    let observeAdvance = (): void => {};
    const advanceStarted = new Promise<void>((resolve) => {
      observeAdvance = resolve;
    });
    const options: SimulatorRuntimeOptions = {
      ...runtimeOptions(root),
      fetchFn: async (input, init) => {
        if (new URL(String(input)).pathname.endsWith("/clock/advance")) {
          observeAdvance();
          await advanceGate;
        }
        return fetch(input, init);
      },
    };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const state = createLocalPlayState(
      { problems: [], simulatedProblems: [phasedProblem(root)] },
      { simulator: runtime },
    );
    await state.lifecycle.ensureRunning("phased-battle");
    const deployment = state.simulatedRuntimes.get("phased-battle")?.deployment;
    if (!deployment) throw new Error("phased deployment did not start");

    const scoring = handleLocalPlayRequest(
      post("/portal/me/problems/phased-battle/score"),
      state,
      deployment.clockObservedAtMs + 60_000,
    );
    await advanceStarted;
    const stopping = handleLocalPlayRequest(post("/portal/me/problems/phased-battle/stop"), state);
    expect(state.lifecycle.statusOf("phased-battle")).toBe("stopping");
    releaseAdvance();

    await expect(stopping).resolves.toMatchObject({ body: { status: "stopped" } });
    await expect(scoring).resolves.toEqual({
      status: StatusCodes.CONFLICT,
      body: { error: "not_running" },
    });
    expect(state.simulatedRuntimes.get("phased-battle")?.score).toBe(0);
    expect(readSimulatorSessionRecord(options.sessionPath).deployments).toEqual([]);
  });

  it("should serialize snapshot export with stop and leave no stale deployment", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-snapshot-stop-race-"));
    let releaseSnapshot = (): void => {};
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let observeSnapshot = (): void => {};
    const snapshotStarted = new Promise<void>((resolve) => {
      observeSnapshot = resolve;
    });
    const events: string[] = [];
    const options: SimulatorRuntimeOptions = {
      ...runtimeOptions(root),
      fetchFn: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/snapshots") && (init?.method ?? "GET") === "GET") {
          events.push("snapshot-started");
          observeSnapshot();
          await snapshotGate;
          events.push("snapshot-released");
        }
        if (/\/v1\/worlds\/[^/]+$/.test(path) && init?.method === "DELETE") {
          events.push("world-deleted");
        }
        return fetch(input, init);
      },
    };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    await runtime.start(problem(root));
    const snapshotPath = join(root, "race-snapshot.json");

    const exporting = runtime.exportSnapshot("hello-world", snapshotPath);
    await snapshotStarted;
    const stopping = runtime.stop("hello-world");
    await Promise.resolve();
    expect(events).toEqual(["snapshot-started"]);
    releaseSnapshot();
    await Promise.all([exporting, stopping]);

    expect(events).toEqual(["snapshot-started", "snapshot-released", "world-deleted"]);
    expect(readSimulatorSessionRecord(options.sessionPath).deployments).toEqual([]);
  });

  it("should serialize snapshot import with stop and clean both world generations", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-snapshot-import-stop-race-"));
    let releaseRestore = (): void => {};
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let observeRestore = (): void => {};
    const restoreStarted = new Promise<void>((resolve) => {
      observeRestore = resolve;
    });
    const options: SimulatorRuntimeOptions = {
      ...runtimeOptions(root),
      fetchFn: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/snapshots") && init?.method === "POST") {
          observeRestore();
          await restoreGate;
        }
        return fetch(input, init);
      },
    };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const deployment = await runtime.start(problem(root));
    const snapshotPath = join(root, "import-stop-race.json");
    await runtime.exportSnapshot(deployment.problemId, snapshotPath);

    const importing = runtime.importSnapshot(deployment.problemId, snapshotPath);
    await restoreStarted;
    let stopResolved = false;
    const stopping = runtime.stop(deployment.problemId).then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    releaseRestore();

    await expect(importing).resolves.toBeUndefined();
    await expect(stopping).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(join(options.stateDir, "worlds.json"), "utf8"))).toEqual([]);
    const recorded = readSimulatorSessionRecord(options.sessionPath);
    expect(recorded.deployments).toEqual([]);
    expect(recorded.pendingSnapshotRestores).toBeUndefined();
    expect(recorded.completedSnapshotRestores).toBeUndefined();
  });

  it("should advance clock and score once for concurrent explicit scoring", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-concurrent-score-"));
    const options = runtimeOptions(root);
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const state = createLocalPlayState(
      { problems: [], simulatedProblems: [phasedProblem(root)] },
      { simulator: runtime },
    );

    await handleLocalPlayRequest(post("/portal/me/problems/phased-battle/start"), state);
    const deployment = state.simulatedRuntimes.get("phased-battle")?.deployment;
    if (!deployment) throw new Error("phased deployment did not start");
    const scorePath = "/portal/me/problems/phased-battle/score";
    const now = deployment.clockObservedAtMs + 60_000;
    const [first, second] = await Promise.all([
      handleLocalPlayRequest(post(scorePath), state, now),
      handleLocalPlayRequest(post(scorePath), state, now),
    ]);

    expect(second).toEqual(first);
    const worlds = JSON.parse(
      readFileSync(join(options.stateDir, "worlds.json"), "utf8"),
    ) as Array<{ clockAdvances?: number[] }>;
    expect(worlds[0]?.clockAdvances).toEqual([60_000]);
  });

  it("should run initial scoring once for concurrent starts of one problem", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-concurrent-start-"));
    const options = runtimeOptions(root);
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const state = createLocalPlayState(
      { problems: [], simulatedProblems: [attackProbeProblem(root)] },
      { simulator: runtime },
    );
    const startPath = "/portal/me/problems/attack-probe-battle/start";

    const [first, second] = await Promise.all([
      handleLocalPlayRequest(post(startPath), state),
      handleLocalPlayRequest(post(startPath), state),
    ]);

    expect(first).toEqual({ status: StatusCodes.OK, body: { status: "running" } });
    expect(second).toEqual(first);
    expect(state.simulatedRuntimes.get("attack-probe-battle")?.score).toBe(100);
    const worlds = JSON.parse(
      readFileSync(join(options.stateDir, "worlds.json"), "utf8"),
    ) as Array<{ providerOperations?: Array<{ operation: string }> }>;
    expect(worlds[0]?.providerOperations?.map((operation) => operation.operation)).toEqual([
      "AttackProbe",
    ]);
  });

  it("should keep health probes on real HTTP and send attack probes through the authenticated provider command", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-attack-probe-"));
    const options = runtimeOptions(root);
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const state = createLocalPlayState(
      { problems: [], simulatedProblems: [attackProbeProblem(root)] },
      { simulator: runtime },
    );

    const started = await handleLocalPlayRequest(
      post("/portal/me/problems/attack-probe-battle/start"),
      state,
    );

    expect(started).toEqual({ status: StatusCodes.OK, body: { status: "running" } });
    expect(state.simulatedRuntimes.get("attack-probe-battle")?.score).toBe(100);
    const worlds = JSON.parse(
      readFileSync(join(options.stateDir, "worlds.json"), "utf8"),
    ) as Array<{
      providerOperations?: Array<{
        provider: string;
        operation: string;
        idempotencyKey: string;
        command: { input?: Record<string, unknown> };
      }>;
    }>;
    expect(worlds[0]?.providerOperations).toEqual([
      {
        provider: "aws",
        operation: "AttackProbe",
        idempotencyKey: expect.stringMatching(
          /^tenkacloud-internal-attack-probe-[A-Za-z0-9_-]{43}$/,
        ),
        command: expect.objectContaining({
          service: "http",
          resourceType: "HTTP::Endpoint",
          input: {
            TargetId: "default",
            Slot: "api",
            Path: "/api/v1/auth",
            Method: "POST",
            Body: '{"username":"\' OR \'1\'=\'1\' -- ","password":"x"}',
          },
        }),
      },
    ]);
  });

  it("should keep endpoint placement keys stable, secret, and immune to predictable poisoning", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-placement-key-"));
    const keys = new Map<string, string>();
    const describedKeys: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const operation = /\/operations\/([^/]+)$/.exec(url.pathname)?.[1];
      if (!operation) return fetch(input, init);
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      const body = String(init?.body ?? "");
      const prior = keys.get(key);
      if (prior && prior !== `${operation}:${body}`) {
        return new Response('{"error":{"code":"IdempotencyConflict"}}', {
          status: StatusCodes.CONFLICT,
        });
      }
      keys.set(key, `${operation}:${body}`);
      if (operation === "Poison") return Response.json({ poisoned: true });
      if (operation === "DescribeEndpointPlacement") {
        describedKeys.push(key);
        const command = JSON.parse(body) as {
          deploymentId: string;
          targetId: string;
          input: { Slot: string };
        };
        return Response.json({
          DeploymentId: command.deploymentId,
          TargetId: command.targetId,
          Slot: command.input.Slot,
          EffectiveUrl: "http://127.0.0.1:18080/workload",
          VerifiedPlatform: "ec2",
        });
      }
      return fetch(input, init);
    };
    const options = { ...runtimeOptions(root), fetchFn };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const deployment = await runtime.start(phasedProblem(root));
    const recorded = readSimulatorSessionRecord(options.sessionPath);
    const targetId = "default";
    const predictableKey = `scoring-placement:${deployment.deploymentId}:${targetId}:frontend`;
    await createSimulatorClient(
      recorded.launcher.baseUrl,
      fetchFn,
      deployment.launchToken,
    ).executeProviderOperation(
      deployment.worldId,
      "aws",
      "Poison",
      {
        deploymentId: deployment.deploymentId,
        targetId,
        engine: "cloudformation",
        service: "runtime",
        resourceType: "Runtime::Endpoint",
        input: { Slot: "frontend" },
      },
      predictableKey,
    );

    await expect(runtime.endpointPlacements(phasedProblem(root), ["frontend"], 1)).resolves.toEqual(
      [
        {
          slot: "frontend",
          effectiveUrl: "http://127.0.0.1:18080/workload",
          verifiedPlatform: "ec2",
        },
      ],
    );
    await runtime.endpointPlacements(phasedProblem(root), ["frontend"], 999_999);

    expect(describedKeys).toHaveLength(2);
    expect(describedKeys[0]).toBe(describedKeys[1]);
    expect(describedKeys[0]).toMatch(/^tenkacloud-internal-endpoint-placement-[A-Za-z0-9_-]{43}$/);
    expect(describedKeys[0]).not.toBe(predictableKey);
    const publicRecord = readFileSync(options.sessionPath, "utf8");
    expect(publicRecord).not.toContain(describedKeys[0] ?? "impossible-key");
    expect(publicRecord).not.toContain(recorded.launcher.launchSecret);
  });

  it("should fail loud on placement transport and malformed responses but allow exact 404", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-placement-errors-"));
    let mode: PlacementResponseMode = "unbound";
    const fetchFn = placementResponseFetch(() => mode);
    const options = { ...runtimeOptions(root), fetchFn };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const current = phasedProblem(root);
    await runtime.start(current);

    await expect(runtime.endpointPlacements(current, ["frontend"], 1)).resolves.toEqual([]);
    mode = "server-error";
    await expect(runtime.endpointPlacements(current, ["frontend"], 2)).rejects.toThrow("HTTP 500");
    mode = "malformed";
    await expect(runtime.endpointPlacements(current, ["frontend"], 3)).rejects.toThrow(
      "response is invalid",
    );
    mode = "credentials";
    await expect(runtime.endpointPlacements(current, ["frontend"], 4)).rejects.toThrow();
    mode = "partial";
    await expect(runtime.endpointPlacements(current, ["frontend", "secondary"], 5)).rejects.toThrow(
      "HTTP 500",
    );
  });

  it("should keep attack-scoring keys secret and immune to predictable poisoning", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-attack-key-"));
    const keys = new Map<string, string>();
    const attackKeys: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const operation = /\/operations\/([^/]+)$/.exec(url.pathname)?.[1];
      if (!operation) return fetch(input, init);
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      const body = String(init?.body ?? "");
      const prior = keys.get(key);
      if (prior && prior !== `${operation}:${body}`) {
        return new Response('{"error":{"code":"IdempotencyConflict"}}', {
          status: StatusCodes.CONFLICT,
        });
      }
      keys.set(key, `${operation}:${body}`);
      if (operation === "Poison") return Response.json({ poisoned: true });
      if (operation === "AttackProbe") {
        attackKeys.push(key);
        return Response.json({ StatusCode: StatusCodes.FORBIDDEN, Landed: false });
      }
      return fetch(input, init);
    };
    const options = { ...runtimeOptions(root), fetchFn };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const current = attackProbeProblem(root);
    const deployment = await runtime.start(current);
    const recorded = readSimulatorSessionRecord(options.sessionPath);
    const observedAtMs = 123_456;
    const request = {
      slot: "api",
      path: "/api/v1/auth",
      method: "POST" as const,
      body: '{"username":"admin"}',
    };
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const predictableKey = `scoring:${current.problemId}:${observedAtMs}:${requestHash}`;
    await createSimulatorClient(
      recorded.launcher.baseUrl,
      fetchFn,
      deployment.launchToken,
    ).executeProviderOperation(
      deployment.worldId,
      "aws",
      "Poison",
      {
        deploymentId: deployment.deploymentId,
        targetId: "default",
        engine: "cloudformation",
        service: "http",
        resourceType: "HTTP::Endpoint",
        input: { Slot: "api" },
      },
      predictableKey,
    );

    await expect(runtime.attackProbe(current, request, observedAtMs)).resolves.toMatchObject({
      ok: false,
      status: StatusCodes.FORBIDDEN,
    });
    expect(attackKeys).toHaveLength(1);
    expect(attackKeys[0]).toMatch(/^tenkacloud-internal-attack-probe-[A-Za-z0-9_-]{43}$/);
    expect(attackKeys[0]).not.toBe(predictableKey);
    expect(readFileSync(options.sessionPath, "utf8")).not.toContain(attackKeys[0] ?? "none");
  });
});

describe("Simulator data-plane listener lifecycle", () => {
  it("should retain a failed listener close and delete the world only after retry succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-listener-close-retry-"));
    let closeAttempts = 0;
    const events: string[] = [];
    const base = runtimeOptions(root);
    const options: SimulatorRuntimeOptions = {
      ...base,
      startDataPlaneListener: async () => ({
        port: 31_991,
        origin: "http://127.0.0.1:31991",
        close: async () => {
          closeAttempts += 1;
          events.push(`listener-close-${closeAttempts}`);
          if (closeAttempts === 1) throw new Error("injected listener close failure");
        },
      }),
      fetchFn: async (input, init) => {
        if (init?.method === "DELETE") events.push("world-delete");
        return fetch(input, init);
      },
    };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    await runtime.start(problem(root));

    await expect(runtime.stop("hello-world")).rejects.toThrow(
      "Simulator data-plane listener cleanup failed",
    );
    expect(events).toEqual(["listener-close-1"]);
    expect(readSimulatorSessionRecord(options.sessionPath).deployments).toHaveLength(1);

    await expect(runtime.stop("hello-world")).resolves.toBeUndefined();
    expect(events).toEqual(["listener-close-1", "listener-close-2", "world-delete"]);
    expect(readSimulatorSessionRecord(options.sessionPath).deployments).toEqual([]);
  });

  it("should serialize Stop behind listener creation and drain before world deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-listener-start-stop-"));
    let releaseListener = (): void => {};
    const listenerGate = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    let observeListener = (): void => {};
    const listenerStarted = new Promise<void>((resolve) => {
      observeListener = resolve;
    });
    const events: string[] = [];
    const base = runtimeOptions(root);
    const options: SimulatorRuntimeOptions = {
      ...base,
      startDataPlaneListener: async () => {
        events.push("listener-started");
        observeListener();
        await listenerGate;
        events.push("listener-published");
        return {
          port: 31_992,
          origin: "http://127.0.0.1:31992",
          close: async () => {
            events.push("listener-drained");
          },
        };
      },
      fetchFn: async (input, init) => {
        if (init?.method === "DELETE") events.push("world-deleted");
        return fetch(input, init);
      },
    };
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);

    const starting = runtime.start(problem(root)).then((value) => {
      events.push("start-complete");
      return value;
    });
    await listenerStarted;
    const stopping = runtime.stop("hello-world");
    await Promise.resolve();
    expect(events).toEqual(["listener-started"]);
    releaseListener();
    await Promise.all([starting, stopping]);
    expect(events).toEqual([
      "listener-started",
      "listener-published",
      "start-complete",
      "listener-drained",
      "world-deleted",
    ]);
  });
});

describe("Simulator generic scoring bridge", () => {
  it("should score only authoritative managed placements and award the distinct bonus once", async () => {
    const workload = await workloadServer();
    try {
      const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
      const current = loadSimulatedCloudProblems([
        join(repositoryRoot, "problems", "battles"),
      ]).find((candidate) => candidate.problemId === "microservice-migration-battle");
      if (!current) throw new Error("current migration battle was not loaded");
      const scoring = current.metadata.scoring as Record<string, unknown>;
      const battle: SimulatedCloudProblem = {
        ...current,
        metadata: {
          ...current.metadata,
          scoring: {
            ...scoring,
            bonuses: [
              {
                kind: "all-slots-distinct-platforms",
                platforms: ["lambda", "ecs", "apprunner"],
                points: 5_000,
                once: true,
              },
            ],
          },
        },
      };
      const placements = [
        { slot: "users", effectiveUrl: `${workload.url}/users`, verifiedPlatform: "lambda" },
        { slot: "orders", effectiveUrl: `${workload.url}/orders`, verifiedPlatform: "ecs" },
        {
          slot: "catalog",
          effectiveUrl: `${workload.url}/catalog`,
          verifiedPlatform: "apprunner",
        },
      ] as const;
      const base = {
        problem: battle,
        outputs: { BaseUrl: "http://127.0.0.1:1/untrusted" },
        overrides: new Map([
          ["users", "http://127.0.0.1:2/spoofed"],
          ["orders", "http://127.0.0.1:2/spoofed"],
          ["catalog", "http://127.0.0.1:2/spoofed"],
        ]),
        score: 0,
        createdAt: "2026-07-12T00:00:00.000Z",
        nowMs: Date.UTC(2026, 6, 12, 0, 1),
        authoritativeEndpointPlacements: placements,
      } as const;

      const first = await runSimulatorScoreCycle({ ...base, scoringState: {} });
      expect(first.scoreDelta).toBe(8_000);
      expect(first.newState?.bonusAwarded).toMatchObject({
        "all-slots-distinct-platforms": true,
      });
      const second = await runSimulatorScoreCycle({
        ...base,
        scoringState: first.newState ?? {},
      });
      expect(second.scoreDelta).toBe(3_000);

      const unbound = await runSimulatorScoreCycle({
        ...base,
        scoringState: {},
        authoritativeEndpointPlacements: [],
      });
      expect(unbound.scoreDelta).toBe(-300);
    } finally {
      await workload.close();
    }
  });

  it("should reject a participant-controlled loopback managed-tier self-report", async () => {
    const spoofedLambda = await platformWorkloadServer("lambda");
    try {
      const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
      const battle = loadSimulatedCloudProblems([join(repositoryRoot, "problems", "battles")]).find(
        (problem) => problem.problemId === "microservice-migration-battle",
      );
      if (!battle) throw new Error("current migration battle was not loaded");
      const cycleInput = {
        problem: battle,
        outputs: { BaseUrl: spoofedLambda.url },
        overrides: new Map([
          ["users", `${spoofedLambda.url}/users`],
          ["orders", `${spoofedLambda.url}/orders`],
          ["catalog", `${spoofedLambda.url}/catalog`],
        ]),
        score: 0,
        createdAt: "2026-07-12T00:00:00.000Z",
        scoringState: {},
        nowMs: Date.UTC(2026, 6, 12, 0, 1),
      } as const;

      const result = await runSimulatorScoreCycle(cycleInput);
      expect(result.scoreDelta).toBe(300);
      expect(result.platform).toBe("ec2");
      expect(result.newState).toBeUndefined();
    } finally {
      await spoofedLambda.close();
    }
  });

  it("should run composite target probes over real HTTP and award the catalog points once", async () => {
    const aws = await workloadServer();
    const gcp = await workloadServer();
    try {
      const root = mkdtempSync(join(tmpdir(), "tc-simulator-composite-score-"));
      const composite: SimulatedCloudProblem = {
        problemId: "hello-multicloud",
        name: "Hello Multicloud",
        category: "challenges",
        description: "Two providers.",
        instructions: "Probe both endpoints.",
        problemDir: root,
        runtime: {
          kind: "composite",
          targets: [
            { id: "aws-hello", provider: "aws", engine: "cloudformation", entry: "template.yaml" },
            { id: "gcp-hello", provider: "gcp", engine: "infra-manager", entry: "gcp/terraform" },
          ],
        },
        templateBody: "{}",
        metadata: {
          scoring: {
            kind: "composite-probe",
            success: "all",
            pointsAllOk: 100,
            targets: [
              {
                targetId: "aws-hello",
                probe: "https",
                outputKey: "AwsHelloUrl",
                expectStatus: [StatusCodes.OK],
              },
              {
                targetId: "gcp-hello",
                probe: "https",
                outputKey: "GcpHelloUrl",
                expectStatus: [StatusCodes.OK],
              },
            ],
          },
        },
      };
      const result = await runSimulatorScoreCycle({
        problem: composite,
        outputs: {
          "aws-hello.AwsHelloUrl": aws.url,
          "gcp-hello.GcpHelloUrl": gcp.url,
        },
        overrides: new Map(),
        score: 0,
        createdAt: "2026-07-12T00:00:00.000Z",
        scoringState: {},
        nowMs: Date.UTC(2026, 6, 12, 0, 1),
      });

      expect(result.scoreDelta).toBe(100);
      expect(result.lastResult).toBe("ok");
    } finally {
      await Promise.all([aws.close(), gcp.close()]);
    }
  });

  it("should run the existing uptime engine against a real loopback workload", async () => {
    const workload = await workloadServer();
    try {
      const root = mkdtempSync(join(tmpdir(), "tc-simulator-uptime-score-"));
      const battle: SimulatedCloudProblem = {
        problemId: "generic-uptime",
        name: "Generic Uptime",
        category: "battles",
        description: "Keep the endpoint healthy.",
        instructions: "Return success.",
        problemDir: root,
        runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
        templateBody: "Resources: {}",
        metadata: {
          scoring: {
            kind: "uptime-flat",
            endpoints: [{ slot: "frontend", path: "/", expectStatus: [StatusCodes.OK] }],
            pointsPerSuccess: 100,
            failurePenalty: -100,
          },
          endpoints: [
            {
              slot: "frontend",
              default: { from: "cfn-output", key: "FrontendUrl" },
              overridable: true,
            },
          ],
        },
      };
      const result = await runSimulatorScoreCycle({
        problem: battle,
        outputs: { FrontendUrl: workload.url },
        overrides: new Map(),
        score: 0,
        createdAt: "2026-07-12T00:00:00.000Z",
        scoringState: {},
        nowMs: Date.UTC(2026, 6, 12, 0, 1),
      });

      expect(result.scoreDelta).toBe(100);
      expect(result.lastResult).toBe("ok");
      expect(JSON.parse(result.endpointsHealthJson ?? "{}")).toMatchObject({
        frontend: { ok: true },
      });
    } finally {
      await workload.close();
    }
  });
});
