/**
 * [Issue #2743] Azure Bicep -> inline ARM template materialization.
 *
 * Azure Deployment Stacks PUT accepts `properties.template` (inline ARM JSON) as an alternative to
 * `properties.templateLink` (a reachable URI). The platform adopts the inline contract for
 * `azure/bicep` problems: `runtime.entry` never flows to ARM as a raw string (a repo-relative
 * `.bicep` path is not a valid `templateLink.uri` — Issue #2743). Instead the adapter always
 * materializes an inline ARM JSON document here, then the REST client sends it as
 * `properties.template`. This sidesteps blob upload / SAS-URL reachability entirely.
 *
 * Two source shapes, dispatched by `entry`'s extension:
 *   - `.json` — a precompiled ARM template already committed beside the `.bicep` source. Read raw,
 *     parsed, and shape-checked (`$schema` + `resources`), then returned inline as-is.
 *   - `.bicep` — compiled via the injected {@link BicepCompiler} seam. The default
 *     ({@link createBicepCliCompiler}) shells out to a `bicep` CLI on PATH (`execFile`, no shell
 *     interpolation, no runtime binary download — supply-chain rule). When the CLI is not on PATH,
 *     or the compile fails, this FAILS CLOSED with the compiler's diagnostics surfaced in the
 *     thrown error — it never silently skips compilation or falls back to a stale/empty template.
 *
 * Anything else (a different extension, a path-traversal `entry`, or a missing artifact) fails
 * closed before any Azure call — `AzureBicepRuntimeAdapter.deploy` awaits this materializer BEFORE
 * touching `AzureDeploymentStackClient.upsertStack`.
 *
 * Provenance: the sha256 of the raw source bytes actually read (the `.bicep` or `.json` file
 * content) is returned alongside the document so the caller can pin it into the deploy trace log —
 * a non-secret, content-addressed record of exactly what was materialized.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** ARM JSON document shape this module produces / accepts (a parsed JSON object). */
export type JsonObject = Readonly<Record<string, unknown>>;

/** Result of a successful `.bicep` compile: the compiled ARM JSON plus compiler diagnostics. */
export interface BicepCompileResult {
  readonly armJson: JsonObject;
  readonly diagnostics: readonly string[];
}

/** Injected `.bicep` -> ARM JSON compiler seam. */
export interface BicepCompiler {
  compile(source: string): Promise<BicepCompileResult>;
}

/** Thrown by a {@link BicepCompiler} on a failed compile (CLI absent OR a real compile error). */
export class BicepCompileError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: readonly string[] = [],
  ) {
    super(message);
    this.name = "BicepCompileError";
  }
}

/** The materialized, ready-to-send-inline ARM template + its source provenance. */
export interface InlineArmTemplate {
  readonly document: JsonObject;
  /** sha256 (hex) of the raw source bytes read for `entry` (the `.bicep` or `.json` file content). */
  readonly sourceSha256: string;
  /** Compiler diagnostics (warnings) from a `.bicep` compile; empty for a precompiled `.json` read. */
  readonly diagnostics: readonly string[];
}

export interface MaterializeAzureTemplateDeps {
  /** Read the raw text of `entry` from wherever this deployment's problem artifact lives. */
  readonly readArtifact: (entry: string) => Promise<string>;
  /** `.bicep` compiler seam. Required only when `entry` ends in `.bicep`. */
  readonly compiler?: BicepCompiler;
  /** Size cap on the raw source text, in bytes. Defaults to {@link DEFAULT_MAX_TEMPLATE_BYTES}. */
  readonly maxTemplateBytes?: number;
}

/** Fail-closed materializer error: no Azure call is ever made once this is thrown. */
export class AzureTemplateMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureTemplateMaterializationError";
  }
}

