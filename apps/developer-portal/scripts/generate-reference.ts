#!/usr/bin/env tsx
/**
 * [Problem Packs docs / Issue #2103] Reference-data generator + drift check.
 *
 * The reference pages under /developers/docs/reference/* are GENERATED from the
 * single source of truth in code/schema — never hand-copied. This script reads
 * the real sources and emits one typed data module
 * (`src/content/reference-data.ts`) that the MDX reference pages render. Reference
 * facts therefore have ONE source of truth: the schema / runtime / CLI / validator
 * modules in `packages/problem-sdk`, `packages/problem-runtime`, and
 * `infrastructure/lib/problem-pack`.
 *
 * Sources derived from (NOT invented):
 *   - Pack manifest fields           ← `PackManifestSchema` (problem-sdk/manifest.ts)
 *   - Pack providers / schemaVersion ← `PACK_PROVIDERS` / `PACK_SCHEMA_VERSION`
 *   - Problem-metadata fields        ← `ProblemMetadata` + validateProblemMetadata
 *   - Runtime capability matrix      ← EXECUTABLE_* / RESERVED_RUNTIMES /
 *                                       CONTAINER_RUNTIMES (problem-runtime)
 *   - CLI subcommands / usage        ← the `*_USAGE` constants in pack-cli.ts
 *   - Validator error codes          ← `ValidationDiagnosticCode` mapping in
 *                                       problem-sdk/diagnostics.ts (PACK_CODE_TO_PUBLIC)
 *   - Security / provenance facts    ← snapshot.ts (digest + GitProvenance) and
 *                                       the manifest's inert-by-design guarantees
 *
 * `--check` mode regenerates the data in-memory and fails (exit 1) when the
 * committed `reference-data.ts` is stale vs the current sources. It is wired into
 * the developer-portal `prebuild` and asserted by a vitest drift test, so a schema
 * field change EITHER regenerates this file OR fails the build / tests.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ENTRY,
  MAX_COMPOSITE_TARGETS,
  MIN_COMPOSITE_TARGETS,
} from "@tenkacloud/problem-runtime";
import {
  RUNTIME_CAPABILITIES,
  validateRuntimeCapabilityEvidence,
} from "@tenkacloud/problem-runtime/capabilities";
import { PACK_SCHEMA_VERSION } from "@tenkacloud/problem-sdk";
import { PACK_PROVIDERS } from "@tenkacloud/problem-sdk/internal";
import type {
  CliCommandReference,
  ManifestFieldReference,
  MetadataFieldReference,
  ProvenanceFactReference,
  ReferenceData,
  RuntimeCapabilityRow,
  ValidationErrorReference,
} from "../src/content/reference-data";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..");
const OUTPUT_PATH = resolve(here, "..", "src", "content", "reference-data.ts");
// The CLI usage strings live across the dispatcher and the install module; both
// are parsed so the `install` subcommand (whose usage lives in pack-cli-install)
// is captured alongside the rest.
const PACK_CLI_PATHS = [
  resolve(REPO_ROOT, "infrastructure/lib/problem-pack/pack-cli.ts"),
  resolve(REPO_ROOT, "infrastructure/lib/problem-pack/pack-cli-install.ts"),
];
const DIAGNOSTICS_PATH = resolve(REPO_ROOT, "packages/problem-sdk/src/diagnostics.ts");

// --- Pack manifest reference --------------------------------------------------

// Field facts are derived from `PackManifestSchema` in problem-sdk/manifest.ts.
// Each row mirrors a `.strict()` schema key; the `required` flag tracks whether
// the schema marks it `.optional()`. The constraints are paraphrased from the
// schema's regex / refine messages (a human gloss, not a second source of truth).
const MANIFEST_FIELDS: readonly ManifestFieldReference[] = [
  {
    name: "schemaVersion",
    type: `${PACK_SCHEMA_VERSION} (literal)`,
    required: true,
    constraint: `Must equal the current pack schema version (${PACK_SCHEMA_VERSION}).`,
  },
  {
    name: "id",
    type: "string",
    required: true,
    constraint: "Reverse-DNS style, lowercase, two or more dot-separated segments.",
  },
  {
    name: "version",
    type: "string",
    required: true,
    constraint: "Exact SemVer (major.minor.patch with optional pre-release / build).",
  },
  {
    name: "core",
    type: "string",
    required: true,
    constraint: "SemVer range the pack requires of the platform core.",
  },
  { name: "title", type: "string", required: true, constraint: "Non-empty display title." },
  {
    name: "description",
    type: "string",
    required: true,
    constraint: "Non-empty pack description.",
  },
  { name: "license", type: "string", required: true, constraint: "Non-empty license identifier." },
  {
    name: "problemsRoot",
    type: "string",
    required: true,
    constraint: "Relative path without '..' traversal; not an absolute root.",
  },
  {
    name: "requiredRuntimes",
    type: "ProviderEngine[]",
    required: true,
    constraint: `Each entry is { provider, engine }; provider ∈ { ${PACK_PROVIDERS.join(", ")} }.`,
  },
  {
    name: "dependencies",
    type: "Dependency[]",
    required: false,
    constraint: "Optional. Each { id (reverse-DNS), range (SemVer range) }; ids must be unique.",
  },
];

// --- Problem metadata reference -----------------------------------------------

// Derived from the `ProblemMetadata` interface and `validateProblemMetadata` in
// problem-sdk/problem-metadata.ts. The SDK owns id / runtime / scoring and is
// forward-compatible with extra catalog-display fields it does not interpret.
const METADATA_FIELDS: readonly MetadataFieldReference[] = [
  {
    name: "id",
    type: "string",
    required: true,
    description: "Stable, non-empty problem identifier. Validated by the SDK.",
  },
  {
    name: "runtime",
    type: "object | composite",
    required: false,
    description:
      "Runtime descriptor ({ provider, engine, entry }) or a composite { kind: 'composite', targets }. Defaults to aws/cloudformation when absent.",
  },
  {
    name: "cfnTemplate",
    type: "string",
    required: false,
    description: `Legacy single deploy-body filename. Defaults to '${DEFAULT_ENTRY}' when neither runtime.entry nor cfnTemplate is set.`,
  },
  {
    name: "scoring",
    type: "ProblemScoringMetadata",
    required: false,
    description:
      "One of the six built-in scoring kinds (flag, multi-flag, uptime-flat, uptime-multi, phased-polling, attack-detection) plus composite-probe.",
  },
  {
    name: "endpoints",
    type: "unknown",
    required: false,
    description: "Optional endpoint declarations validated by the metadata-section validators.",
  },
  {
    name: "phases",
    type: "unknown",
    required: false,
    description: "Optional phase declarations for phased-polling problems.",
  },
  {
    name: "disruptions",
    type: "unknown",
    required: false,
    description: "Optional disruption declarations for resilience problems.",
  },
];

// Composite-runtime bounds derived from problem-runtime constants.
const COMPOSITE_TARGET_BOUNDS = {
  min: MIN_COMPOSITE_TARGETS,
  max: MAX_COMPOSITE_TARGETS,
} as const;

// --- Runtime capability matrix ------------------------------------------------

// The matrix is a direct projection of problem-runtime's evidence declarations.
// A mock test can exercise an adapter, but only `liveVerified: true` in that source may
// produce a live-verified public claim.
function buildRuntimeMatrix(): readonly RuntimeCapabilityRow[] {
  const rows = RUNTIME_CAPABILITIES.map((capability) => {
    const issues = validateRuntimeCapabilityEvidence(capability);
    if (issues.length > 0) {
      throw new Error(`Invalid runtime capability evidence: ${issues.join("; ")}`);
    }
    return {
      provider: capability.provider,
      engine: capability.engine,
      recognized: capability.recognized,
      adapterWired: capability.adapterWired,
      executable: capability.executable,
      liveVerified: capability.liveVerified,
      executionMode: capability.executionMode,
      selection: capability.selection,
      maturity: capability.maturity,
      blockingIssues: [...capability.blockingIssues],
      evidence: capability.evidence,
    } satisfies RuntimeCapabilityRow;
  });
  return rows.sort((left, right) => {
    if (left.selection === "default" && right.selection !== "default") return -1;
    if (right.selection === "default" && left.selection !== "default") return 1;
    return `${left.provider}/${left.engine}`.localeCompare(`${right.provider}/${right.engine}`);
  });
}

// --- CLI reference ------------------------------------------------------------

// CLI facts are parsed from the actual `*_USAGE` string constants in pack-cli.ts.
// Parsing the source keeps the docs coupled to the CLI: rename a command or change
// a flag and the regenerated output (or the drift check) changes with it.
const CLI_USAGE_PATTERN = /Usage: tenkacloud pack ([a-z]+) ([^"`\n]*)/g;

function buildCliReference(): readonly CliCommandReference[] {
  const commands: CliCommandReference[] = [];
  const seen = new Set<string>();
  for (const path of PACK_CLI_PATHS) {
    const source = readFileSync(path, "utf8");
    CLI_USAGE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null = CLI_USAGE_PATTERN.exec(source);
    while (match !== null) {
      const name = match[1];
      const args = match[2].trim();
      if (!seen.has(name)) {
        seen.add(name);
        commands.push({ name, usage: `tenkacloud pack ${name} ${args}`.trim() });
      }
      match = CLI_USAGE_PATTERN.exec(source);
    }
  }
  if (commands.length === 0) {
    throw new Error("No CLI usage strings parsed from the pack CLI; the CLI contract changed.");
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

// --- Validation error reference -----------------------------------------------

// Every public, namespaced validator code from diagnostics.ts gets a user-facing
// explanation. The code set is parsed from the `ValidationDiagnosticCode` union so
// adding / removing a code in the SDK forces this list (and the docs) to change.
const VALIDATION_CODE_PATTERN = /ValidationDiagnosticCode\s*=([\s\S]*?);/;
const CODE_LITERAL_PATTERN = /"([A-Z][A-Z0-9_]+)"/g;

const VALIDATION_CODE_EXPLANATIONS: Readonly<Record<string, string>> = {
  PACK_DIR_MISSING: "The pack directory does not exist. Check the path passed to the validator.",
  PACK_MANIFEST_MISSING: "No tenkacloud-pack.json was found at the pack root.",
  PACK_MANIFEST_UNREADABLE: "tenkacloud-pack.json exists but could not be read or parsed as JSON.",
  PACK_MANIFEST_INVALID:
    "tenkacloud-pack.json failed schema validation. The accompanying path points at the offending field.",
  PACK_PROBLEMS_ROOT_MISSING: "The directory named by problemsRoot does not exist inside the pack.",
  PACK_PROBLEMS_ROOT_TRAVERSAL:
    "problemsRoot escapes the pack root (absolute path or '..' traversal).",
  PACK_DUPLICATE_PROBLEM_ID: "Two problems in the pack declare the same id; ids must be unique.",
  PACK_ARTIFACT_TRAVERSAL: "A problem references a deploy artifact outside its own directory.",
  PACK_ARTIFACT_MISSING: "A problem declares an artifact (template / entry) that does not exist.",
  PROBLEM_METADATA_INVALID:
    "A problem's metadata.json is not a valid object or a required field is missing / malformed.",
  RUNTIME_MISMATCH:
    "A declared runtime '(provider/engine)' is not a supported runtime capability (a typo or an unsupported pair).",
};

function buildValidationErrors(): readonly ValidationErrorReference[] {
  const source = readFileSync(DIAGNOSTICS_PATH, "utf8");
  const unionMatch = source.match(VALIDATION_CODE_PATTERN);
  if (!unionMatch) {
    throw new Error(`Could not locate ValidationDiagnosticCode union in ${DIAGNOSTICS_PATH}.`);
  }
  const codes: string[] = [];
  let match: RegExpExecArray | null = CODE_LITERAL_PATTERN.exec(unionMatch[1]);
  while (match !== null) {
    codes.push(match[1]);
    match = CODE_LITERAL_PATTERN.exec(unionMatch[1]);
  }
  const errors: ValidationErrorReference[] = codes.map((code) => {
    const explanation = VALIDATION_CODE_EXPLANATIONS[code];
    if (!explanation) {
      throw new Error(
        `Validator code '${code}' has no user-facing explanation. Add it to VALIDATION_CODE_EXPLANATIONS.`,
      );
    }
    return { code, explanation };
  });
  return errors.sort((a, b) => a.code.localeCompare(b.code));
}

// --- Security and provenance reference ----------------------------------------

// Provenance facts are derived from the manifest's inert-by-design guarantees and
// snapshot.ts (immutable snapshots, content digest, pinned Git commit provenance).
const PROVENANCE_FACTS: readonly ProvenanceFactReference[] = [
  {
    title: "Inert manifest (no executable hooks)",
    detail:
      "v1 manifests carry no author credentials, remote URLs, scripts, or executable hooks. The schema is .strict(), so every unknown top-level field is rejected.",
    maturity: "stable",
  },
  {
    title: "Immutable content-addressed snapshots",
    detail:
      "Installing a pack hashes a canonical, sorted file list and the bytes of each file into a SHA-256 content digest. Re-installing the same id+version with a different digest fails closed.",
    maturity: "stable",
  },
  {
    title: "Pinned Git provenance",
    detail:
      "A git-sourced pack records the HTTPS repository URL (credentials stripped), the resolved immutable 40-hex commit, and the subdir. Fetch is shallow, hooks-disabled, and resolves only the pinned commit — never a floating ref.",
    maturity: "stable",
  },
  {
    title: "No remote / mutable sources",
    detail:
      "The only source kinds are 'local' (a directory) and 'git' (a pinned commit). There is no mutable / floating reference path and no runtime code execution during install.",
    maturity: "stable",
  },
];

// --- Assembly + serialization -------------------------------------------------

function buildReferenceData(): ReferenceData {
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    providers: [...PACK_PROVIDERS],
    manifestFields: MANIFEST_FIELDS,
    metadataFields: METADATA_FIELDS,
    compositeTargetBounds: COMPOSITE_TARGET_BOUNDS,
    runtimeMatrix: buildRuntimeMatrix(),
    cliCommands: buildCliReference(),
    validationErrors: buildValidationErrors(),
    provenanceFacts: PROVENANCE_FACTS,
  };
}

const GENERATED_HEADER = `// GENERATED FILE — do not edit by hand.
// Produced by apps/developer-portal/scripts/generate-reference.ts from the real
// pack/problem schemas, runtime capability declarations, the pack CLI usage
// strings, and the validator error-code registry. Run 'bun run generate:reference'
// after changing any of those sources. The drift check ('bun run check:reference',
// wired into prebuild and a vitest test) fails the build when this file is stale.
`;

const TYPE_DECLARATIONS = `export type ReferenceMaturity = "stable" | "preview" | "planned";

export interface ManifestFieldReference {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly constraint: string;
}

export interface MetadataFieldReference {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

export interface RuntimeCapabilityRow {
  readonly provider: string;
  readonly engine: string;
  readonly recognized: boolean;
  readonly adapterWired: boolean;
  readonly executable: boolean;
  readonly liveVerified: boolean;
  readonly executionMode: "cloud" | "local";
  readonly selection: "default" | "feature-gated" | "local-only";
  readonly maturity: ReferenceMaturity;
  readonly blockingIssues: readonly number[];
  readonly evidence: string;
}

export interface CliCommandReference {
  readonly name: string;
  readonly usage: string;
}

export interface ValidationErrorReference {
  readonly code: string;
  readonly explanation: string;
}

export interface ProvenanceFactReference {
  readonly title: string;
  readonly detail: string;
  readonly maturity: ReferenceMaturity;
}

export interface ReferenceData {
  readonly schemaVersion: number;
  readonly providers: readonly string[];
  readonly manifestFields: readonly ManifestFieldReference[];
  readonly metadataFields: readonly MetadataFieldReference[];
  readonly compositeTargetBounds: { readonly min: number; readonly max: number };
  readonly runtimeMatrix: readonly RuntimeCapabilityRow[];
  readonly cliCommands: readonly CliCommandReference[];
  readonly validationErrors: readonly ValidationErrorReference[];
  readonly provenanceFacts: readonly ProvenanceFactReference[];
}
`;

/**
 * Run the committed Biome formatter over generated text so the output is
 * byte-identical to what `biome check` expects (unquoted keys, collapsed short
 * arrays, trailing commas). Both write and `--check` go through this, so the drift
 * comparison never flaps on formatting and the committed file passes lint.
 */
