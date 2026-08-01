import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Competitor-facing text translated into a non-default locale. The default
 * language (Japanese) lives in the top-level fields; this overlay carries the
 * `metadata.i18n.en` override so the portal's locale switcher can render the
 * problem in English (locale fallback chain: en → ja top-level). Only `en` is
 * supported (ja+en, #1108).
 */
export interface LocalizedProblemText {
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly writeup?: string;
}

export interface ContainerHint {
  readonly id: string;
  readonly content: string;
  readonly penalty: number;
  /** `metadata.i18n.<locale>.hints[]` translation of `content`, matched by id. */
  readonly i18n?: { readonly en?: { readonly content: string } };
}

/**
 * Hint unlock order, mirroring the SDK's `HintRevealMode` (kept inline so this
 * self-contained manifest parser needs no cross-package import). Unset =
 * `sequential` (default); `flat` lets every hint open in any order. The portal
 * reads it off the scoring view and drops its order gate accordingly.
 */
export type ContainerHintRevealMode = "sequential" | "flat";

export interface ContainerVerifyScoring {
  readonly kind: "verify";
  readonly points: number;
  readonly wrongAnswerPenalty: number;
  readonly hints: readonly ContainerHint[];
  readonly hintReveal?: ContainerHintRevealMode;
}

/**
 * [#2252] One container-judged checkpoint of a `multi-verify` problem. The
 * container owns the answer per checkpoint (`POST /verify` with `checkpointId`);
 * the platform holds only display text and points.
 */
export interface ContainerCheck {
  readonly id: string;
  readonly label: string;
  readonly points: number;
  readonly wrongAnswerPenalty: number;
  readonly hints: readonly ContainerHint[];
  /** `metadata.i18n.en.checks[]` translation of `label`, matched by id. */
  readonly i18n?: { readonly en?: { readonly label: string } };
}

export interface ContainerMultiVerifyScoring {
  readonly kind: "multi-verify";
  readonly checks: readonly ContainerCheck[];
  /** Σ checks[].points — the problem total (= 部分点の母数). */
  readonly totalPoints: number;
  /** Top-level hint unlock order shared by every check. Unset = `sequential`. */
  readonly hintReveal?: ContainerHintRevealMode;
}

export type ContainerScoring = ContainerVerifyScoring | ContainerMultiVerifyScoring;

export interface ContainerProblem {
  readonly problemId: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  /** Issue #2191: canonical JA learning explanation, released only after local solve. */
  readonly writeup?: string;
  /** English writeup kept separate so it cannot enter an unsolved API response via `i18n`. */
  readonly writeupI18n?: string;
  /** `metadata.i18n` overlay (currently `en` only). Absent when no translation. */
  readonly i18n?: { readonly en?: LocalizedProblemText };
  /** Absolute path to the problem directory (the metadata.json lives here). */
  readonly problemDir: string;
  /** Absolute path to the docker compose file that brings up the container. */
  readonly composePath: string;
  /** `docker compose -p` project name, derived from the problem id. */
  readonly composeProjectName: string;
  /**
   * Participant-facing loopback URLs surfaced in the portal. The normalized record
   * is empty when verifier-only metadata omits optional `challengeEndpoints`.
   */
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
  /** Directory entry names under `path` (used only by {@link listLocalPlayProblems}). */
  readonly readDirNames?: (path: string) => readonly string[];
}

const NODE_FS: ManifestFs = {
  existsSync,
  readFileSync: (path) => readFileSync(path, "utf8"),
  readDirNames: (path) => {
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  },
};

interface RawMetadata {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly instructions?: unknown;
  readonly writeup?: unknown;
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
    readonly checks?: unknown;
    readonly hintReveal?: unknown;
  };
  readonly i18n?: {
    readonly en?: {
      readonly name?: unknown;
      readonly description?: unknown;
      readonly instructions?: unknown;
      readonly writeup?: unknown;
      readonly hints?: unknown;
      readonly checks?: unknown;
    };
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

/** Narrow `scoring.hintReveal`; only the two literals count, else undefined (= sequential). */
function parseHintReveal(value: unknown): ContainerHintRevealMode | undefined {
  return value === "flat" || value === "sequential" ? value : undefined;
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
  // A verifier-only problem (for example, a code-editing cryptography lab) has no
  // participant-facing network surface. `verifyUrl` remains mandatory and is the
  // readiness/scoring seam, so omitting this optional record is safe and explicit.
  if (value === undefined) return {};
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

function normalizeHints(
  value: unknown,
  enHintById: ReadonlyMap<string, string>,
): readonly ContainerHint[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("scoring.hints must be an array");
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`scoring.hints[${index}] must be an object`);
    }
    const hint = raw as { id?: unknown; content?: unknown; penalty?: unknown };
    const id = requiredString(hint.id, `scoring.hints[${index}].id`);
    const enContent = enHintById.get(id);
    return {
      id,
      content: requiredString(hint.content, `scoring.hints[${index}].content`),
      penalty: nonNegativeNumber(hint.penalty, `scoring.hints[${index}].penalty`, 0),
      ...(enContent !== undefined ? { i18n: { en: { content: enContent } } } : {}),
    };
  });
}

