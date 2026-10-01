import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type ContainerScoring,
  type LocalizedProblemText,
  parseEnglishOverlay,
  parseMultiVerifyScoring,
  parseVerifyScoring,
  parseWriteupFields,
  type RawMetadata,
  requiredString,
} from "../../lib/problem-presentation";
import { resolveComposeEntryPath } from "./compose-policy";
import { parseLoopbackUrl } from "./loopback";
import type { NativeCompatibilityRequirement } from "./native-compatibility";

/**
 * [#2846/#2850] Explicit per-problem opt-in for the portal container terminal.
 *
 * A shell reaches whatever the named service's image holds, so attaching one is an
 * authorization decision the problem author must make, not a default the platform
 * assumes. Problems that do not declare `runtime.terminal` get no terminal: no portal
 * panel, no handoff ticket, no attach. The named service is the only one a shell may
 * enter — there is no fallback to "the first compose service", which on a
 * multi-service problem is merely whichever name sorts first alphabetically.
 *
 * Declaring is necessary but not sufficient: at attach time the docker adapter
 * verifies against the live compose config that the named service builds with
 * `target: participant` (the catalog convention whose participant stage excludes
 * `reference/` and other author-only material) and refuses the shell otherwise.
 */
export interface ContainerTerminal {
  /** The compose service a shell may attach to. */
  readonly service: string;
}

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
  /** Env var names filled with a per-problem secret derived by HMAC from the deployment key (e.g. FLAG_SEED). */
  readonly secretEnv: readonly string[];
  /** [#2850] Portal terminal opt-in; absent = this problem has no terminal. */
  readonly terminal?: ContainerTerminal;
  /**
   * [#3008] Host requirements without which this problem's *result* is meaningless.
   * Absent = the problem runs anywhere, which is every problem in the catalog today.
   */
  readonly compatibility?: NativeCompatibilityRequirement;
  readonly scoring: ContainerScoring;
}

export interface ManifestFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string) => string;
  /** Directory entry names under `path` (used only by {@link listLocalPlayProblems}). */
  readonly readDirNames?: (path: string) => readonly string[];
  /**
   * Resolves symlinks (used only by the `runtime.entry` containment check in
   * {@link loadContainerProblem}, via `compose-policy.ts#resolveComposeEntryPath`). Optional and
   * deliberately NOT defaulted to the real `node:fs` implementation when a caller supplies its
   * own fake `ManifestFs` without it — an in-memory test fixture has nothing on real disk to
   * resolve, and falling back to the real filesystem there would look up a path that does not
   * exist and fail every such test. Omitting it only narrows the check to lexical containment
   * (still rejects `..` traversal and absolute paths), never widens what production accepts.
   */
  readonly realpathSync?: (path: string) => string;
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
  realpathSync,
};

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

/**
 * Compose service-name shape, additionally required to start alphanumeric so the value
 * can never be read as a CLI flag when handed to `compose exec <service>` as argv.
 */
const TERMINAL_SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** [#2850] `runtime.terminal` opt-in: absent = no terminal; declared = service required. */
function normalizeTerminal(value: unknown): ContainerTerminal | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime.terminal must be an object");
  }
  const service = requiredString(
    (value as { service?: unknown }).service,
    "runtime.terminal.service",
  );
  if (!TERMINAL_SERVICE_RE.test(service)) {
    throw new Error(
      `runtime.terminal.service must match ${TERMINAL_SERVICE_RE} (got "${service}")`,
    );
  }
  return { service };
}

/**
 * Architecture and CPU-flag tokens as the OCI platform names and `/proc/cpuinfo` spell
 * them. Constrained here rather than accepted free-form because a typo like `x86-64 ` or
 * `AMD64!` would otherwise become an architecture no host can ever match, turning the
 * problem permanently unstartable with a message blaming the participant's machine.
 */
const COMPATIBILITY_TOKEN_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * [#3008] `runtime.compatibility` opt-in: absent = runs anywhere. Declared but empty is
 * rejected rather than treated as absent — an author who wrote the key meant to constrain
 * something, and silently ignoring it is how an emulated benchmark ships.
 */
function normalizeCompatibility(value: unknown): NativeCompatibilityRequirement | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime.compatibility must be an object");
  }
  const raw = value as { nativeArchitectures?: unknown; cpuFlags?: unknown };
  const nativeArchitectures = normalizeCompatibilityTokens(
    raw.nativeArchitectures,
    "runtime.compatibility.nativeArchitectures",
  );
  const cpuFlags = normalizeCompatibilityTokens(raw.cpuFlags, "runtime.compatibility.cpuFlags");
  if (nativeArchitectures === undefined && cpuFlags === undefined) {
    throw new Error(
      "runtime.compatibility must declare nativeArchitectures or cpuFlags (an empty declaration would silently allow every host)",
    );
  }
  return {
    ...(nativeArchitectures ? { nativeArchitectures } : {}),
    ...(cpuFlags ? { cpuFlags } : {}),
  };
}

function normalizeCompatibilityTokens(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length === 0) throw new Error(`${field} must not be empty`);
  const tokens = value.map((entry, index) => {
    if (typeof entry !== "string" || !COMPATIBILITY_TOKEN_RE.test(entry)) {
      throw new Error(`${field}[${index}] must match ${COMPATIBILITY_TOKEN_RE}`);
    }
    return entry;
  });
  if (new Set(tokens).size !== tokens.length) {
    throw new Error(`${field} must not repeat a value`);
  }
  return tokens;
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
  if (matches[0] === undefined) {
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
  /**
   * [#3008] The problem's host requirements, when it declares any. Carried here so
   * `tenkacloud local list` can mark a problem this machine cannot run *before* the
   * participant picks it — the full problem is already loaded to build this summary, so
   * it costs nothing to keep.
   */
  readonly compatibility?: NativeCompatibilityRequirement;
}

/**
 * Issue #2188: enumerate every problem under `roots` that is playable locally
 * (= `loadContainerProblem` accepts it — `runtime.provider=docker`, a
 * `local/docker-compose.yml`, container-judged scoring). Problems that fail to
 * load as a container problem (AWS-only, malformed, no compose entry) are
 * skipped rather than failing the whole listing — `make local list` shows
 * "what you *can* play", not a validation report.
 *
 * ## `status` で絞らないのは意図である (#2965)
 *
 * カタログは現在 ready 23 / draft 44 で、**pin された入門ドリル `sqli-demo` 自身が draft**。
 * ここで `status === "ready"` に絞ると、local play から 67 問中 44 問が消え、最初の 1 問すら
 * 出なくなる。local play は出題者が手元で確認する場でもあるので、draft が見えるのが正しい。
 *
 * つまり「draft を出す」は決定であって未整理の副作用ではない。SaaS 側の participant 向け
 * 公開範囲は `visibility` が担っており、そちらとは別の軸である。この決定は
 * `test/scripts/local-play-draft-visibility.test.ts` が固定する。
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
          ...(problem.compatibility ? { compatibility: problem.compatibility } : {}),
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
  // [Issue #3097] `runtime.entry` must resolve inside `problemDir` — no lexical `..` escape and
  // no symlink escape after resolution. See compose-policy.ts#resolveComposeEntryPath.
  const composePath = resolveComposeEntryPath(problemDir, composeName, fs);

  const terminal = normalizeTerminal(runtime.terminal);
  const compatibility = normalizeCompatibility(runtime.compatibility);
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
    ...(terminal ? { terminal } : {}),
    ...(compatibility ? { compatibility } : {}),
    scoring: containerScoring,
  };
}
