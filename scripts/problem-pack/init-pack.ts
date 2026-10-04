/**
 * [Problem Packs / Issue #2089] `tenkacloud pack init` scaffolder.
 *
 * Generates a fresh, validator-passing problem pack: the `tenkacloud-pack.json`
 * manifest, one valid problem directory (`metadata.json` + a provider artifact
 * placeholder), and an author README. The output is consumed by the #2088
 * validator with zero diagnostics — by construction, since this module reuses the
 * #2087 manifest contract to self-check the manifest it emits.
 *
 * Design split:
 *   - {@link buildPackScaffold} is PURE: (options) → ordered `Map<relPath, content>`.
 *     It performs NO filesystem I/O, so it is trivially testable and its output is
 *     fully deterministic — there is NO `generatedAt` field, no timestamp, and no
 *     randomness. Equal options always yield byte-identical files.
 *   - {@link writePackScaffold} is the thin I/O wrapper: it refuses an unsafe or
 *     non-empty target, then writes the planned tree.
 *
 * v1 emits no cloud credentials, no remote URLs, no scripts, and no executable
 * hooks — the scaffold is inert text and a single inert artifact placeholder.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type PACK_PROVIDERS, parsePackManifest } from "./manifest.js";
import { PACK_MANIFEST_FILENAME } from "./validate-pack.js";

/** The supported scaffold runtimes in v1 (`<provider>/<engine>`). */
export const SCAFFOLD_RUNTIMES = [
  "aws/cloudformation",
  "gcp/infra-manager",
  "azure/bicep",
  "sakura/apprun",
] as const;

/** One of the {@link SCAFFOLD_RUNTIMES}. */
export type PackInitRuntime = (typeof SCAFFOLD_RUNTIMES)[number];

/** The default runtime when `--runtime` is omitted: the one cloud-executable pair. */
export const DEFAULT_SCAFFOLD_RUNTIME: PackInitRuntime = "aws/cloudformation";

/** Options for {@link buildPackScaffold} / {@link writePackScaffold}. */
export interface PackInitOptions {
  /** Reverse-DNS pack id, e.g. `com.example.starter`. */
  readonly packId: string;
  /** Which provider runtime to scaffold. Defaults to {@link DEFAULT_SCAFFOLD_RUNTIME}. */
  readonly runtime?: PackInitRuntime;
}

/** Per-runtime scaffold facts: provider/engine split + the artifact placeholder. */
interface RuntimeScaffold {
  readonly provider: (typeof PACK_PROVIDERS)[number];
  readonly engine: string;
  /** Artifact filename written into the problem directory. */
  readonly artifact: string;
  /** Inert placeholder contents for that artifact. */
  readonly artifactBody: string;
}

const RUNTIME_SCAFFOLDS: Record<PackInitRuntime, RuntimeScaffold> = {
  "aws/cloudformation": {
    provider: "aws",
    engine: "cloudformation",
    artifact: "template.yaml",
    artifactBody: cloudformationPlaceholder(),
  },
  "gcp/infra-manager": {
    provider: "gcp",
    engine: "infra-manager",
    artifact: "main.tf",
    artifactBody: terraformPlaceholder(),
  },
  "azure/bicep": {
    provider: "azure",
    engine: "bicep",
    artifact: "main.bicep",
    artifactBody: bicepPlaceholder(),
  },
  "sakura/apprun": {
    provider: "sakura",
    engine: "apprun",
    artifact: "apprun.yaml",
    artifactBody: appRunPlaceholder(),
  },
};

/** The single scaffolded problem's id + directory layout. Stable so output is deterministic. */
const PROBLEMS_ROOT = "problems";
const PROBLEM_CATEGORY = "challenges";
const PROBLEM_DIR = "hello-world";
const PROBLEM_ID = "hello-world";

/**
 * Build the deterministic set of files for a new pack. Pure: no I/O, no clock,
 * no randomness. Returns an insertion-ordered map keyed by pack-relative POSIX
 * path. Throws a plain `Error` when the pack id or runtime is invalid.
 */
export function buildPackScaffold(options: PackInitOptions): Map<string, string> {
  const runtime = resolveRuntime(options.runtime);
  const scaffold = RUNTIME_SCAFFOLDS[runtime];
  const manifest = buildManifest(options.packId, scaffold);
  assertManifestValid(manifest);

  const problemRel = `${PROBLEMS_ROOT}/${PROBLEM_CATEGORY}/${PROBLEM_DIR}`;
  const files = new Map<string, string>();
  files.set(PACK_MANIFEST_FILENAME, json(manifest));
  files.set("README.md", buildReadme(options.packId, runtime, scaffold));
  files.set(`${problemRel}/metadata.json`, json(buildMetadata(scaffold)));
  files.set(`${problemRel}/${scaffold.artifact}`, scaffold.artifactBody);
  return files;
}

/**
 * Scaffold a new pack on disk under `targetDir`. Refuses an unsafe target path
 * (a `..` traversal segment) and a non-empty existing directory, so it never
 * clobbers existing work. Creates `targetDir` (and parents) when absent.
 */