/** 1 MiB — generous for a single ARM template body, far above any real problem's compiled size. */
export const DEFAULT_MAX_TEMPLATE_BYTES = 1024 * 1024;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Safe error stringification shared by every `catch (err: unknown)` in this module (a parsed-JSON
 * failure, an injected `readArtifact`/`compiler`/`runBuild` rejection). `err` is `unknown`, so this
 * is the one place that decides how to render it. Consolidated instead of a `err instanceof Error ?
 * err.message : String(err)` ternary repeated per call site: `JSON.parse` only ever throws a real
 * `Error`, so testing that ternary's `String(err)` side in isolation there would mean exercising a
 * branch that is dead in practice; centralizing it here lets the *reachable* non-Error case (an
 * injected dependency rejecting with a plain string/value, which real Bicep-compiler or
 * artifact-read implementations can do) cover every call site's fallback in one real test.
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fail closed before any read when `entry` is not a plain relative filename. */
function assertSafeEntry(entry: string): void {
  if (!entry || entry.startsWith("/") || entry.includes("..") || entry.includes("\0")) {
    throw new AzureTemplateMaterializationError(
      `Azure template entry '${entry}' must be a relative path inside the problem artifact (no absolute paths or '..' traversal)`,
    );
  }
}

function assertWithinSize(entry: string, raw: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > maxBytes) {
    throw new AzureTemplateMaterializationError(
      `Azure template '${entry}' is ${bytes} bytes, exceeding the ${maxBytes}-byte cap`,
    );
  }
}

/** Shape-check a parsed ARM template: a JSON object declaring `$schema` + a `resources` array. */
function assertArmTemplateShape(entry: string, parsed: unknown): JsonObject {
  if (!isJsonObject(parsed)) {
    throw new AzureTemplateMaterializationError(
      `Azure template '${entry}' must parse as a JSON object`,
    );
  }
  if (typeof parsed.$schema !== "string" || parsed.$schema.length === 0) {
    throw new AzureTemplateMaterializationError(
      `Azure template '${entry}' is missing a string '$schema'`,
    );
  }
  if (!Array.isArray(parsed.resources)) {
    throw new AzureTemplateMaterializationError(
      `Azure template '${entry}' is missing a 'resources' array`,
    );
  }
  return parsed as JsonObject;
}

function parsePrecompiledArmJson(entry: string, raw: string, maxBytes: number): JsonObject {
  assertWithinSize(entry, raw, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AzureTemplateMaterializationError(
      `Azure template '${entry}' is not valid JSON: ${describeError(err)}`,
    );
  }
  return assertArmTemplateShape(entry, parsed);
}

async function materializePrecompiled(
  entry: string,
  deps: MaterializeAzureTemplateDeps,
  maxBytes: number,
): Promise<InlineArmTemplate> {
  const raw = await deps.readArtifact(entry);
  const document = parsePrecompiledArmJson(entry, raw, maxBytes);
  return { document, sourceSha256: sha256Hex(raw), diagnostics: [] };
}

async function materializeBicep(
  entry: string,
  deps: MaterializeAzureTemplateDeps,
  maxBytes: number,
): Promise<InlineArmTemplate> {
  if (!deps.compiler) {
    throw new AzureTemplateMaterializationError(
      `no Bicep compiler is configured to materialize '${entry}'; precompile it to ARM JSON and ` +
        "point the problem's runtime entry at the .json file, or wire a BicepCompiler.",
    );
  }
  const raw = await deps.readArtifact(entry);
  assertWithinSize(entry, raw, maxBytes);
  let compiled: BicepCompileResult;
  try {
    compiled = await deps.compiler.compile(raw);
  } catch (err) {
    const diagnostics = err instanceof BicepCompileError ? err.diagnostics : [];
    const detail = diagnostics.length > 0 ? ` (${diagnostics.join("; ")})` : "";
    throw new AzureTemplateMaterializationError(
      `Bicep compile failed for '${entry}': ${describeError(err)}${detail}`,
    );
  }
  const document = assertArmTemplateShape(entry, compiled.armJson);
  return { document, sourceSha256: sha256Hex(raw), diagnostics: compiled.diagnostics };
}

/**
 * Materialize `entry` (a composite/single-runtime Azure target's `runtime.entry`) into an inline
 * ARM JSON document. See module docs for the `.json` / `.bicep` / fail-closed dispatch.
 */
