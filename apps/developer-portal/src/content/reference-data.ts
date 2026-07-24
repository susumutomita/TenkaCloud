// GENERATED FILE — do not edit by hand.
// Produced by apps/developer-portal/scripts/generate-reference.ts from the real
// pack/problem schemas, runtime capability declarations, the pack CLI usage
// strings, and the validator error-code registry. Run 'bun run generate:reference'
// after changing any of those sources. The drift check ('bun run check:reference',
// wired into prebuild and a vitest test) fails the build when this file is stale.

export type ReferenceMaturity = "stable" | "preview" | "planned";

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

export const REFERENCE_DATA: ReferenceData = {
  schemaVersion: 1,
  providers: ["aws", "gcp", "azure", "sakura"],
  manifestFields: [
    {
      name: "schemaVersion",
      type: "1 (literal)",
      required: true,
      constraint: "Must equal the current pack schema version (1).",
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
    {
      name: "title",
      type: "string",
      required: true,
      constraint: "Non-empty display title.",
    },
    {
      name: "description",
      type: "string",
      required: true,
      constraint: "Non-empty pack description.",
    },
    {
      name: "license",
      type: "string",
      required: true,
      constraint: "Non-empty license identifier.",
    },
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
      constraint: "Each entry is { provider, engine }; provider ∈ { aws, gcp, azure, sakura }.",
    },
    {
      name: "dependencies",
      type: "Dependency[]",
      required: false,
      constraint: "Optional. Each { id (reverse-DNS), range (SemVer range) }; ids must be unique.",
    },
  ],
  metadataFields: [
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
      description:
        "Legacy single deploy-body filename. Defaults to 'template.yaml' when neither runtime.entry nor cfnTemplate is set.",
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
  ],
  compositeTargetBounds: {
    min: 2,
    max: 8,
  },
  runtimeMatrix: [
    {
      provider: "aws",
      engine: "cloudformation",
      recognized: true,
      adapterWired: true,
      executable: true,
      liveVerified: true,
      executionMode: "cloud",
      selection: "default",
      maturity: "stable",
      blockingIssues: [],
      evidence:
        "Default competitor-account CloudFormation lifecycle is production and live verified.",
    },
    {
      provider: "azure",
      engine: "bicep",
      recognized: true,
      adapterWired: true,
      executable: false,
      liveVerified: false,
      executionMode: "cloud",
      selection: "feature-gated",
      maturity: "preview",
      blockingIssues: [2743, 2081],
      evidence:
        "Adapter and credential wiring ship, but Bicep artifact materialization and live acceptance remain open.",
    },
    {
      provider: "docker",
      engine: "compose",
      recognized: true,
      adapterWired: true,
      executable: true,
      liveVerified: true,
      executionMode: "local",
      selection: "local-only",
      maturity: "preview",
      blockingIssues: [],
      evidence:
        "Executable and verified through the AWS-free make local lifecycle; never cloud deployed.",
    },
    {
      provider: "gcp",
      engine: "infra-manager",
      recognized: true,
      adapterWired: true,
      executable: false,
      liveVerified: false,
      executionMode: "cloud",
      selection: "feature-gated",
      maturity: "preview",
      blockingIssues: [2081],
      evidence:
        "Adapter, WIF wiring, and Terraform source materialization to GCS ship; only live acceptance remains open.",
    },
    {
      provider: "sakura",
      engine: "apprun",
      recognized: true,
      adapterWired: true,
      executable: true,
      liveVerified: false,
      executionMode: "cloud",
      selection: "feature-gated",
      maturity: "preview",
      blockingIssues: [2081],
      evidence:
        "Adapter and current AppRun API wire contract ship; real-account lifecycle acceptance remains open.",
    },
  ],
  cliCommands: [
    {
      name: "activate",
      usage: "tenkacloud pack activate <id@version> --tenant <t> [--store <dir>]",
    },
    {
      name: "deactivate",
      usage: "tenkacloud pack deactivate <id@version> --tenant <t> [--store <dir>]",
    },
    {
      name: "init",
      usage: "tenkacloud pack init <dir> [--runtime <provider/engine>]",
    },
    {
      name: "inspect",
      usage: "tenkacloud pack inspect <id@version> [--store <dir>] [--json]",
    },
    {
      name: "install",
      usage: "tenkacloud pack install <dir> [--store <dir>]\\n",
    },
    {
      name: "list",
      usage: "tenkacloud pack list [--store <dir>] [--json]",
    },
    {
      name: "remove",
      usage: "tenkacloud pack remove <id@version> [--store <dir>] [--pins <file>]",
    },
    {
      name: "validate",
      usage: "tenkacloud pack validate <dir> [--json]",
    },
  ],
  validationErrors: [
    {
      code: "PACK_ARTIFACT_MISSING",
      explanation: "A problem declares an artifact (template / entry) that does not exist.",
    },
    {
      code: "PACK_ARTIFACT_TRAVERSAL",
      explanation: "A problem references a deploy artifact outside its own directory.",
    },
    {
      code: "PACK_DIR_MISSING",
      explanation: "The pack directory does not exist. Check the path passed to the validator.",
    },
    {
      code: "PACK_DUPLICATE_PROBLEM_ID",
      explanation: "Two problems in the pack declare the same id; ids must be unique.",
    },
    {
      code: "PACK_MANIFEST_INVALID",
      explanation:
        "tenkacloud-pack.json failed schema validation. The accompanying path points at the offending field.",
    },
    {
      code: "PACK_MANIFEST_MISSING",
      explanation: "No tenkacloud-pack.json was found at the pack root.",
    },
    {
      code: "PACK_MANIFEST_UNREADABLE",
      explanation: "tenkacloud-pack.json exists but could not be read or parsed as JSON.",
    },
    {
      code: "PACK_PROBLEMS_ROOT_MISSING",
      explanation: "The directory named by problemsRoot does not exist inside the pack.",
    },
    {
      code: "PACK_PROBLEMS_ROOT_TRAVERSAL",
      explanation: "problemsRoot escapes the pack root (absolute path or '..' traversal).",
    },
    {
      code: "PROBLEM_METADATA_INVALID",
      explanation:
        "A problem's metadata.json is not a valid object or a required field is missing / malformed.",
    },
    {
      code: "RUNTIME_MISMATCH",
      explanation:
        "A declared runtime '(provider/engine)' is not a supported runtime capability (a typo or an unsupported pair).",
    },
  ],
  provenanceFacts: [
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
  ],
} as const;
