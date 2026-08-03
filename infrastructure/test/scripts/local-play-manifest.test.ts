import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listLocalPlayProblems,
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

/** Same as {@link fsWith} but also derives `readDirNames` from the file map's own keys. */
function fsWithDirs(files: Record<string, string>): ManifestFs {
  const base = fsWith(files);
  return {
    ...base,
    readDirNames: (path) => {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue;
        names.add(key.slice(prefix.length).split("/")[0]);
      }
      return [...names];
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
      kind: "verify",
      points: 200,
      wrongAnswerPenalty: 10,
      hints: [{ id: "hint-1", content: "Try a quote.", penalty: 0 }],
    });
    // Unset hintReveal is omitted (= sequential default).
    expect(problem.scoring).not.toHaveProperty("hintReveal");
  });

  it("should parse scoring.hintReveal:'flat' and ignore invalid values", () => {
    const flat = loadContainerProblem(
      DIR,
      fixture({ scoring: { ...VALID_METADATA.scoring, hintReveal: "flat" } }),
    );
    expect(flat.scoring).toMatchObject({ kind: "verify", hintReveal: "flat" });
    // An explicit "sequential" round-trips; a typo is dropped to the default (absent).
    const seq = loadContainerProblem(
      DIR,
      fixture({ scoring: { ...VALID_METADATA.scoring, hintReveal: "sequential" } }),
    );
    expect(seq.scoring).toMatchObject({ hintReveal: "sequential" });
    const bogus = loadContainerProblem(
      DIR,
      fixture({ scoring: { ...VALID_METADATA.scoring, hintReveal: "nope" } }),
    );
    expect(bogus.scoring).not.toHaveProperty("hintReveal");
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
    expect(problem.scoring).toEqual({
      kind: "verify",
      points: 100,
      wrongAnswerPenalty: 0,
      hints: [],
    });
  });

  it("should have no terminal unless runtime.terminal opts in (#2850)", () => {
    // The terminal is an authorization surface: absent declaration = no shell, ever.
    expect(loadContainerProblem(DIR, fixture())).not.toHaveProperty("terminal");
  });

  it("should parse a declared runtime.terminal service (#2850)", () => {
    const problem = loadContainerProblem(
      DIR,
      fixture({ runtime: { ...VALID_METADATA.runtime, terminal: { service: "verifier" } } }),
    );
    expect(problem.terminal).toEqual({ service: "verifier" });
  });

  it.each([
    ["a non-object", "verifier"],
    ["an array", ["verifier"]],
  ])("should reject runtime.terminal that is %s (#2850)", (_label, terminal) => {
    expect(() =>
      loadContainerProblem(DIR, fixture({ runtime: { ...VALID_METADATA.runtime, terminal } })),
    ).toThrow(/runtime.terminal must be an object/);
  });

  it("should reject runtime.terminal without a service (#2850)", () => {
    expect(() =>
      loadContainerProblem(DIR, fixture({ runtime: { ...VALID_METADATA.runtime, terminal: {} } })),
    ).toThrow(/runtime.terminal.service must be a non-empty string/);
  });

  it.each([
    "-rm",
    "a b",
    "svc/../up",
    "",
  ])("should reject the unsafe terminal service name %j (#2850)", (service) => {
    // A leading "-" would read as a compose CLI flag; whitespace and path
    // separators are not compose service names at all.
    expect(() =>
      loadContainerProblem(
        DIR,
        fixture({ runtime: { ...VALID_METADATA.runtime, terminal: { service } } }),
      ),
    ).toThrow(/runtime.terminal.service/);
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

  it("keeps bilingual writeups in dedicated post-solve fields", () => {
    const problem = loadContainerProblem(
      DIR,
      fixture({
        writeup: "日本語の解説",
        i18n: { en: { writeup: "English explanation" } },
      }),
    );
    expect(problem.writeup).toBe("日本語の解説");
    expect(problem.writeupI18n).toBe("English explanation");
    expect(problem.i18n).toBeUndefined();
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

describe("loadContainerProblem: multi-verify (issue #2252)", () => {
  const check = (over: Record<string, unknown> = {}) => ({
    id: "public-backup",
    label: "公開バックアップ",
    points: 50,
    ...over,
  });
  // A distinct, always-valid sibling so fixtures satisfy the 2-check minimum
  // while a test exercises the first check.
  const other = (over: Record<string, unknown> = {}) => ({
    id: "exposed-config",
    label: "設定ファイルの控え",
    points: 50,
    ...over,
  });
  const multiVerify = (checks: unknown[], i18nChecks?: unknown[]) =>
    fixture({
      scoring: { kind: "multi-verify", checks },
      ...(i18nChecks ? { i18n: { en: { name: "WP Ops", checks: i18nChecks } } } : {}),
    });

  it("should parse checks with per-check penalty/hints and compute totalPoints", () => {
    const problem = loadContainerProblem(
      DIR,
      multiVerify([
        check({
          wrongAnswerPenalty: 5,
          hints: [{ id: "h-backup", content: "公開パスを確認する", penalty: 2 }],
        }),
        check({ id: "weak-admin-pw", label: "弱い管理者パスワード", points: 70 }),
      ]),
    );
    expect(problem.scoring).toEqual({
      kind: "multi-verify",
      totalPoints: 120,
      checks: [
        {
          id: "public-backup",
          label: "公開バックアップ",
          points: 50,
          wrongAnswerPenalty: 5,
          hints: [{ id: "h-backup", content: "公開パスを確認する", penalty: 2 }],
        },
        {
          id: "weak-admin-pw",
          label: "弱い管理者パスワード",
          points: 70,
          wrongAnswerPenalty: 0,
          hints: [],
        },
      ],
    });
  });

  it("should parse a top-level hintReveal:'flat' for the whole multi-verify problem", () => {
    const problem = loadContainerProblem(
      DIR,
      fixture({
        scoring: { kind: "multi-verify", hintReveal: "flat", checks: [check(), other()] },
      }),
    );
    expect(problem.scoring).toMatchObject({ kind: "multi-verify", hintReveal: "flat" });
    // Default (helper omits it) stays absent.
    const seq = loadContainerProblem(DIR, multiVerify([check(), other()]));
    expect(seq.scoring).not.toHaveProperty("hintReveal");
  });

  it("should overlay i18n.en.checks label + hint content by id (scoring stays top-level)", () => {
    const problem = loadContainerProblem(
      DIR,
      multiVerify(
        [
          check({ hints: [{ id: "h-backup", content: "公開パスを確認する", penalty: 0 }] }),
          other(),
        ],
        [
          {
            id: "public-backup",
            label: "Public backup",
            hints: [{ id: "h-backup", content: "Check the public path" }],
          },
        ],
      ),
    );
    expect(problem.scoring.kind).toBe("multi-verify");
    if (problem.scoring.kind !== "multi-verify") throw new Error("unreachable");
    expect(problem.scoring.checks[0].i18n).toEqual({ en: { label: "Public backup" } });
    expect(problem.scoring.checks[0].hints[0].i18n).toEqual({
      en: { content: "Check the public path" },
    });
  });

  it("should enforce the 2–8 check count (fail-closed)", () => {
    expect(() => loadContainerProblem(DIR, multiVerify([]))).toThrow(/2–8 entries/);
    expect(() => loadContainerProblem(DIR, multiVerify([check()]))).toThrow(/2–8 entries/);
    const nine = Array.from({ length: 9 }, (_, i) => check({ id: `c${i}` }));
    expect(() => loadContainerProblem(DIR, multiVerify(nine))).toThrow(/2–8 entries/);
  });

  it("should fail loudly on duplicate ids / bad id / non-integer points", () => {
    expect(() => loadContainerProblem(DIR, multiVerify([check(), check()]))).toThrow(
      /is duplicated/,
    );
    expect(() =>
      loadContainerProblem(DIR, multiVerify([check({ id: "Bad_ID" }), other()])),
    ).toThrow(/must match/);
    expect(() => loadContainerProblem(DIR, multiVerify([check({ id: "-lead" }), other()]))).toThrow(
      /must match/,
    );
    expect(() =>
      loadContainerProblem(DIR, multiVerify([check({ points: 12.5 }), other()])),
    ).toThrow(/positive integer/);
    expect(() => loadContainerProblem(DIR, multiVerify([check({ points: 0 }), other()]))).toThrow(
      /positive integer/,
    );
  });

  it("should reject a label longer than 80 chars and a penalty above the check points", () => {
    expect(() =>
      loadContainerProblem(DIR, multiVerify([check({ label: "あ".repeat(81) }), other()])),
    ).toThrow(/80 characters or fewer/);
    expect(() =>
      loadContainerProblem(
        DIR,
        multiVerify([check({ points: 50, wrongAnswerPenalty: 51 }), other()]),
      ),
    ).toThrow(/must not exceed the check points/);
  });

  it("should fail loudly when hint ids collide across checks (reveal route is keyed on hintId)", () => {
    expect(() =>
      loadContainerProblem(
        DIR,
        multiVerify([
          check({ hints: [{ id: "shared", content: "a", penalty: 0 }] }),
          check({
            id: "second",
            hints: [{ id: "shared", content: "b", penalty: 0 }],
          }),
        ]),
      ),
    ).toThrow(/unique across the problem/);
  });

  it("should keep rejecting non-container scoring kinds", () => {
    expect(() =>
      loadContainerProblem(DIR, fixture({ scoring: { kind: "flag", points: 100 } })),
    ).toThrow(/expected "verify" or "multi-verify"/);
  });
});

describe("listLocalPlayProblems (issue #2188: make local list)", () => {
  const CHALLENGES = "/repo/problems/challenges";
  const BATTLES = "/repo/problems/battles";

  function metadataFor(name: string): string {
    return JSON.stringify({ ...VALID_METADATA, name });
  }

  it("should list local-play problems across roots, sorted by id, with category = root dir name", () => {
    const fs = fsWithDirs({
      [`${CHALLENGES}/sqli-demo/metadata.json`]: metadataFor("SQL Injection Demo"),
      [`${CHALLENGES}/sqli-demo/local/docker-compose.yml`]: "services: {}",
      [`${BATTLES}/net-evo-01/metadata.json`]: metadataFor("Network Evolution 01"),
      [`${BATTLES}/net-evo-01/local/docker-compose.yml`]: "services: {}",
    });
    expect(listLocalPlayProblems([CHALLENGES, BATTLES], fs)).toEqual([
      { problemId: "net-evo-01", name: "Network Evolution 01", category: "battles" },
      { problemId: "sqli-demo", name: "SQL Injection Demo", category: "challenges" },
    ]);
  });

  it("should skip a problem directory that is not a local container problem", () => {
    const fs = fsWithDirs({
      [`${CHALLENGES}/sqli-demo/metadata.json`]: metadataFor("SQL Injection Demo"),
      [`${CHALLENGES}/sqli-demo/local/docker-compose.yml`]: "services: {}",
      // aws-only problem: no runtime.provider=docker container delivery
      [`${CHALLENGES}/aws-only/metadata.json`]: JSON.stringify({
        name: "AWS Only",
        scoring: { kind: "flag", points: 100 },
      }),
    });
    expect(listLocalPlayProblems([CHALLENGES], fs)).toEqual([
      { problemId: "sqli-demo", name: "SQL Injection Demo", category: "challenges" },
    ]);
  });

  it("should skip a directory entry with no metadata.json", () => {
    const fs = fsWithDirs({
      [`${CHALLENGES}/sqli-demo/metadata.json`]: metadataFor("SQL Injection Demo"),
      [`${CHALLENGES}/sqli-demo/local/docker-compose.yml`]: "services: {}",
      // a stray non-problem directory (e.g. .git) with no metadata.json at all
      [`${CHALLENGES}/.git/HEAD`]: "ref: refs/heads/main",
    });
    expect(listLocalPlayProblems([CHALLENGES], fs)).toEqual([
      { problemId: "sqli-demo", name: "SQL Injection Demo", category: "challenges" },
    ]);
  });

  it("should return an empty list when no root has any problems", () => {
    const fs = fsWithDirs({});
    expect(listLocalPlayProblems([CHALLENGES, BATTLES], fs)).toEqual([]);
  });
});
