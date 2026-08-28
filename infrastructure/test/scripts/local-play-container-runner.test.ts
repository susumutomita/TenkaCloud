import { describe, expect, it, vi } from "vitest";
import {
  ContainerRunner,
  type ContainerRunnerDeps,
} from "../../../scripts/local-play/container-runner";
import type { ContainerProblem } from "../../../scripts/local-play/manifest";

const COMPOSE = [
  "services:",
  "  app:",
  "    ports:",
  '      - "127.0.0.1:18080:8080"',
  '      - "127.0.0.1:18081:8081"',
].join("\n");

const problem = (): ContainerProblem =>
  ({
    problemId: "sqli-demo",
    name: "SQLi",
    description: "",
    instructions: "Attack http://127.0.0.1:18080/login.",
    problemDir: "/p/sqli-demo",
    composePath: "/p/sqli-demo/local/docker-compose.yml",
    composeProjectName: "tc-local-sqli-demo",
    challengeEndpoints: { Web: "http://127.0.0.1:18080/" },
    verifyUrl: "http://127.0.0.1:18081/verify",
    secretEnv: ["FLAG_SEED"],
    scoring: { kind: "verify", points: 100, wrongAnswerPenalty: 0, hints: [] },
  }) as ContainerProblem;

function makeDeps(over: Partial<ContainerRunnerDeps> = {}) {
  const compose: Array<[string, string, string, string | undefined]> = [];
  const composeEnvs: NodeJS.ProcessEnv[] = [];
  const reached: string[] = [];
  const temps: Array<[string, string]> = [];
  const removed: string[] = [];
  const deps: ContainerRunnerDeps = {
    runCompose: vi.fn((composePath, _p, action, env, _a, projectDirectory) => {
      compose.push([action, composePath, _p, projectDirectory]);
      composeEnvs.push(env);
    }),
    waitForReachable: vi.fn(async (url: string) => {
      reached.push(url);
    }),
    generateSecretEnv: vi.fn(() => ({ FLAG_SEED: "secret" })),
    readCompose: vi.fn(() => COMPOSE),
    writeTempCompose: vi.fn((path: string, content: string) => temps.push([path, content])),
    removeTempCompose: vi.fn((path: string) => removed.push(path)),
    log: vi.fn(),
    ...over,
  };
  return { deps, compose, composeEnvs, reached, temps, removed };
}

