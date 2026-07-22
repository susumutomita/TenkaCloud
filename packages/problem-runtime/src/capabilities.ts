/**
 * [Issue #2748] Machine-readable runtime capability evidence.
 *
 * Runtime recognition, adapter wiring, operational executability, and live verification are
 * independent facts. A provider is never promoted merely because a schema accepts its name or a
 * mocked adapter test exists. Developer docs, landing docs, and runtime selection consume these
 * declarations instead of inventing support claims in prose.
 */

export type RuntimeExecutionMode = "cloud" | "local";
export type RuntimeCapabilityMaturity = "stable" | "preview" | "planned";
export type RuntimeSelectionAvailability = "default" | "feature-gated" | "local-only";

export interface RuntimeCapabilityDeclaration {
  readonly provider: string;
  readonly engine: string;
  /** Metadata/schema recognizes the exact provider/engine pair. */
  readonly recognized: boolean;
  /** A concrete runtime adapter and credential/composition wiring ship in this repository. */
  readonly adapterWired: boolean;
  /** The end-to-end materialization and provider wire path is expected to execute. */
  readonly executable: boolean;
  /** A real lifecycle, not mocks alone, has been demonstrated for this execution mode. */
  readonly liveVerified: boolean;
  readonly executionMode: RuntimeExecutionMode;
  readonly selection: RuntimeSelectionAvailability;
  readonly maturity: RuntimeCapabilityMaturity;
  /** Open acceptance/blocker issues that prevent the next maturity claim. */
  readonly blockingIssues: readonly number[];
  /** Concise evidence statement; generated public docs localize the surrounding terminology. */
  readonly evidence: string;
}

type RuntimeCapabilityRow = readonly [
  provider: string,
  engine: string,
  executable: boolean,
  liveVerified: boolean,
  executionMode: RuntimeExecutionMode,
  selection: RuntimeSelectionAvailability,
  maturity: RuntimeCapabilityMaturity,
  blockingIssues: readonly number[],
  evidence: string,
];

/**
 * Recognition and adapter wiring are true for every declared row in the current registry. Keeping
 * those shared facts in the projection avoids five copy-pasted object blocks while preserving the
 * independent booleans in the public contract and its validation rules.
 */
const RUNTIME_CAPABILITY_ROWS = [
  [
    "aws",
    "cloudformation",
    true,
    true,
    "cloud",
    "default",
    "stable",
    [],
    "Default competitor-account CloudFormation lifecycle is production and live verified.",
  ],
  [
    "azure",
    "bicep",
    false,
    false,
    "cloud",
    "feature-gated",
    "preview",
    [2743, 2081],
    "Adapter and credential wiring ship, but Bicep artifact materialization and live acceptance remain open.",
  ],
  [
    "docker",
    "compose",
    true,
    true,
    "local",
    "local-only",
    "preview",
    [],
    "Executable and verified through the AWS-free make local lifecycle; never cloud deployed.",
  ],
  [
    "gcp",
    "infra-manager",
    false,
    false,
    "cloud",
    "feature-gated",
    "preview",
    [2745, 2081],
    "Adapter and WIF wiring ship, but Terraform source/output handling and live acceptance remain open.",
  ],
  [
    "sakura",
    "apprun",
    true,
    false,
    "cloud",
    "feature-gated",
    "preview",
    [2081],
    "Adapter and current AppRun API wire contract ship; real-account lifecycle acceptance remains open.",
  ],
] as const satisfies readonly RuntimeCapabilityRow[];

export const RUNTIME_CAPABILITIES: readonly RuntimeCapabilityDeclaration[] = Object.freeze(
  RUNTIME_CAPABILITY_ROWS.map(
    ([
      provider,
      engine,
      executable,
      liveVerified,
      executionMode,
      selection,
      maturity,
      blockingIssues,
      evidence,
    ]) =>
      Object.freeze({
        provider,
        engine,
        recognized: true,
        adapterWired: true,
        executable,
        liveVerified,
        executionMode,
        selection,
        maturity,
        blockingIssues: Object.freeze([...blockingIssues]),
        evidence,
      }),
  ),
);

export type DeclaredRuntimeCapability = RuntimeCapabilityDeclaration;

export function findRuntimeCapability(
  provider: string,
  engine: string,
): DeclaredRuntimeCapability | undefined {
  return RUNTIME_CAPABILITIES.find(
    (capability) => capability.provider === provider && capability.engine === engine,
  );
}

export function runtimeCapabilityKey(
  capability: Pick<RuntimeCapabilityDeclaration, "provider" | "engine">,
): string {
  return `${capability.provider}/${capability.engine}`;
}

/**
 * Internal invariant used by docs/tests. Live verification can only be claimed for an executable
 * adapter; executable cloud providers must have adapter wiring; unresolved blockers cannot coexist
 * with a live-verified claim.
 */
export function validateRuntimeCapabilityEvidence(
  capability: RuntimeCapabilityDeclaration,
): readonly string[] {
  const issues: string[] = [];
  const key = runtimeCapabilityKey(capability);
  if (capability.adapterWired && !capability.recognized) {
    issues.push(`${key}: adapterWired requires recognized`);
  }
  if (capability.executable && !capability.adapterWired) {
    issues.push(`${key}: executable requires adapterWired`);
  }
  if (capability.liveVerified && !capability.executable) {
    issues.push(`${key}: liveVerified requires executable`);
  }
  if (capability.liveVerified && capability.blockingIssues.length > 0) {
    issues.push(`${key}: liveVerified cannot retain blockingIssues`);
  }
  if (capability.selection === "local-only" && capability.executionMode !== "local") {
    issues.push(`${key}: local-only selection requires local executionMode`);
  }
  if (capability.selection !== "local-only" && capability.executionMode === "local") {
    issues.push(`${key}: local executionMode requires local-only selection`);
  }
  return issues;
}

export const ADAPTER_WIRED_RUNTIMES = RUNTIME_CAPABILITIES.filter(
  (capability) => capability.adapterWired,
);
