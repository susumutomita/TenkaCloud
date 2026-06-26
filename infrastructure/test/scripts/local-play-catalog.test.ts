import { describe, expect, it } from "vitest";
import { type LocalPlayCatalogFs, loadLocalFlagProblem } from "../../../scripts/local-play/catalog";

const ROOT = "/repo/problems";

function makeFs(files: Readonly<Record<string, string>>): LocalPlayCatalogFs {
  return {
    existsSync: (path) => Object.hasOwn(files, path),
    readFileSync: (path) => {
      const value = files[path];
      if (value === undefined) throw new Error(`missing fixture: ${path}`);
      return value;
    },
  };
}

function problemFiles(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  return {
    [`${ROOT}/challenges/hello-world/metadata.json`]: JSON.stringify(metadata),
    [`${ROOT}/challenges/hello-world/template.yaml`]: "Resources: {}\n",
  };
}

describe("loadLocalFlagProblem", () => {
  it("should load one flag problem and preserve its real scoring contract", () => {
    const problem = loadLocalFlagProblem(
      ROOT,
      "hello-world",
      makeFs(
        problemFiles({
          id: "hello-world",
          name: "Hello World",
          description: "Read the parameter.",
          instructions: "Use SSM.",
          cfnTemplate: "template.yaml",
          cfnParameters: { FlagSeed: "__RANDOM_PASSWORD__" },
          scoring: {
            kind: "flag",
            flagOutputKey: "ParameterValue",
            points: 100,
            wrongAnswerPenalty: 5,
            hints: [{ id: "h1", content: "Look in SSM", penalty: 10 }],
          },
        }),
      ),
    );

    expect(problem).toMatchObject({
      problemId: "hello-world",
      name: "Hello World",
      templatePath: `${ROOT}/challenges/hello-world/template.yaml`,
      cfnParameters: { FlagSeed: "__RANDOM_PASSWORD__" },
      scoring: {
        flagOutputKey: "ParameterValue",
        points: 100,
        wrongAnswerPenalty: 5,
        hints: [{ id: "h1", content: "Look in SSM", penalty: 10 }],
      },
    });
  });

  it("should reject non-flag problems instead of silently falling back", () => {
    expect(() =>
      loadLocalFlagProblem(
        ROOT,
        "hello-world",
        makeFs(
          problemFiles({
            id: "hello-world",
            scoring: { kind: "uptime-flat", pointsPerSuccess: 10 },
          }),
        ),
      ),
    ).toThrow('problem "hello-world" is not supported by local play: scoring.kind=uptime-flat');
  });

  it("should reject a flag problem without a non-empty flagOutputKey", () => {
    expect(() =>
      loadLocalFlagProblem(
        ROOT,
        "hello-world",
        makeFs(
          problemFiles({
            id: "hello-world",
            scoring: { kind: "flag", flagOutputKey: "", points: 100 },
          }),
        ),
      ),
    ).toThrow("scoring.flagOutputKey");
  });

  it("should reject unknown problem ids loudly", () => {
    expect(() => loadLocalFlagProblem(ROOT, "missing", makeFs({}))).toThrow(
      'problem "missing" was not found',
    );
  });
});