describe("ContainerRunner: start (#2392 Phase 2)", () => {
  it("should run offset 0 from the original compose with no temp file", async () => {
    const { deps, compose, reached, temps } = makeDeps();
    const runner = new ContainerRunner("/local", deps);
    const started = await runner.start(problem(), 0);
    expect(temps).toEqual([]); // no remapped copy at offset 0
    expect(compose).toEqual([
      ["up", "/p/sqli-demo/local/docker-compose.yml", "tc-local-sqli-demo", undefined],
    ]);
    expect(reached).toEqual(["http://127.0.0.1:18081/verify", "http://127.0.0.1:18080/"]);
    expect(started.problem.challengeEndpoints).toEqual({ Web: "http://127.0.0.1:18080/" });
    expect(started.problem.verifyUrl).toBe("http://127.0.0.1:18081/verify");
    expect(started.unit).toMatchObject({
      offset: 0,
      composePath: "/p/sqli-demo/local/docker-compose.yml",
    });
    expect(started.unit.remappedComposePath).toBeUndefined();
  });

  it("should run a later offset from a remapped temp compose with --project-directory", async () => {
    const { deps, compose, reached, temps } = makeDeps();
    const runner = new ContainerRunner("/local", deps);
    const started = await runner.start(problem(), 100);
    // temp compose written with remapped ports
    expect(temps).toHaveLength(1);
    expect(temps[0][0]).toBe("/local/tc-local-sqli-demo.compose.yml");
    expect(temps[0][1]).toContain('"127.0.0.1:18180:8080"');
    // compose up runs from the temp file with the original dir as project-directory
    expect(compose).toEqual([
      ["up", "/local/tc-local-sqli-demo.compose.yml", "tc-local-sqli-demo", "/p/sqli-demo/local"],
    ]);
    // waits on the remapped verifier and challenge surface; returned URLs follow the offset
    expect(reached).toEqual(["http://127.0.0.1:18181/verify", "http://127.0.0.1:18180/"]);
    expect(started.problem.challengeEndpoints).toEqual({ Web: "http://127.0.0.1:18180/" });
    expect(started.problem.verifyUrl).toBe("http://127.0.0.1:18181/verify");
    // The instructions prose moves onto the same block as the surface it quotes.
    expect(started.problem.instructions).toBe("Attack http://127.0.0.1:18180/login.");
    expect(started.unit).toMatchObject({
      offset: 100,
      composePath: "/local/tc-local-sqli-demo.compose.yml",
      projectDirectory: "/p/sqli-demo/local",
      remappedComposePath: "/local/tc-local-sqli-demo.compose.yml",
    });
  });

  it("should commit ownership before compose up can create the project", async () => {
    const events: string[] = [];
    const { deps } = makeDeps({
      runCompose: vi.fn((_path, _project, action) => {
        events.push(action);
        if (action === "up") expect(events[0]).toBe("acquire");
      }),
    });
    const runner = new ContainerRunner("/local", deps);
    const cleanupFailedStart = vi.fn();

    await runner.start(problem(), 100, {
      acquire: () => events.push("acquire"),
      cleanupFailedStart,
    });

    expect(events).toEqual(["acquire", "up"]);
    expect(cleanupFailedStart).not.toHaveBeenCalled();
  });

  it("should release the durable handle when a compose start fails", async () => {
    const events: string[] = [];
    const { deps } = makeDeps({
      runCompose: vi.fn((_path, _project, action) => {
        events.push(action);
        if (action === "up") throw new Error("docker up failed");
      }),
    });
    const runner = new ContainerRunner("/local", deps);

    await expect(
      runner.start(problem(), 100, {
        acquire: () => events.push("acquire"),
        cleanupFailedStart: () => events.push("release"),
      }),
    ).rejects.toThrow("docker up failed");
    expect(events).toEqual(["acquire", "up", "release"]);
  });

  it("should propagate a compose-up failure (lifecycle marks it error)", async () => {
    const { deps } = makeDeps({
      runCompose: vi.fn((_path, _project, action) => {
        if (action === "up") throw new Error("docker up failed");
      }),
    });
    const runner = new ContainerRunner("/local", deps);
    await expect(runner.start(problem(), 0)).rejects.toThrow(/docker up failed/);
  });

  it("should append owned-container diagnostics to an endpoint readiness failure", async () => {
    const diagnoseComposeUnit = vi.fn(() =>
      [
        "Container diagnostics for tc-local-sqli-demo:",
        "- app: state=exited, health=none, exit=1",
        "Logs (tail) for app:",
        "database failed",
      ].join("\n"),
    );
    const { deps } = makeDeps({
      waitForReachable: vi.fn(async () => {
        throw new Error("Timed out waiting for challenge endpoint Web");
      }),
      diagnoseComposeUnit,
    });
    const runner = new ContainerRunner("/local", deps);

    await expect(runner.start(problem(), 0)).rejects.toThrow(
      /Timed out waiting for challenge endpoint Web[\s\S]*app: state=exited/,
    );
    expect(diagnoseComposeUnit).toHaveBeenCalledWith(
      expect.objectContaining({
        problemId: "sqli-demo",
        composeProjectName: "tc-local-sqli-demo",
      }),
      ["secret"],
    );
  });

  it("should compose down and remove a remapped file when readiness fails", async () => {
    const { deps, compose, removed } = makeDeps({
      waitForReachable: vi.fn(async () => {
        throw new Error("readiness failed");
      }),
    });
    const runner = new ContainerRunner("/local", deps);

    await expect(runner.start(problem(), 100)).rejects.toThrow("readiness failed");
    expect(compose.map(([action]) => action)).toEqual(["up", "down"]);
    expect(removed).toEqual(["/local/tc-local-sqli-demo.compose.yml"]);
  });

  it("should preserve the readiness error when diagnostic collection itself fails", async () => {
    const { deps } = makeDeps({
      waitForReachable: vi.fn(async () => {
        throw new Error("readiness failed");
      }),
      diagnoseComposeUnit: vi.fn(() => {
        throw new Error("docker inspect failed");
      }),
    });
    const runner = new ContainerRunner("/local", deps);

    await expect(runner.start(problem(), 0)).rejects.toThrow("readiness failed");
  });
});

