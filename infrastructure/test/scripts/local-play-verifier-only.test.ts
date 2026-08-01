import { describe, expect, it, vi } from "vitest";
import {
  ContainerRunner,
  type ContainerRunnerDeps,
} from "../../../scripts/local-play/container-runner";
import {
  listLocalPlayProblems,
  loadContainerProblem,
  type ManifestFs,
} from "../../../scripts/local-play/manifest";

const ROOT = "/repo/problems/challenges";
const PROBLEM_ID = "ac26-verifier-only";
const PROBLEM_DIR = `${ROOT}/${PROBLEM_ID}`;
const COMPOSE_PATH = `${PROBLEM_DIR}/local/docker-compose.yml`;

const VERIFIER_ONLY_METADATA = {
  name: "Verifier-only cryptography lab",
  description: "Repair a local implementation and submit it to the verifier.",
  instructions: "Edit the starter and submit the completed source.",
  runtime: {
    provider: "docker",
    engine: "compose",
    entry: "local/docker-compose.yml",
    verifyUrl: "http://127.0.0.1:18091/verify",
    secretEnv: ["FLAG_SEED"],
  },
  scoring: {
    kind: "multi-verify",
    checks: [
      {
        id: "inspect",
        label: "Inspect the broken implementation",
        points: 50,
        wrongAnswerPenalty: 0,
        hints: [],
      },
      {
        id: "repair",
        label: "Repair the implementation",
        points: 50,
        wrongAnswerPenalty: 0,
        hints: [],
      },
    ],
  },
};

const COMPOSE = [
  "services:",
  "  verifier:",
  "    ports:",
  '      - "127.0.0.1:18091:18091"',
].join("\n");

function verifierOnlyFs(metadata: object = VERIFIER_ONLY_METADATA): ManifestFs {
  const files: Record<string, string> = {
    [`${PROBLEM_DIR}/metadata.json`]: JSON.stringify(metadata),
    [COMPOSE_PATH]: COMPOSE,
  };
  return {
    existsSync: (path) => Object.hasOwn(files, path),
    readFileSync: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    readDirNames: (path) => (path === ROOT ? [PROBLEM_ID] : []),
  };
}

describe("verifier-only local container problems", () => {
  it("loads and lists a problem that omits challengeEndpoints", () => {
    const fs = verifierOnlyFs();

    const problem = loadContainerProblem(PROBLEM_DIR, fs);

    expect(problem.challengeEndpoints).toEqual({});
    expect(problem.verifyUrl).toBe("http://127.0.0.1:18091/verify");
    expect(problem.scoring.kind).toBe("multi-verify");
    expect(listLocalPlayProblems([ROOT], fs)).toEqual([
      {
        problemId: PROBLEM_ID,
        name: "Verifier-only cryptography lab",
        category: "challenges",
      },
    ]);
  });

  it("waits for the remapped verifier even when no challenge surface exists", async () => {
    const problem = loadContainerProblem(PROBLEM_DIR, verifierOnlyFs());
    const reached: Array<[string, string]> = [];
    const tempComposes: Array<[string, string]> = [];
    const deps: ContainerRunnerDeps = {
      runCompose: vi.fn(),
      waitForReachable: vi.fn(async (url, label) => {
        reached.push([url, label]);
      }),
      generateSecretEnv: vi.fn(() => ({ FLAG_SEED: "test-seed" })),
      readCompose: vi.fn(() => COMPOSE),
      writeTempCompose: vi.fn((path, content) => {
        tempComposes.push([path, content]);
      }),
      removeTempCompose: vi.fn(),
      log: vi.fn(),
    };
    const runner = new ContainerRunner("/tmp/local-play", deps);

    const started = await runner.start(problem, 1_000);

    expect(reached).toEqual([["http://127.0.0.1:19091/verify", "verify endpoint"]]);
    expect(started.problem.challengeEndpoints).toEqual({});
    expect(started.problem.verifyUrl).toBe("http://127.0.0.1:19091/verify");
    expect(tempComposes).toHaveLength(1);
    expect(tempComposes[0]?.[1]).toContain("127.0.0.1:19091:18091");
  });
});
