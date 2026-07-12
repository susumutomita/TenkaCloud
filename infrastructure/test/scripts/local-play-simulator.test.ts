import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSimulatorCapabilityReport,
  createSimulatorClient,
  isSimulatorRuntime,
  listSimulatedCloudProblems,
  SIMULATOR_PROTOCOL_VERSION,
} from "../../../scripts/local-play/simulator";

function writeProblem(root: string, id: string, metadata: unknown, entry = "template.yaml") {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(metadata));
  mkdirSync(join(dir, entry, ".."), { recursive: true });
  writeFileSync(join(dir, entry), "Resources: {}\n");
}

describe("local-play simulator catalog scanner", () => {
  it("should list cloud runtimes that can be delegated to TenkaCloud Simulator", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-sim-"));
    writeProblem(root, "aws-iam", {
      name: "AWS IAM",
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    });
    writeProblem(
      root,
      "docker-only",
      {
        name: "Docker",
        runtime: { provider: "docker", engine: "compose", entry: "local/docker-compose.yml" },
      },
      "local/docker-compose.yml",
    );

    expect(listSimulatedCloudProblems([root])).toEqual([
      {
        problemId: "aws-iam",
        name: "AWS IAM",
        category: root.split("/").at(-1),
        runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
      },
    ]);
  });

  it("should build a capability report from required runtime operations", () => {
    const report = buildSimulatorCapabilityReport(
      [{ provider: "aws", engine: "cloudformation", entry: "template.yaml" }],
      {
        protocolVersion: SIMULATOR_PROTOCOL_VERSION,
        providers: { aws: { engines: { cloudformation: { operations: ["deploy", "delete"] } } } },
      },
    );

    expect(report.supported).toBe(true);
    expect(report.requirements).toEqual([
      {
        provider: "aws",
        engine: "cloudformation",
        entry: "template.yaml",
        operation: "deploy",
        supported: true,
      },
    ]);
  });

  it("should fail loud when a required provider operation is missing", () => {
    const report = buildSimulatorCapabilityReport(
      [{ provider: "sakura", engine: "apprun", entry: "app.yaml" }],
      { protocolVersion: SIMULATOR_PROTOCOL_VERSION, providers: {} },
    );

    expect(report.supported).toBe(false);
    expect(report.requirements[0]).toMatchObject({
      provider: "sakura",
      engine: "apprun",
      operation: "deploy",
      supported: false,
      diagnostic: "NotImplemented: sakura/apprun deploy is not advertised by the simulator",
    });
  });

  it("should create worlds and deployments through the versioned protocol", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createSimulatorClient(
      "http://127.0.0.1:7777",
      async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/v1/worlds")) {
          return new Response(
            JSON.stringify({ worldId: "w1", consoleUrl: "http://127.0.0.1:7777/console/w1" }),
          );
        }
        return new Response(
          JSON.stringify({
            deploymentId: "d1",
            status: "running",
            outputs: { Console: "http://127.0.0.1:7777/console/w1" },
          }),
        );
      },
      "launch-token",
    );

    const world = await client.createWorld({
      tenantId: "local",
      eventId: "local",
      teamId: "team",
      deploymentId: "dep",
    });
    const deployment = await client.createDeployment(world.worldId, {
      problemId: "aws-iam",
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
      templateBody: "Resources: {}\n",
    });

    expect(world.consoleUrl).toBe("http://127.0.0.1:7777/console/w1");
    expect(deployment.status).toBe("running");
    expect(calls.map((c) => [c.url, c.init?.method])).toEqual([
      ["http://127.0.0.1:7777/v1/worlds", "POST"],
      ["http://127.0.0.1:7777/v1/worlds/w1/deployments", "POST"],
    ]);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer launch-token");
  });

  it("should require authentication and validate the clock advance response contract", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createSimulatorClient(
      "http://127.0.0.1:7777",
      async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            clock: "2026-07-12T00:00:01.500Z",
            appliedTransitions: [{ provider: "aws", transitionId: "ssm-command:revert" }],
          }),
        );
      },
      "clock-token",
    );

    await expect(client.advanceClock("world/one", 1_500)).resolves.toEqual({
      clock: "2026-07-12T00:00:01.500Z",
      appliedTransitions: [{ provider: "aws", transitionId: "ssm-command:revert" }],
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:7777/v1/worlds/world%2Fone/clock/advance");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer clock-token");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ milliseconds: 1_500 }));

    const unauthenticated = createSimulatorClient("http://127.0.0.1:7777", fetch);
    await expect(unauthenticated.advanceClock("world", 1)).rejects.toThrow("launch token");
    await expect(client.advanceClock("world", 0)).rejects.toThrow("positive safe integer");
  });

  it("should classify simulator-supported runtimes", () => {
    expect(
      isSimulatorRuntime({ provider: "aws", engine: "cloudformation", entry: "template.yaml" }),
    ).toBe(true);
    expect(
      isSimulatorRuntime({
        provider: "docker",
        engine: "compose",
        entry: "local/docker-compose.yml",
      }),
    ).toBe(false);
  });
});