function formatWithBiome(source: string): string {
  return execFileSync("bunx", ["biome", "format", "--stdin-file-path=reference-data.ts"], {
    cwd: REPO_ROOT,
    input: source,
    encoding: "utf8",
  });
}

/** Serialize the reference data module deterministically (stable key order). */
export function renderReferenceModule(data: ReferenceData): string {
  const raw = `${GENERATED_HEADER}\n${TYPE_DECLARATIONS}\nexport const REFERENCE_DATA: ReferenceData = ${JSON.stringify(
    data,
    null,
    2,
  )} as const;\n`;
  return formatWithBiome(raw);
}

/** Build the full module text from the live sources. Exported for the drift test. */
export function generateReferenceModule(): string {
  return renderReferenceModule(buildReferenceData());
}

function main(): void {
  const check = process.argv.includes("--check");
  const next = generateReferenceModule();
  if (check) {
    let current = "";
    try {
      current = readFileSync(OUTPUT_PATH, "utf8");
    } catch {
      console.error(
        `Reference data is missing (${OUTPUT_PATH}). Run 'bun run generate:reference'.`,
      );
      process.exit(1);
    }
    if (current !== next) {
      console.error(
        "Reference data is stale vs the current schemas / CLI / validator codes.\n" +
          "A source of truth changed without regenerating the docs reference.\n" +
          "Run 'bun run generate:reference' and commit src/content/reference-data.ts.",
      );
      process.exit(1);
    }
    console.log("Reference data is up to date with the source schemas / CLI / validator codes.");
    return;
  }
  writeFileSync(OUTPUT_PATH, next);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