/** Optional non-empty string from an `i18n.en` field; undefined otherwise. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

type EnglishBlock = NonNullable<NonNullable<RawMetadata["i18n"]>["en"]>;

/** name/description/instructions overrides; undefined when none are usable. */
function parseEnglishText(en: EnglishBlock): LocalizedProblemText | undefined {
  const name = optionalString(en.name);
  const description = optionalString(en.description);
  const instructions = optionalString(en.instructions);
  const text: LocalizedProblemText = {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
  };
  return Object.keys(text).length > 0 ? text : undefined;
}

function parseWriteupFields(
  metadata: RawMetadata,
): Pick<ContainerProblem, "writeup" | "writeupI18n"> {
  const writeup = optionalString(metadata.writeup);
  const writeupI18n = optionalString(metadata.i18n?.en?.writeup);
  return {
    ...(writeup ? { writeup } : {}),
    ...(writeupI18n ? { writeupI18n } : {}),
  };
}

/** Map `hint id → translated content`; malformed entries are skipped. */
function parseEnglishHintMap(hints: unknown): ReadonlyMap<string, string> {
  const hintById = new Map<string, string>();
  if (!Array.isArray(hints)) return hintById;
  for (const raw of hints) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as { id?: unknown; content?: unknown };
    const id = optionalString(entry.id);
    const content = optionalString(entry.content);
    if (id !== undefined && content !== undefined) hintById.set(id, content);
  }
  return hintById;
}

interface EnglishCheckOverlay {
  readonly label?: string;
  readonly hintById: ReadonlyMap<string, string>;
}

/**
 * [#2252] `i18n.en.checks[]` → `check id → { label, hint id → content }`.
 * Translation carries display text only — points / ids never live in the
 * overlay (the metadata top-level stays the single source of scoring truth).
 * Malformed entries are skipped (missing translation = ja fallback).
 */
function parseEnglishCheckMap(checks: unknown): ReadonlyMap<string, EnglishCheckOverlay> {
  const checkById = new Map<string, EnglishCheckOverlay>();
  if (!Array.isArray(checks)) return checkById;
  for (const raw of checks) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as { id?: unknown; label?: unknown; hints?: unknown };
    const id = optionalString(entry.id);
    if (id === undefined) continue;
    const label = optionalString(entry.label);
    checkById.set(id, {
      ...(label !== undefined ? { label } : {}),
      hintById: parseEnglishHintMap(entry.hints),
    });
  }
  return checkById;
}

/**
 * Build the `metadata.i18n.en` overlay (name/description/instructions) and a
 * map of `id → translated hint content`. The locale data is competitor-facing
 * text only; the platform still never learns the answer. Returns an empty
 * overlay (and empty map) when no translation is present.
 */