export async function materializeAzureTemplate(
  entry: string,
  deps: MaterializeAzureTemplateDeps,
): Promise<InlineArmTemplate> {
  assertSafeEntry(entry);
  const maxBytes = deps.maxTemplateBytes ?? DEFAULT_MAX_TEMPLATE_BYTES;
  const lower = entry.toLowerCase();

  if (lower.endsWith(".json")) {
    return materializePrecompiled(entry, deps, maxBytes);
  }
  if (lower.endsWith(".bicep")) {
    return materializeBicep(entry, deps, maxBytes);
  }
  throw new AzureTemplateMaterializationError(
    `unsupported Azure template entry '${entry}': expected a '.bicep' or precompiled '.json' file`,
  );
}

// ---------------------------------------------------------------------------
// Default BicepCompiler: shell out to a `bicep` CLI on PATH (no runtime download).
// ---------------------------------------------------------------------------

export interface BicepCliCompilerDeps {
  /**
   * Runs the compiler over `inFile`, writing compiled ARM JSON to `outFile`. Defaults to real
   * `execFile("bicep", ["build", inFile, "--outfile", outFile])` (argv array — no shell
   * interpolation). Injected in tests so no real `bicep` binary is required.
   */
  readonly runBuild?: (inFile: string, outFile: string) => Promise<{ readonly stderr: string }>;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function extractStderr(err: unknown): string {
  if (typeof err === "object" && err !== null && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.length > 0) return stderr;
  }
  return describeError(err);
}

function toDiagnosticLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function defaultRunBuild(inFile: string, outFile: string): Promise<{ stderr: string }> {
  // `promisify(execFile)`'s resolved `stderr` is typed (and, per Node's documented behavior with
  // the default utf8 encoding, always actually) a `string` — never `undefined`/`null` — so there is
  // no nullish fallback to apply here.
  const { stderr } = await execFileAsync("bicep", ["build", inFile, "--outfile", outFile]);
  return { stderr };
}

/**
 * Real {@link BicepCompiler}: writes `source` to a temp file and runs `bicep build --outfile` via
 * `execFile` (argv array — no shell interpolation). Never downloads a compiler binary at runtime
 * (supply-chain rule); when `bicep` is absent from PATH the child process fails with `ENOENT`,
 * which is translated into an actionable {@link BicepCompileError} rather than a cryptic spawn
 * failure. A non-zero exit (a real compile error) surfaces `stderr` as diagnostics.
 */
export function createBicepCliCompiler(deps: BicepCliCompilerDeps = {}): BicepCompiler {
  const runBuild = deps.runBuild ?? defaultRunBuild;
  return {
    async compile(source: string): Promise<BicepCompileResult> {
      const dir = await mkdtemp(join(tmpdir(), "tenkacloud-bicep-"));
      const inFile = join(dir, "main.bicep");
      const outFile = join(dir, "main.json");
      try {
        await writeFile(inFile, source, "utf8");
        let stderr: string;
        try {
          ({ stderr } = await runBuild(inFile, outFile));
        } catch (err) {
          if (isEnoent(err)) {
            throw new BicepCompileError(
              "bicep CLI not available in this runtime; precompile to ARM JSON and point the " +
                "problem's runtime entry at the .json file, or enable the compiler in the " +
                "execution image.",
            );
          }
          throw new BicepCompileError(
            "bicep build exited with an error",
            toDiagnosticLines(extractStderr(err)),
          );
        }
        const armJsonText = await readFile(outFile, "utf8");
        let armJson: unknown;
        try {
          armJson = JSON.parse(armJsonText);
        } catch (err) {
          throw new BicepCompileError(
            `bicep build produced non-JSON output: ${describeError(err)}`,
          );
        }
        if (!isJsonObject(armJson)) {
          throw new BicepCompileError("bicep build did not produce a JSON object");
        }
        return { armJson: armJson as JsonObject, diagnostics: toDiagnosticLines(stderr) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