describe("ContainerRunner: recover (#3016)", () => {
  it("should rebuild remapped URLs from a recorded offset without starting compose", async () => {
    const remapped = COMPOSE.replaceAll(":18080:", ":19080:").replaceAll(":18081:", ":19081:");
    const { deps, compose, reached } = makeDeps({
      readCompose: vi.fn((path: string) =>
        path === "/local/tc-local-sqli-demo.compose.yml" ? remapped : COMPOSE,
      ),
    });
    const runner = new ContainerRunner("/local", deps);
    const recovered = await runner.recover(problem(), {
      problemId: "sqli-demo",
      offset: 1000,
      composePath: "/local/tc-local-sqli-demo.compose.yml",
      composeProjectName: "tc-local-sqli-demo",
      secretEnv: ["FLAG_SEED"],
      projectDirectory: "/p/sqli-demo/local",
      remappedComposePath: "/local/tc-local-sqli-demo.compose.yml",
    });

    expect(recovered.offset).toBe(1000);
    expect(recovered.started.unit.offset).toBe(1000);
    expect(recovered.started.problem.challengeEndpoints.Web).toBe("http://127.0.0.1:19080/");
    expect(recovered.started.problem.verifyUrl).toBe("http://127.0.0.1:19081/verify");
    expect(recovered.started.problem.instructions).toContain("127.0.0.1:19080");
    expect(compose).toEqual([]);
    expect(reached).toEqual(["http://127.0.0.1:19081/verify", "http://127.0.0.1:19080/"]);
  });

  it("should infer a legacy remapped unit's offset and normalize its ledger entry", async () => {
    const remapped = COMPOSE.replaceAll(":18080:", ":19080:").replaceAll(":18081:", ":19081:");
    const { deps } = makeDeps({
      readCompose: vi.fn((path: string) =>
        path === "/local/tc-local-sqli-demo.compose.yml" ? remapped : COMPOSE,
      ),
    });
    const runner = new ContainerRunner("/local", deps);
    const recovered = await runner.recover(problem(), {
      problemId: "sqli-demo",
      composePath: "/local/tc-local-sqli-demo.compose.yml",
      composeProjectName: "tc-local-sqli-demo",
      secretEnv: ["FLAG_SEED"],
      projectDirectory: "/p/sqli-demo/local",
      remappedComposePath: "/local/tc-local-sqli-demo.compose.yml",
    });

    expect(recovered.offset).toBe(1000);
    expect(recovered.started.unit.offset).toBe(1000);
    expect(recovered.started.problem.verifyUrl).toContain(":19081/");
  });

  it("should reject an ambiguous legacy remapped unit", async () => {
    const { deps } = makeDeps({
      readCompose: vi.fn((path: string) =>
        path === "/local/tc-local-sqli-demo.compose.yml"
          ? COMPOSE.replace("127.0.0.1:18081:8081", "127.0.0.1:19999:8081")
          : COMPOSE,
      ),
    });
    const runner = new ContainerRunner("/local", deps);

    await expect(
      runner.recover(problem(), {
        problemId: "sqli-demo",
        composePath: "/local/tc-local-sqli-demo.compose.yml",
        composeProjectName: "tc-local-sqli-demo",
        secretEnv: [],
        remappedComposePath: "/local/tc-local-sqli-demo.compose.yml",
      }),
    ).rejects.toThrow(/Cannot recover port offset/);
  });

  it("should reject a recorded offset that does not match its persisted compose", async () => {
    const { deps } = makeDeps();
    const runner = new ContainerRunner("/local", deps);

    await expect(
      runner.recover(problem(), {
        problemId: "sqli-demo",
        offset: 1000,
        composePath: "/local/tc-local-sqli-demo.compose.yml",
        composeProjectName: "tc-local-sqli-demo",
        secretEnv: ["FLAG_SEED"],
        projectDirectory: "/p/sqli-demo/local",
        remappedComposePath: "/local/tc-local-sqli-demo.compose.yml",
      }),
    ).rejects.toThrow(/does not match offset 1000/);
  });
});

describe("ContainerRunner: stop (#2392 Phase 2)", () => {
  it("should compose-down and remove the temp compose when remapped", async () => {
    const { deps, compose, composeEnvs, removed } = makeDeps();
    const runner = new ContainerRunner("/local", deps);
    const { unit } = await runner.start(problem(), 100);
    compose.length = 0; // ignore the up call
    runner.stop(unit);
    expect(compose).toEqual([
      ["down", "/local/tc-local-sqli-demo.compose.yml", "tc-local-sqli-demo", "/p/sqli-demo/local"],
    ]);
    expect(composeEnvs[1]?.FLAG_SEED).toBe("tenkacloud-local-cleanup");
    expect(removed).toEqual(["/local/tc-local-sqli-demo.compose.yml"]);
  });

  it("should compose-down without removing a temp file for an offset-0 unit", async () => {
    const { deps, compose, removed } = makeDeps();
    const runner = new ContainerRunner("/local", deps);
    const { unit } = await runner.start(problem(), 0);
    compose.length = 0;
    runner.stop(unit);
    expect(compose[0]?.[0]).toBe("down");
    expect(removed).toEqual([]);
  });

  it("should retain a remapped compose file when physical teardown fails", async () => {
    let failDown = false;
    const { deps, removed } = makeDeps({
      runCompose: vi.fn((_path, _project, action) => {
        if (action === "down" && failDown) throw new Error("docker down failed");
      }),
    });
    const runner = new ContainerRunner("/local", deps);
    const { unit } = await runner.start(problem(), 100);
    failDown = true;

    expect(() => runner.stop(unit)).toThrow("docker down failed");
    expect(removed).toEqual([]);
  });
});