function parseEnglishOverlay(i18n: RawMetadata["i18n"]): {
  readonly text?: LocalizedProblemText;
  readonly hintById: ReadonlyMap<string, string>;
  readonly checkById: ReadonlyMap<string, EnglishCheckOverlay>;
} {
  const en = i18n?.en;
  if (!en) return { hintById: new Map(), checkById: new Map() };
  const text = parseEnglishText(en);
  return {
    ...(text ? { text } : {}),
    hintById: parseEnglishHintMap(en.hints),
    checkById: parseEnglishCheckMap(en.checks),
  };
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

export interface LocalPlayProblemSummary {
  readonly problemId: string;
  readonly name: string;
  /** The search root's directory name (e.g. `challenges` / `battles`). */
  readonly category: string;
}

/**
 * Issue #2188: enumerate every problem under `roots` that is playable locally
 * (= `loadContainerProblem` accepts it — `runtime.provider=docker`, a
 * `local/docker-compose.yml`, container-judged scoring). Problems that fail to
 * load as a container problem (AWS-only, malformed, no compose entry) are
 * skipped rather than failing the whole listing — `make local list` shows
 * "what you *can* play", not a validation report.
 */
export function listLocalPlayProblems(
  roots: readonly string[],
  fs: ManifestFs = NODE_FS,
): readonly LocalPlayProblemSummary[] {
  const readDirNames = fs.readDirNames ?? NODE_FS.readDirNames;
  if (!readDirNames) throw new Error("listLocalPlayProblems requires fs.readDirNames");
  const summaries: LocalPlayProblemSummary[] = [];
  for (const root of roots) {
    for (const problemId of readDirNames(root)) {
      const problemDir = join(root, problemId);
      if (!fs.existsSync(join(problemDir, "metadata.json"))) continue;
      try {
        const problem = loadContainerProblem(problemDir, fs);
        summaries.push({
          problemId: problem.problemId,
          name: problem.name,
          category: basename(root),
        });
      } catch {
        // Not a local-play container problem (e.g. AWS-only or malformed) — skip.
      }
    }
  }
  return [...summaries].sort((a, b) => a.problemId.localeCompare(b.problemId));
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
  // [#2252] local container problems score via the container's /verify: either a
  // single verdict ("verify") or per-checkpoint verdicts ("multi-verify").
  if (kind !== "verify" && kind !== "multi-verify") {
    throw new Error(
      `problem "${problemId}" is not a local container problem: scoring.kind=${kind} (expected "verify" or "multi-verify")`,
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

  const overlay = parseEnglishOverlay(metadata.i18n);
  const containerScoring =
    kind === "verify"
      ? parseVerifyScoring(scoring, overlay.hintById)
      : parseMultiVerifyScoring(scoring, overlay.checkById);

  return {
    problemId,
    name:
      typeof metadata.name === "string" && metadata.name.trim().length > 0
        ? metadata.name
        : problemId,
    description: typeof metadata.description === "string" ? metadata.description : "",
    instructions: typeof metadata.instructions === "string" ? metadata.instructions : "",
    ...parseWriteupFields(metadata),
    ...(overlay.text ? { i18n: { en: overlay.text } } : {}),
    problemDir,
    composePath,
    composeProjectName: `tc-local-${problemId}`,
    challengeEndpoints: normalizeEndpoints(runtime.challengeEndpoints),
    verifyUrl: loopbackUrl(runtime.verifyUrl, "runtime.verifyUrl"),
    secretEnv: normalizeSecretEnv(runtime.secretEnv),
    scoring: containerScoring,
  };
}

function parseVerifyScoring(
  scoring: RawMetadata["scoring"],
  hintById: ReadonlyMap<string, string>,
): ContainerVerifyScoring {
  const points = nonNegativeNumber(scoring?.points, "scoring.points");
  if (points <= 0) throw new Error("scoring.points must be greater than zero");
  const hintReveal = parseHintReveal(scoring?.hintReveal);
  return {
    kind: "verify",
    points,
    wrongAnswerPenalty: nonNegativeNumber(
      scoring?.wrongAnswerPenalty,
      "scoring.wrongAnswerPenalty",
      0,
    ),
    hints: normalizeHints(scoring?.hints, hintById),
    ...(hintReveal ? { hintReveal } : {}),
  };
}

// #2252 structural contract — kept byte-identical to the SDK parser
// (packages/problem-sdk) and the catalog validator so the same fixture is valid
// in all three: id starts alphanumeric, 1–64 chars; labels ≤80; 2–8 checks.
const CHECK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHECK_LABEL_MAX = 80;
const MIN_CHECKS = 2;
const MAX_CHECKS = 8;

/**
 * [#2252] Validate `scoring.checks` loudly (make local fails with the exact
 * field). Constraints per the issue contract, matching the catalog validator:
 * 2–8 checks; ids `^[a-z0-9][a-z0-9-]{0,63}$` and unique; labels non-empty and
 * ≤80 chars; positive integer points; `wrongAnswerPenalty` a non-negative
 * integer ≤ that check's points. Hint ids must additionally be unique across the
 * whole problem: the portal's reveal route is keyed on `hintId` alone, so a
 * cross-check collision would make a reveal ambiguous.
 */
function parseMultiVerifyScoring(
  scoring: RawMetadata["scoring"],
  checkById: ReadonlyMap<string, EnglishCheckOverlay>,
): ContainerMultiVerifyScoring {
  const rawChecks = scoring?.checks;
  if (!Array.isArray(rawChecks) || rawChecks.length < MIN_CHECKS || rawChecks.length > MAX_CHECKS) {
    throw new Error(`scoring.checks must have ${MIN_CHECKS}–${MAX_CHECKS} entries (multi-verify)`);
  }
  const seenCheckIds = new Set<string>();
  const seenHintIds = new Set<string>();
  const checks = rawChecks.map((raw, index) =>
    parseOneCheck(raw, index, checkById, seenCheckIds, seenHintIds),
  );
  const hintReveal = parseHintReveal(scoring?.hintReveal);
  return {
    kind: "multi-verify",
    checks,
    totalPoints: checks.reduce((sum, check) => sum + check.points, 0),
    ...(hintReveal ? { hintReveal } : {}),
  };
}

/** Validate + normalize one multi-verify check (throws with the exact field). */
function parseOneCheck(
  raw: unknown,
  index: number,
  checkById: ReadonlyMap<string, EnglishCheckOverlay>,
  seenCheckIds: Set<string>,
  seenHintIds: Set<string>,
): ContainerCheck {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`scoring.checks[${index}] must be an object`);
  }
  const check = raw as {
    id?: unknown;
    label?: unknown;
    points?: unknown;
    wrongAnswerPenalty?: unknown;
    hints?: unknown;
  };
  const id = requiredString(check.id, `scoring.checks[${index}].id`);
  if (!CHECK_ID_RE.test(id)) {
    throw new Error(
      `scoring.checks[${index}].id must match ^[a-z0-9][a-z0-9-]{0,63}$ (got "${id}")`,
    );
  }
  if (seenCheckIds.has(id)) {
    throw new Error(`scoring.checks[${index}].id "${id}" is duplicated`);
  }
  seenCheckIds.add(id);
  const label = requiredString(check.label, `scoring.checks[${index}].label`);
  if (label.length > CHECK_LABEL_MAX) {
    throw new Error(
      `scoring.checks[${index}].label must be ${CHECK_LABEL_MAX} characters or fewer`,
    );
  }
  const points = nonNegativeNumber(check.points, `scoring.checks[${index}].points`);
  if (points <= 0 || !Number.isInteger(points)) {
    throw new Error(`scoring.checks[${index}].points must be a positive integer`);
  }
  const wrongAnswerPenalty = nonNegativeNumber(
    check.wrongAnswerPenalty,
    `scoring.checks[${index}].wrongAnswerPenalty`,
    0,
  );
  if (wrongAnswerPenalty > points) {
    throw new Error(
      `scoring.checks[${index}].wrongAnswerPenalty must not exceed the check points (${points})`,
    );
  }
  const overlay = checkById.get(id);
  const hints = normalizeHints(check.hints, overlay?.hintById ?? new Map());
  for (const hint of hints) {
    if (seenHintIds.has(hint.id)) {
      throw new Error(
        `scoring.checks[${index}].hints id "${hint.id}" is duplicated (hint ids must be unique across the problem)`,
      );
    }
    seenHintIds.add(hint.id);
  }
  return {
    id,
    label,
    points,
    wrongAnswerPenalty,
    hints,
    ...(overlay?.label !== undefined ? { i18n: { en: { label: overlay.label } } } : {}),
  };
}
