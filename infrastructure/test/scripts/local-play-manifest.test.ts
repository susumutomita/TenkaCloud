import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadContainerProblem,
  type ManifestFs,
  resolveProblemDir,
} from "../../../scripts/local-play/manifest";

function fsWith(files: Record<string, string>): ManifestFs {
  return {
    existsSync: (path) => Object.hasOwn(files, path),
    readFileSync: (path) => {
      if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
  };
}

const VALID_METADATA = {
  name: "SQL Injection Demo",
  description: "A deliberately vulnerable login form.",
  instructions: "Bypass the login.",
  runtime: {
    provider: "docker",
    engine: "compose",
    entry: "local/docker-compose.yml",
    challengeEndpoints: { Web: "http://127.0.0.1:18080" },
    verifyUrl: "http://127.0.0.1:18081/verify",
    secretEnv: ["FLAG_SEED"],
  },
  scoring: {
    kind: "verify",
    points: 200,
    wrongAnswerPenalty: 10,
    hints: [{ id: "hint-1", content: "Try a quote.", penalty: 0 }],
  },
};

const DIR = "/repo/problems/challenges/sqli-demo";

function fixture(overrides: Record<string, unknown> = {}): ManifestFs {
  return fsWith({
    [`${DIR}/metadata.json`]: JSON.stringify({ ...VALID_METADATA, ...overrides }),
    [`${DIR}/local/docker-compose.yml`]: "services: {}",
  });
}

describe("resolveProblemDir", () => {
  const roots = ["/repo/problems/challenges", "/repo/problems/battles"];

  it("should resolve a problem id to its single directory", () => {
    const fs = fsWith({ "/repo/problems/challenges/sqli-demo/metadata.json": "{}" });
    expect(resolveProblemDir(roots, "sqli-demo", fs)).toBe("/repo/problems/challenges/sqli-demo");
  });

  it("should fail loudly when the problem is not found", () => {
    const fs = fsWith({});
    expect(() => resolveProblemDir(roots, "missing", fs)).toThrow(/was not found/);
  });

  it("should fail loudly when the problem id is ambiguous across roots", () => {
    const fs = fsWith({
      "/repo/problems/challenges/dup/metadata.json": "{}",
      "/repo/problems/battles/dup/metadata.json": "{}",
    });
    expect(() => resolveProblemDir(roots, "dup", fs)).toThrow(/ambiguous/);
  });
});

describe("loadContainerProblem", () => {
  it("should load and normalize a valid container manifest from runtime", () => {
    const problem = loadContainerProblem(DIR, fixture());
    expect(problem.problemId).toBe("sqli-demo");
    expect(problem.name).toBe("SQL Injection Demo");
    expect(problem.composePath).toBe(`${DIR}/local/docker-compose.yml`);
    expect(problem.composeProjectName).toBe("tc-local-sqli-demo");
    expect(problem.challengeEndpoints).toEqual({ Web: "http://127.0.0.1:18080/" });
    expect(problem.verifyUrl).toBe("http://127.0.0.1:18081/verify");
    expect(problem.secretEnv).toEqual(["FLAG_SEED"]);
    expect(problem.scoring).toEqual({
      points: 200,
      wrongAnswerPenalty: 10,
      hints: [{ id: "hint-1", content: "Try a quote.", penalty: 0 }],
    });
  });

  it("should default name/description/instructions/secretEnv/hints when omitted", () => {
    const problem = loadContainerProblem(
      DIR,
      fixture({
        name: undefined,
        description: undefined,
        instructions: undefined,
        runtime: {
          provider: "docker",
          engine: "compose",
          entry: "local/docker-compose.yml",
          challengeEndpoints: { Web: "http://localhost:18080" },
          verifyUrl: "http://localhost:18081/verify",
        },
        scoring: { kind: "verify", points: 100 },
      }),
    );
    expect(problem.name).toBe("sqli-demo");
    expect(problem.description).toBe("");
    expect(problem.instructions).toBe("");
    expect(problem.secretEnv).toEqual([]);
    expect(problem.scoring).toEqual({ points: 100, wrongAnswerPenalty: 0, hints: [] });
  });

  it("should reject a non-verify scoring kind", () => {
    expect(() =>
      loadContainerProblem(DIR, fixture({ scoring: { kind: "flag", points: 10 } })),
    ).toThrow(/not a local container problem: scoring.kind=flag/);
  });

  it("should reject a missing runtime section", () => {
    expect(() =>
      loadContainerProblem(
        DIR,
        fixture({ runtime: undefined, scoring: { kind: "verify", points: 10 } }),
      ),
    ).toThrow(/missing the "runtime" section/);
  });

  it("should reject a non-compose runtime engine", () => {
    expect(() =>
      loadContainerProblem(
        DIR,
        fixture({
          runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
        }),
      ),
    ).toThrow(/runtime.engine must be "compose"/);
  });

  it("should fail loudly when the compose entry is absent", () => {
    const fs = fsWith({ [`${DIR}/metadata.json`]: JSON.stringify(VALID_METADATA) });
    expect(() => loadContainerProblem(DIR, fs)).toThrow(/compose file was not found/);
  });

  it("should reject a non-loopback verifyUrl", () => {
    expect(() =>
      loadContainerProblem(
        DIR,
        fixture({
          runtime: {
            provider: "docker",
            engine: "compose",
            entry: "local/docker-compose.yml",
            challengeEndpoints: { Web: "http://127.0.0.1:18080" },
            verifyUrl: "http://evil.example.com/verify",
          },
          scoring: { kind: "verify", points: 10 },
        }),
      ),
    ).toThrow(/Refusing non-loopback/);
  });

  it("should reject empty challengeEndpoints", () => {
    expect(() =>
      loadContainerProblem(
        DIR,
        fixture({
          runtime: {
            provider: "docker",
            engine: "compose",
            entry: "local/docker-compose.yml",
            challengeEndpoints: {},
            verifyUrl: "http://127.0.0.1:18081/verify",
          },
          scoring: { kind: "verify", points: 10 },
        }),
      ),
    ).toThrow(/at least one endpoint/);
  });

  it("should reject zero or negative points", () => {
    expect(() =>
      loadContainerProblem(DIR, fixture({ scoring: { kind: "verify", points: 0 } })),
    ).toThrow(/scoring.points must be greater than zero/);
  });

  it("should fail loudly on unparseable metadata json", () => {
    const fs = fsWith({
      [`${DIR}/metadata.json`]: "{ not json",
      [`${DIR}/local/docker-compose.yml`]: "services: {}",
    });
    expect(() => loadContainerProblem(DIR, fs)).toThrow(/failed to parse metadata/);
  });

  it("should omit the i18n overlay when no translation is present", () => {
    const problem = loadContainerProblem(DIR, fixture());
    expect(problem.i18n).toBeUndefined();
    expect(problem.scoring.hints[0]).not.toHaveProperty("i18n");
  });

  it("should extract the i18n.en overlay and map hint translations by id", () => {
    const problem = loadContainerProblem(
      DIR,
      fixture({
        scoring: {
          kind: "verify",
          points: 200,
          wrongAnswerPenalty: 10,
          hints: [
            { id: "hint-1", content: "クオートを試す。", penalty: 0 },
            { id: "hint-2", content: "admin' -- を使う。", penalty: 50 },
          ],
        },
        i18n: {
          en: {
            name: "SQL Injection — Login Bypass",
            description: "A deliberately vulnerable login.",
            instructions: "Bypass the login.",
            hints: [
              { id: "hint-1", content: "Try a single quote." },
              { id: "hint-2", content: "Use admin' --." },
            ],
          },
        },
      }),
    );
    expect(problem.i18n).toEqual({
      en: {
        name: "SQL Injection — Login Bypass",
        description: "A deliberately vulnerable login.",
        instructions: "Bypass the login.",
      },
    });
    expect(problem.scoring.hints).toEqual([
      {
        id: "hint-1",
        content: "クオートを試す。",
        penalty: 0,
        i18n: { en: { content: "Try a single quote." } },
      },
      {
        id: "hint-2",
        content: "admin' -- を使う。",
        penalty: 50,
        i18n: { en: { content: "Use admin' --." } },
      },
    ]);
  });

  it("should attach hint translations only for matching ids and skip malformed entries", () => {
    const problem = loadContainerProblem(
      DIR,
      fixture({
        scoring: {
          kind: "verify",
          points: 200,
          hints: [
            { id: "hint-1", content: "JA one", penalty: 0 },
            { id: "hint-2", content: "JA two", penalty: 0 },
          ],
        },
        i18n: {
          en: {
            // not an object / missing id / missing content / unknown id → all ignored
            hints: [
              "garbage",
              { content: "no id" },
              { id: "hint-2" },
              { id: "hint-99", content: "orphan" },
              { id: "hint-1", content: "EN one" },
            ],
          },
        },
      }),
    );
    // only hint-1 has a usable translation; hint-2 falls back to JA (no i18n key)
    expect(problem.scoring.hints[0].i18n).toEqual({ en: { content: "EN one" } });
    expect(problem.scoring.hints[1]).not.toHaveProperty("i18n");
    // an en block with only hints (no text overrides) yields no problem-level overlay
    expect(problem.i18n).toBeUndefined();
  });

  it("should ignore blank/whitespace en text fields and a non-array hints field", () => {
    const problem = loadContainerProblem(
      DIR,
      fixture({
        i18n: {
          en: { name: "   ", description: 42, instructions: "Real EN instructions", hints: "nope" },
        },
      }),
    );
    expect(problem.i18n).toEqual({ en: { instructions: "Real EN instructions" } });
    expect(problem.scoring.hints[0]).not.toHaveProperty("i18n");
  });
});

describe("manifest loader against the real filesystem", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function writeProblem(): { root: string; dir: string } {
    const root = mkdtempSync(join(tmpdir(), "tc-local-problem-"));
    tmpRoots.push(root);
    const dir = join(root, "challenges", "fixture-problem");
    mkdirSync(join(dir, "local"), { recursive: true });
    writeFileSync(join(dir, "local", "docker-compose.yml"), "services: {}\n");
    writeFileSync(
      join(dir, "metadata.json"),
      JSON.stringify({
        name: "Fixture",
        runtime: {
          provider: "docker",
          engine: "compose",
          entry: "local/docker-compose.yml",
          challengeEndpoints: { Web: "http://127.0.0.1:18080" },
          verifyUrl: "http://127.0.0.1:18081/verify",
          secretEnv: ["FLAG_SEED"],
        },
        scoring: { kind: "verify", points: 150 },
      }),
    );
    return { root, dir };
  }

  it("should resolve and load a problem through the default node fs (no fs injection)", () => {
    const { root, dir } = writeProblem();
    const resolved = resolveProblemDir(
      [join(root, "challenges"), join(root, "battles")],
      "fixture-problem",
    );
    expect(resolved).toBe(dir);

    const problem = loadContainerProblem(resolved);
    expect(problem.problemId).toBe("fixture-problem");
    expect(problem.composeProjectName).toBe("tc-local-fixture-problem");
    expect(problem.scoring.points).toBe(150);
  });
});
