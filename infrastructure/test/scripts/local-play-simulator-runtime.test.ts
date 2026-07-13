import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it } from "vitest";
import { handleLocalPlayRequest } from "../../../scripts/local-play/api";
import { createLocalPlayState, type LocalPlayRequest } from "../../../scripts/local-play/api-state";
import { waitForReachable } from "../../../scripts/local-play/docker-adapter";
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
} from "../../../scripts/local-play/simulator-auth";
import {
  DEFAULT_SIMULATOR_IMAGE,
  launchSimulator,
  resolveSimulatorSource,
  stopSimulatorLauncher,
} from "../../../scripts/local-play/simulator-launcher";
import {
  cleanupRecordedSimulatorSession,
  SimulatorLocalRuntime,
  type SimulatorRuntimeOptions,
  type SimulatorSessionRecord,
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
  it("応答しない Simulator 呼び出しを有限時間で中断する", async () => {
    const client = createSimulatorClient(
      "http://127.0.0.1:7777",
      () => new Promise<Response>(() => {}),
      undefined,
      10,
    );

    await expect(client.capabilities()).rejects.toThrow("timed out after 10ms");
  });

  it("header 後に停止した Simulator response body も有限時間で中断する", async () => {
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

  it("should select the reviewed immutable image when no explicit source is configured", () => {
    expect(resolveSimulatorSource({})).toEqual({
      kind: "container",
      image: DEFAULT_SIMULATOR_IMAGE,
    });
    expect(DEFAULT_SIMULATOR_IMAGE).toBe(
      "ghcr.io/susumutomita/tenkacloud-simulator@sha256:0b8de36893513ffcf93db60a60e35849b3e592c08099adae2f0730a9f7fd1c9c",
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
  it("Simulator console URL が launcher と同一 loopback origin でなければ永続化前に拒否する", async () => {
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

  it("準備不能な記録済み launcher を停止済みとして記録し次回起動で置き換える", async () => {
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
    writeFileSync(options.sessionPath, JSON.stringify(stale));

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

  it("記録済み cleanup は全 world を試し失敗分だけを再試行可能な状態で残す", async () => {
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
    const deployments = ["deleted", "retry"].map((problemId) => ({
      problemId,
      worldId: `world-${problemId}`,
      deploymentId: `deployment-${problemId}`,
      launchToken: `token-${problemId}`,
      status: "running" as const,
      outputs: {},
      consoleUrl: `http://127.0.0.1:42123/console/${problemId}`,
      nativeCredentials: launcher.nativeCredentials,
      clockObservedAtMs: 1,
    }));
    writeFileSync(
      options.sessionPath,
      JSON.stringify({ protocolVersion: "2026-07-11", launcher, deployments }),
    );
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

  it("owned launcher は world 削除失敗中に停止せず次回 cleanup で残りを再試行する", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-owned-cleanup-retry-"));
    const options = runtimeOptions(root);
    const launcher = await launchSimulator(options);
    if (launcher.kind !== "process" || launcher.pid === undefined) {
      throw new Error("test requires an owned process launcher");
    }
    const deployment = {
      problemId: "retry",
      worldId: "world-retry",
      deploymentId: "deployment-retry",
      launchToken: "token-retry",
      status: "running" as const,
      outputs: {},
      consoleUrl: `${launcher.baseUrl}/console/retry`,
      nativeCredentials: launcher.nativeCredentials,
      clockObservedAtMs: 1,
    };
    writeFileSync(
      options.sessionPath,
      JSON.stringify({
        protocolVersion: "2026-07-11",
        launcher,
        deployments: [deployment],
      } satisfies SimulatorSessionRecord),
    );
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
    } finally {
      stopSimulatorLauncher(launcher, options.env);
    }
  });

  it("runtime close は一つの world 削除失敗で残りの cleanup を打ち切らない", async () => {
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
    const deployments = ["one", "two"].map((problemId) => ({
      problemId,
      worldId: `world-${problemId}`,
      deploymentId: `deployment-${problemId}`,
      launchToken: `token-${problemId}`,
      status: "running" as const,
      outputs: {},
      consoleUrl: `http://127.0.0.1:42123/console/${problemId}`,
      nativeCredentials,
      clockObservedAtMs: 1,
    }));
    writeFileSync(
      options.sessionPath,
      JSON.stringify({
        protocolVersion: "2026-07-11",
        launcher: {
          kind: "external",
          baseUrl: "http://127.0.0.1:42123",
          launchSecret,
          nativeCredentials,
        },
        deployments,
      } satisfies SimulatorSessionRecord),
    );
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

  it("launcher 停止自体が失敗した場合は生存確認を経ず置換済みと記録しない", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-simulator-close-launcher-failure-"));
    const options = runtimeOptions(root);
    const nativeCredentials = {
      awsAccessKeyId: "TCSIM12345678901",
      awsSecretAccessKey: "tcsim_1234567890123456",
      azureCredential: "tcsim_1234567890123456",
      gcpCredential: "tcsim_1234567890123456",
      sakuraCredential: "tcsim_1234567890123456:tcsim_abcdefghijklmnop",
    };
    writeFileSync(
      options.sessionPath,
      JSON.stringify({
        protocolVersion: "2026-07-11",
        launcher: {
          kind: "container",
          baseUrl: "http://127.0.0.1:42123",
          launchSecret: createSimulatorLaunchSecret(),
          nativeCredentials,
          containerName: "simulator-stop-must-fail",
        },
        deployments: [],
      } satisfies SimulatorSessionRecord),
    );
    const runtime = new SimulatorLocalRuntime({
      ...options,
      env: { ...options.env, TENKACLOUD_SIMULATOR_DOCKER_CLI: "/usr/bin/false" },
    });

    await expect(runtime.close()).rejects.toThrow("Simulator cleanup failed");
    expect(JSON.parse(readFileSync(options.sessionPath, "utf8"))).not.toHaveProperty(
      "launcherNeedsReplacement",
    );
  });

  it("対応外の cloud scoring kind は world 作成前の state 構築で拒否する", () => {
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

  it("composite-probe の hint を participant view に公開する", async () => {
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
  });

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
      await waitForReachable(
        `${launcher.baseUrl}/v1/capabilities`,
        "Simulator credential inheritance fixture",
        3_000,
      );
      const capabilities = (await (await fetch(`${launcher.baseUrl}/v1/capabilities`)).json()) as {
        inheritedHostCredentials?: readonly string[];
      };
      expect(capabilities.inheritedHostCredentials).toEqual([]);
    } finally {
      stopSimulatorLauncher(launcher, options.env);
    }
  });

  it("解決済みの Simulator flag と composite challenge を完了数に含めること", async () => {
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

  it("同じ問題への明示採点が重なっても時計と得点を一度だけ進めること", async () => {
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

  it("同じ問題への start が重なっても初回採点を一度だけ実行すること", async () => {
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
