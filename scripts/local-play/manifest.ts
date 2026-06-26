import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseLoopbackUrl } from "./loopback";

/**
 * A local-play problem is a self-contained Docker container that owns both the
 * challenge surface and its own scoring (`/verify`). This module reads the
 * `runtime` (container delivery, ADR-023) + `scoring` sections of a catalog
 * problem's `metadata.json` and validates the *wiring* only — the platform
 * deliberately never learns the answer, the hidden tests, or any scoring
 * condition (those live inside the container). See Issue #2054: "evaluation is
 * on the problem side, the platform only scores".
 */

export interface ContainerHint {
  readonly id: string;
  readonly content: string;
  readonly penalty: number;
}

export interface ContainerScoring {
  readonly points: number;
  readonly wrongAnswerPenalty: number;
  readonly hints: readonly ContainerHint[];
}

export interface ContainerProblem {
  readonly problemId: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  /** Absolute path to the problem directory (the metadata.json lives here). */
  readonly problemDir: string;
  /** Absolute path to the docker compose file that brings up the container. */
  readonly composePath: string;
  /** `docker compose -p` project name, derived from the problem id. */
  readonly composeProjectName: string;
  /** Loopback URL(s) the participant attacks, surfaced in the portal. */
  readonly challengeEndpoints: Readonly<Record<string, string>>;
  /** Loopback `/verify` endpoint the container exposes for scoring delegation. */
  readonly verifyUrl: string;
  /** Env var names filled with a per-deploy random secret (e.g. FLAG_SEED). */
  readonly secretEnv: readonly string[];
  readonly scoring: ContainerScoring;
}

export interface ManifestFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string) => string;
}

const NODE_FS: ManifestFs = {
  existsSync,
  readFileSync: (path) => readFileSync(path, "utf8"),
};

interface RawMetadata {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly instructions?: unknown;
  // [ADR-023] container delivery is declared via the catalog's `runtime` field.
  readonly runtime?: {
    readonly provider?: unknown;
    readonly engine?: unknown;
    readonly entry?: unknown;
    readonly challengeEndpoints?: unknown;
    readonly verifyUrl?: unknown;
    readonly secretEnv?: unknown;
  };
  readonly scoring?: {
    readonly kind?: unknown;
    readonly points?: unknown;
    readonly wrongAnswerPenalty?: unknown;
    readonly hints?: unknown;
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string, fallback?: number): number {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return candidate;
}

function loopbackUrl(value: unknown, field: string): string {
  return parseLoopbackUrl(requiredString(value, field), field).toString();
}

function normalizeEndpoints(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime.challengeEndpoints must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error("runtime.challengeEndpoints must declare at least one endpoint");
  }
  const endpoints: Record<string, string> = {};
  for (const [label, raw] of entries) {
    endpoints[label] = loopbackUrl(raw, `runtime.challengeEndpoints.${label}`);
  }
  return endpoints;
}

function normalizeSecretEnv(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("runtime.secretEnv must be an array");
  return value.map((raw, index) => requiredString(raw, `runtime.secretEnv[${index}]`));
}

function normalizeHints(value: unknown): readonly ContainerHint[] {
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
      penalty: nonNegativeNumber(hint.penalty, `scoring.hints[${index}].penalty`, 0),
    };
  });
}

/**
 * Resolve a problem id to exactly one problem directory across `roots` (each
 * root is a group dir such as `<repo>/problems/challenges`). Fails loudly when
 * the id is missing or ambiguous so `make local` never silently picks the wrong
 * problem.
 */
export function resolveProblemDir(
  roots: readonly string[],
  problemId: string,
  fs: ManifestFs = NODE_FS,
): string {
  const matches = roots
    .map((root) => join(root, problemId))
    .filter((directory) => fs.existsSync(join(directory, "metadata.json")));
  if (matches.length === 0) {
    throw new Error(`problem "${problemId}" was not found under: ${roots.join(", ")}`);
  }
  if (matches.length > 1) {
    throw new Error(`problem "${problemId}" is ambiguous: ${matches.join(", ")}`);
  }
  return matches[0];
}

export function loadContainerProblem(
  problemDir: string,
  fs: ManifestFs = NODE_FS,
): ContainerProblem {
  const metadataPath = join(problemDir, "metadata.json");
  let metadata: RawMetadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath)) as RawMetadata;
  } catch (error) {
    throw new Error(`failed to parse metadata: ${metadataPath}`, { cause: error });
  }

  const problemId = basename(problemDir);
  const scoring = metadata.scoring;
  const kind = typeof scoring?.kind === "string" ? scoring.kind : "(missing)";
  if (kind !== "verify") {
    throw new Error(
      `problem "${problemId}" is not a local container problem: scoring.kind=${kind} (expected "verify")`,
    );
  }

  const runtime = metadata.runtime;
  if (typeof runtime !== "object" || runtime === null) {
    throw new Error(`problem "${problemId}" is missing the "runtime" section`);
  }
  if (runtime.engine !== "compose") {
    throw new Error(
      `problem "${problemId}" runtime.engine must be "compose" for local play (got ${String(runtime.engine)})`,
    );
  }

  const composeName = requiredString(runtime.entry, "runtime.entry");
  const composePath = join(problemDir, composeName);
  if (!fs.existsSync(composePath)) {
    throw new Error(`compose file was not found: ${composePath}`);
  }

  const points = nonNegativeNumber(scoring?.points, "scoring.points");
  if (points <= 0) throw new Error("scoring.points must be greater than zero");

  return {
    problemId,
    name:
      typeof metadata.name === "string" && metadata.name.trim().length > 0
        ? metadata.name
        : problemId,
    description: typeof metadata.description === "string" ? metadata.description : "",
    instructions: typeof metadata.instructions === "string" ? metadata.instructions : "",
    problemDir,
    composePath,
    composeProjectName: `tc-local-${problemId}`,
    challengeEndpoints: normalizeEndpoints(runtime.challengeEndpoints),
    verifyUrl: loopbackUrl(runtime.verifyUrl, "runtime.verifyUrl"),
    secretEnv: normalizeSecretEnv(runtime.secretEnv),
    scoring: {
      points,
      wrongAnswerPenalty: nonNegativeNumber(
        scoring?.wrongAnswerPenalty,
        "scoring.wrongAnswerPenalty",
        0,
      ),
      hints: normalizeHints(scoring?.hints),
    },
  };
}
