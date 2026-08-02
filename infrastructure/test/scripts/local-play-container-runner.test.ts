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
    expect(started.unit).toMatchObject({ composePath: "/p/sqli-demo/local/docker-compose.yml" });
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
      composePath: "/local/tc-local-sqli-demo.compose.yml",
      projectDirectory: "/p/sqli-demo/local",
      remappedComposePath: "/local/tc-local-sqli-demo.compose.yml",
    });
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