export function writePackScaffold(targetDir: string, options: PackInitOptions): void {
  assertSafeTarget(targetDir);
  const target = path.resolve(targetDir);
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) {
      throw new Error(`Target '${targetDir}' exists and is not a directory.`);
    }
    if (fs.readdirSync(target).length > 0) {
      throw new Error(
        `Target directory '${targetDir}' is not empty; pack init refuses to clobber it.`,
      );
    }
  }

  const files = buildPackScaffold(options);
  for (const [rel, content] of files) {
    const abs = path.join(target, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function resolveRuntime(runtime: PackInitRuntime | undefined): PackInitRuntime {
  const chosen = runtime ?? DEFAULT_SCAFFOLD_RUNTIME;
  if (!(chosen in RUNTIME_SCAFFOLDS)) {
    throw new Error(`Unsupported runtime '${chosen}'. Supported: ${SCAFFOLD_RUNTIMES.join(", ")}.`);
  }
  return chosen;
}

/** A `..` traversal segment in the target is rejected before any write. */
function assertSafeTarget(targetDir: string): void {
  if (targetDir.length === 0) {
    throw new Error("Target directory must not be empty.");
  }
  if (targetDir.split(/[\\/]/).includes("..")) {
    throw new Error(`Target '${targetDir}' is unsafe: it contains a '..' traversal segment.`);
  }
}

function buildManifest(packId: string, scaffold: RuntimeScaffold): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: packId,
    version: "0.1.0",
    core: "^1.0.0",
    title: "Starter pack",
    description:
      "A scaffolded TenkaCloud problem pack. Edit the metadata and artifact, then validate.",
    license: "Apache-2.0",
    problemsRoot: PROBLEMS_ROOT,
    requiredRuntimes: [{ provider: scaffold.provider, engine: scaffold.engine }],
  };
}

function buildMetadata(scaffold: RuntimeScaffold): Record<string, unknown> {
  return {
    id: PROBLEM_ID,
    title: "Hello World",
    category: PROBLEM_CATEGORY,
    description: "A starter problem. Replace this with your own challenge.",
    runtime: {
      provider: scaffold.provider,
      engine: scaffold.engine,
      entry: scaffold.artifact,
    },
  };
}

/** Re-validate the emitted manifest through the #2087 contract — single source of truth. */
function assertManifestValid(manifest: Record<string, unknown>): void {
  const result = parsePackManifest(manifest);
  if (!result.ok) {
    const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Generated manifest is invalid (${detail}).`);
  }
}

function buildReadme(packId: string, runtime: PackInitRuntime, scaffold: RuntimeScaffold): string {
  return [
    `# ${packId}`,
    "",
    "A TenkaCloud problem pack scaffolded with `tenkacloud pack init`.",
    "",
    `Runtime: \`${runtime}\` (artifact \`${scaffold.artifact}\`).`,
    "",
    "## Layout",
    "",
    "```",
    `${PACK_MANIFEST_FILENAME}                       # pack manifest (the only entrypoint)`,
    `${PROBLEMS_ROOT}/${PROBLEM_CATEGORY}/${PROBLEM_DIR}/`,
    "  metadata.json                          # problem source of truth",
    `  ${scaffold.artifact}                          # provider artifact placeholder`,
    "```",
    "",
    "## Validate",
    "",
    "Run the offline validator against this directory, from the TenkaCloud repo root:",
    "",
    "```bash",
    'make pack-validate ARGS="<path-to-this-pack>"',
    "```",
    "",
    "## Test",
    "",
    "Author tests live alongside your problems. Run them with your usual runner;",
    "the pack validator above is the contract this pack must always pass.",
    "",
    "## Version",
    "",
    `Bump the \`version\` field in \`${PACK_MANIFEST_FILENAME}\` (SemVer) on every change,`,
    "and keep `core` aligned with the platform release range you target.",
    "",
    "## Publish",
    "",
    "Publishing is out of band: validate, commit, tag the pack version, and share",
    "the directory or archive. The pack carries no credentials and no secrets.",
    "",
  ].join("\n");
}

/** Two-space-indented JSON with a trailing newline — stable, diff-friendly output. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function cloudformationPlaceholder(): string {
  return [
    "AWSTemplateFormatVersion: '2010-09-09'",
    "Description: Starter deploy body. Replace the resources with your problem.",
    "Resources: {}",
    "",
  ].join("\n");
}

function terraformPlaceholder(): string {
  return [
    "# Starter Infrastructure Manager (Terraform) deploy body.",
    "# Replace with the resources your problem provisions.",
    "terraform {",
    '  required_version = ">= 1.5.0"',
    "}",
    "",
  ].join("\n");
}

function bicepPlaceholder(): string {
  return [
    "// Starter Bicep deploy body. Replace with your problem's resources.",
    "targetScope = 'resourceGroup'",
    "",
  ].join("\n");
}

function appRunPlaceholder(): string {
  return [
    "# Starter Sakura AppRun deploy body. Replace with your problem's app spec.",
    "name: hello-world",
    "components: []",
    "",
  ].join("\n");
}
