import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it } from "vitest";
import { handleLocalPlayRequest } from "../../../scripts/local-play/api";
import { createLocalPlayState, type LocalPlayRequest } from "../../../scripts/local-play/api-state";
import { waitForReachable } from "../../../scripts/local-play/docker-adapter";
import {
  loadSimulatedCloudProblems,
  type SimulatedCloudProblem,
  simulatorTemplateBody,
} from "../../../scripts/local-play/simulator";
import {
  createSimulatorLaunchSecret,
  decodeSimulatorLaunchSecret,
  issueSimulatorLaunchToken,
} from "../../../scripts/local-play/simulator-auth";
import {
  DEFAULT_SIMULATOR_IMAGE,
  launchSimulator,
  resolveSimulatorSource,
  stopSimulatorLauncher,
} from "../../../scripts/local-play/simulator-launcher";
import {
  SimulatorLocalRuntime,
  type SimulatorRuntimeOptions,
} from "../../../scripts/local-play/simulator-runtime";
import { runSimulatorScoreCycle } from "../../../scripts/local-play/simulator-scoring";

const PROCESS_FIXTURE = resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "simulator-conformance-process.mjs",
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

describe("Simulator launch authorization", () => {
  it("should select the reviewed immutable image when no explicit source is configured", () => {
    expect(resolveSimulatorSource({})).toEqual({
      kind: "container",
      image: DEFAULT_SIMULATOR_IMAGE,
    });
    expect(DEFAULT_SIMULATOR_IMAGE).toBe(
      "ghcr.io/susumutomita/tenkacloud-simulator@sha256:8e9ab4b3da59b268b12174251d10022bc2fd1ecea88b6cdc497820a6ae942f91",
    );
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
  it("should launch a real process, drive portal lifecycle, persist, snapshot, and delete the world", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-runtime-"));
    const options = runtimeOptions(root);
    const runtime = new SimulatorLocalRuntime(options);
    runningRuntimes.push(runtime);
    const state = createLocalPlayState(
      { problems: [], simulatedProblems: [problem(root)] },
      { simulator: runtime },
    );

    const started = await handleLocalPlayRequest(
      post("/portal/me/problems/hello-world/start"),
      state,
    );
    expect(started.body).toEqual({ status: "running" });

    const team = await handleLocalPlayRequest(
      { method: "GET", path: "/portal/me", query: {}, body: undefined },
      state,
    );
    const view = (team.body as { problems: Array<{ stackOutputs: Record<string, string> }> })
      .problems[0];
    expect(view.stackOutputs.ParameterName).toBe("/local/hello");
    expect(view.stackOutputs).not.toHaveProperty("ParameterValue");
    expect(view.stackOutputs.SimulatorConsoleUrl).toContain("#token=tc_sim_v1.");
    expect(view.stackOutputs.SimulatorAwsAccessKeyId).toMatch(/^TCSIM[A-Z0-9]{11}$/);
    expect(statSync(options.sessionPath).mode & 0o777).toBe(0o600);
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

    const snapshotPath = join(root, "snapshot.json");
    await runtime.exportSnapshot("hello-world", snapshotPath);
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toMatchObject({
      protocolVersion: "2026-07-11",
      namespace: { tenantId: "local", eventId: "local", teamId: "local" },
    });
    await runtime.importSnapshot("hello-world", snapshotPath);
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

  it("should launch and stop an injected executable without a shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-process-"));
    const launcher = await launchSimulator(runtimeOptions(root));
    try {
      expect(launcher.kind).toBe("process");
      expect(launcher.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(launcher.launchSecret).not.toContain("=");
    } finally {
      stopSimulatorLauncher(launcher);
    }
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
      stopSimulatorLauncher(launcher);
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
        idempotencyKey: expect.stringMatching(/^scoring:attack-probe-battle:/),
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
});

describe("Simulator generic scoring bridge", () => {
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
