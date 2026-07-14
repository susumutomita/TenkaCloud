import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import {
  buildSimulatorCapabilityReport,
  createSimulatorClient,
  enabledSimulatedCloudProblems,
  enabledSimulatedCloudSummaries,
  isSimulatorEnabled,
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
        if (String(url).includes("/v1/worlds/by-deployment/")) {
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
    const recoveredWorld = await client.getWorldByDeployment("dep");
    const deployment = await client.createDeployment(world.worldId, {
      problemId: "aws-iam",
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
      templateBody: "Resources: {}\n",
    });

    expect(world.consoleUrl).toBe("http://127.0.0.1:7777/console/w1");
    expect(recoveredWorld).toEqual(world);
    expect(deployment.status).toBe("running");
    expect(calls.map((c) => [c.url, c.init?.method])).toEqual([
      ["http://127.0.0.1:7777/v1/worlds", "POST"],
      ["http://127.0.0.1:7777/v1/worlds/by-deployment/dep", undefined],
      ["http://127.0.0.1:7777/v1/worlds/w1/deployments", "POST"],
    ]);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer launch-token");
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe("dep");
    expect(new Headers(calls[1]?.init?.headers).get("idempotency-key")).toBe("dep");
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

  it("should redact reflected secrets from delete-world failures", async () => {
    const reflectedSecret = "tc_sim_v1.reflected-delete-secret";
    const client = createSimulatorClient(
      "http://127.0.0.1:7777",
      async () => new Response(reflectedSecret, { status: StatusCodes.BAD_GATEWAY }),
      "launch-token",
    );

    const message = await client.deleteWorld("world").then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(message).toBe("delete world failed (HTTP 502)");
    expect(message).not.toContain(reflectedSecret);
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

describe("simulated-cloud feature flag (default off, Issue #2632)", () => {
  it("should be disabled by default when the flag is unset", () => {
    expect(isSimulatorEnabled({})).toBe(false);
  });

  it("should stay disabled for falsy or unrelated flag values", () => {
    for (const raw of ["", "0", "false", "no", "off", "yes", "enable"]) {
      expect(isSimulatorEnabled({ TENKACLOUD_LOCAL_SIMULATOR: raw })).toBe(false);
    }
  });

  it("should enable only for an explicit 1 / true opt-in, tolerating case and whitespace", () => {
    for (const raw of ["1", "true", "TRUE", "  true  ", "True"]) {
      expect(isSimulatorEnabled({ TENKACLOUD_LOCAL_SIMULATOR: raw })).toBe(true);
    }
  });

  it("should hide catalog summaries of existing simulated problems while the flag is off", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-sim-flag-"));
    writeProblem(root, "aws-iam", {
      name: "AWS IAM",
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    });
    // The problem exists on disk...
    expect(listSimulatedCloudProblems([root])).toHaveLength(1);
    // ...but the gated accessor hides it when the flag is unset.
    expect(enabledSimulatedCloudSummaries([root], {})).toEqual([]);
    // ...and surfaces it once the operator opts in.
    expect(
      enabledSimulatedCloudSummaries([root], { TENKACLOUD_LOCAL_SIMULATOR: "1" }),
    ).toHaveLength(1);
  });

  it("should return no loadable simulated problems while the flag is off", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-sim-flag-"));
    writeProblem(root, "aws-iam", {
      name: "AWS IAM",
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    });
    expect(enabledSimulatedCloudProblems([root], {})).toEqual([]);
    // With the flag on, the accessor delegates to the real loader (empty roots => empty catalog).
    expect(enabledSimulatedCloudProblems([], { TENKACLOUD_LOCAL_SIMULATOR: "1" })).toEqual([]);
  });
});
