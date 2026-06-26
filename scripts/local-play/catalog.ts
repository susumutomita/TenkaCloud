import { existsSync, readFileSync } from "node:fs";

export interface LocalPlayHint {
  readonly id: string;
  readonly content: string;
  readonly penalty: number;
}

export interface LocalFlagProblem {
  readonly problemId: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly templatePath: string;
  readonly cfnParameters: Readonly<Record<string, string>>;
  readonly scoring: {
    readonly flagOutputKey: string;
    readonly points: number;
    readonly wrongAnswerPenalty: number;
    readonly hints: readonly LocalPlayHint[];
  };
}

export interface LocalPlayCatalogFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string) => string;
}

interface RawMetadata {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly instructions?: unknown;
  readonly cfnTemplate?: unknown;
  readonly cfnParameters?: unknown;
  readonly scoring?: {
    readonly kind?: unknown;
    readonly flagOutputKey?: unknown;
    readonly points?: unknown;
    readonly wrongAnswerPenalty?: unknown;
    readonly hints?: unknown;
  };
}

const NODE_FS: LocalPlayCatalogFs = {
  existsSync,
  readFileSync: (path) => readFileSync(path, "utf8"),
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function finiteNonNegativeNumber(value: unknown, field: string, fallback?: number): number {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return candidate;
}

function normalizeParameters(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("cfnParameters must be an object");
  }
  const parameters: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      throw new Error(`cfnParameters.${key} must be a string`);
    }
    parameters[key] = raw;
  }
  return parameters;
}

function normalizeHints(value: unknown): readonly LocalPlayHint[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("scoring.hints must be an array");
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`scoring.hints[${index}] must be an object`);
    }
    const hint = raw as { id?: unknown; content?: unknown; penalty?: unknown };
    return {
      id: requiredString(hint.id, `scoring.hints[${index}].id`),
      content: requiredString(hint.content, `scoring.hints[${index}].content`),
      penalty: finiteNonNegativeNumber(hint.penalty, `scoring.hints[${index}].penalty`, 0),
    };
  });
}

function findProblemDirectory(
  problemsRoot: string,
  problemId: string,
  fs: LocalPlayCatalogFs,
): string {
  const matches = ["challenges", "battles"]
    .map((group) => `${problemsRoot}/${group}/${problemId}`)
    .filter((directory) => fs.existsSync(`${directory}/metadata.json`));
  if (matches.length === 0) throw new Error(`problem "${problemId}" was not found`);
  if (matches.length > 1) {
    throw new Error(`problem "${problemId}" exists in both challenges and battles`);
  }
  return matches[0];
}

export function loadLocalFlagProblem(
  problemsRoot: string,
  problemId: string,
  fs: LocalPlayCatalogFs = NODE_FS,
): LocalFlagProblem {
  const directory = findProblemDirectory(problemsRoot, problemId, fs);
  let metadata: RawMetadata;
  try {
    metadata = JSON.parse(fs.readFileSync(`${directory}/metadata.json`)) as RawMetadata;
  } catch (error) {
    throw new Error(`failed to parse metadata for problem "${problemId}"`, { cause: error });
  }

  const scoring = metadata.scoring;
  const kind =
    scoring && typeof scoring.kind === "string" && scoring.kind.length > 0
      ? scoring.kind
      : "(missing)";
  if (kind !== "flag") {
    throw new Error(`problem "${problemId}" is not supported by local play: scoring.kind=${kind}`);
  }

  const flagOutputKey = requiredString(scoring?.flagOutputKey, "scoring.flagOutputKey");
  const templateName = requiredString(metadata.cfnTemplate, "cfnTemplate");
  const templatePath = `${directory}/${templateName}`;
  if (!fs.existsSync(templatePath)) {
    throw new Error(`CloudFormation template was not found: ${templatePath}`);
  }

  const points = finiteNonNegativeNumber(scoring?.points, "scoring.points");
  if (points <= 0) throw new Error("scoring.points must be greater than zero");

  return {
    problemId,
    name:
      typeof metadata.name === "string" && metadata.name.trim().length > 0
        ? metadata.name
        : problemId,
    description: typeof metadata.description === "string" ? metadata.description : "",
    instructions: typeof metadata.instructions === "string" ? metadata.instructions : "",
    templatePath,
    cfnParameters: normalizeParameters(metadata.cfnParameters),
    scoring: {
      flagOutputKey,
      points,
      wrongAnswerPenalty: finiteNonNegativeNumber(
        scoring?.wrongAnswerPenalty,
        "scoring.wrongAnswerPenalty",
        0,
      ),
      hints: normalizeHints(scoring?.hints),
    },
  };
}
