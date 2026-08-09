import { resolveLiteStackNames } from "../../infrastructure/lib/tenkacloud-lite/stack-names";

/**
 * Issue #2977: read-only Lite residual-resource scanner contract.
 *
 * This module contains no AWS client and performs no mutation. The AWS edge is injected through
 * {@link LiteResidualInventoryAdapter}; tests can therefore prove that missing/access-denied/
 * malformed inventory never becomes an empty successful scan.
 */

export const LITE_RESIDUAL_SCAN_REPORT_VERSION = 1;
export const LITE_RESIDUAL_OWNERSHIP_VERSION = 1;

export const LITE_RESIDUAL_SERVICES = [
  "cloudformation",
  "dynamodb",
  "s3",
  "logs",
  "sns",
  "budgets",
  "codebuild",
] as const;

export type LiteResidualService = (typeof LITE_RESIDUAL_SERVICES)[number];
export type LiteResidualDecision = "passed" | "failed" | "undecidable";

/** Immutable release BOM projected from the release manifest into run-scoped evidence. */
export interface LiteResidualReleaseIdentity {
  readonly releaseVersion: string;
  readonly platformCommit: string;
  readonly catalogCommit: string;
  /** An OCI image reference pinned by sha256 digest, never a mutable tag. */
  readonly simulatorImage: string;
}

export interface LiteResidualOwnershipEvidence {
  readonly evidenceVersion: 1;
  readonly runId: string;
  readonly mode: "lite";
  readonly environment: string;
  readonly accountId: string;
  readonly region: string;
  readonly releaseIdentity: LiteResidualReleaseIdentity;
  /**
   * Exact physical IDs captured before teardown. ID vocabulary is service-native: stack/table/
   * bucket/log-group/budget/project names, and SNS topic ARNs.
   */
  readonly resources: Readonly<Record<LiteResidualService, readonly string[]>>;
}

export interface AwsCommandError {
  readonly code:
    | "aws-command-failed"
    | "malformed-response"
    | "pagination-cycle"
    | "preflight-failed";
  readonly operation: string;
  readonly message: string;
}

export interface ObservedResource {
  readonly id: string;
  /** `undefined` means tag evidence could not be read; it never means an empty tag set. */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface ServiceInventory {
  readonly resources: readonly ObservedResource[];
  readonly errors: readonly AwsCommandError[];
}

export interface CallerIdentityEvidence {
  readonly accountId: string;
  readonly arn: string;
  readonly partition: string;
}

export type CallerIdentityResult =
  | { readonly ok: true; readonly identity: CallerIdentityEvidence }
  | { readonly ok: false; readonly error: AwsCommandError };

export interface LiteResidualInventoryAdapter {
  getCallerIdentity(region: string): Promise<CallerIdentityResult>;
  scanService(
    service: LiteResidualService,
    input: { readonly accountId: string; readonly region: string; readonly partition: string },
  ): Promise<ServiceInventory>;
}

export interface ResidualResourceEvidence {
  readonly id: string;
  readonly ownership: "exact" | "project-environment-tags" | "project-tag-missing-environment";
}

export interface AllowlistedResourceEvidence {
  readonly id: string;
  readonly reason: "cdk-bootstrap";
}

export interface LiteResidualServiceReport {
  readonly decision: LiteResidualDecision;
  readonly scannedResourceCount: number;
  readonly allowlisted: readonly AllowlistedResourceEvidence[];
  readonly unexpected: readonly ResidualResourceEvidence[];
  readonly errors: readonly AwsCommandError[];
}

export interface LiteResidualScanReport {
  readonly reportVersion: 1;
  readonly runId: string;
  readonly mode: "lite";
  readonly environment: string;
  readonly expectedAccountId: string;
  readonly observedAccountId: string | null;
  readonly region: string;
  readonly startedAt: string;
  readonly completedAt: string;
  /** Release BOM the scanner invocation required and the ownership evidence matched exactly. */
  readonly releaseIdentity: LiteResidualReleaseIdentity;
  /** Exact pre-teardown evidence this report was evaluated against. */
  readonly ownershipEvidence: LiteResidualOwnershipEvidence;
  readonly decision: LiteResidualDecision;
  readonly decisionReasons: readonly string[];
  readonly services: Readonly<Record<LiteResidualService, LiteResidualServiceReport>>;
}

export interface LiteResidualScanInput {
  readonly runId: string;
  readonly environment: string;
  readonly expectedAccountId: string;
  readonly region: string;
  readonly releaseIdentity: LiteResidualReleaseIdentity;
  readonly ownership: LiteResidualOwnershipEvidence;
}

export interface LiteResidualScanDeps {
  readonly inventory: LiteResidualInventoryAdapter;
  readonly now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new Error(`ownership evidence ${key} must be a non-empty string`);
  }
  return value;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENVIRONMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/;
const SEMVER_IDENTIFIER = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_PATTERN = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

function requirePattern(value: string, pattern: RegExp, field: string, expected: string): void {
  if (!pattern.test(value)) throw new Error(`ownership evidence ${field} ${expected}`);
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${field} contains unknown field(s): ${unknown.toSorted((a, b) => a.localeCompare(b)).join(", ")}`,
    );
  }
}

export function parseLiteResidualReleaseIdentity(value: unknown): LiteResidualReleaseIdentity {
  if (!isRecord(value)) throw new Error("ownership evidence releaseIdentity must be a JSON object");
  rejectUnknownKeys(
    value,
    new Set(["releaseVersion", "platformCommit", "catalogCommit", "simulatorImage"]),
    "ownership evidence releaseIdentity",
  );
  const releaseVersion = requireString(value, "releaseVersion");
  const platformCommit = requireString(value, "platformCommit");
  const catalogCommit = requireString(value, "catalogCommit");
  const simulatorImage = requireString(value, "simulatorImage");
  if (!SEMVER_PATTERN.test(releaseVersion)) {
    throw new Error(
      "ownership evidence releaseVersion must be canonical SemVer without a v prefix",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(platformCommit)) {
    throw new Error("ownership evidence platformCommit must be a full lowercase Git commit");
  }
  if (!/^[0-9a-f]{40}$/.test(catalogCommit)) {
    throw new Error("ownership evidence catalogCommit must be a full lowercase Git commit");
  }
  if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(simulatorImage)) {
    throw new Error("ownership evidence simulatorImage must be pinned by sha256 digest");
  }
  return { releaseVersion, platformCommit, catalogCommit, simulatorImage };
}

type ResourceIdValidator = (id: string, accountId: string, region: string) => string | undefined;

const RESOURCE_ID_VALIDATORS: Readonly<Record<LiteResidualService, ResourceIdValidator>> = {
  cloudformation: (id) =>
    /^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(id)
      ? undefined
      : "contains an invalid CloudFormation stack name",
  dynamodb: (id) =>
    /^[A-Za-z0-9_.-]{3,255}$/.test(id) ? undefined : "contains an invalid DynamoDB table name",
  // Intentionally broader than current DNS-style rules so historical S3 bucket names remain
  // representable, while whitespace, controls, impossible lengths, and impossible characters fail.
  s3: (id) =>
    id.length >= 3 && id.length <= 255 && /^[A-Za-z0-9._-]+$/.test(id)
      ? undefined
      : "contains an invalid S3 bucket name",
  logs: (id) =>
    id.length <= 512 && /^[.\-_/#A-Za-z0-9]+$/.test(id)
      ? undefined
      : "contains an invalid CloudWatch Logs group name",
  sns: (id, accountId, region) => {
    const arn = /^arn:[a-z0-9-]+:sns:([a-z0-9-]+):(\d{12}):([^:\s]+)$/.exec(id);
    if (!arn || arn[3].length > 256 || !/^[A-Za-z0-9_-]+(?:\.fifo)?$/.test(arn[3])) {
      return "contains an invalid SNS topic ARN";
    }
    return arn[1] === region && arn[2] === accountId
      ? undefined
      : "contains an SNS topic ARN from another account or region";
  },
  budgets: (id) =>
    id.length <= 100 && !id.includes(":") && !id.includes("\\") && !id.includes("/action/")
      ? undefined
      : "contains an invalid AWS Budget name",
  codebuild: (id) =>
    /^[A-Za-z0-9][A-Za-z0-9_-]{1,149}$/.test(id)
      ? undefined
      : "contains an invalid CodeBuild project name",
};

function validateServiceNativeId(
  id: string,
  service: LiteResidualService,
  accountId: string,
  region: string,
): void {
  if (id !== id.trim() || hasControlCharacter(id)) {
    throw new Error(`ownership evidence resources.${service} contains a non-canonical ID`);
  }
  const invalid = RESOURCE_ID_VALIDATORS[service](id, accountId, region);
  if (invalid) throw new Error(`ownership evidence resources.${service} ${invalid}`);
}

function parseExactIds(
  value: unknown,
  service: LiteResidualService,
  accountId: string,
  region: string,
): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`ownership evidence resources.${service} must be an array of non-empty IDs`);
  }
  const ids = value.filter((item): item is string => typeof item === "string");
  for (const id of ids) validateServiceNativeId(id, service, accountId, region);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`ownership evidence resources.${service} contains duplicate IDs`);
  }
  return ids;
}

/** Parse the pre-teardown exact-ownership artifact. Missing service arrays fail loudly. */
export function parseLiteResidualOwnershipEvidence(value: unknown): LiteResidualOwnershipEvidence {
  if (!isRecord(value)) throw new Error("ownership evidence must be a JSON object");
  rejectUnknownKeys(
    value,
    new Set([
      "evidenceVersion",
      "runId",
      "mode",
      "environment",
      "accountId",
      "region",
      "releaseIdentity",
      "resources",
    ]),
    "ownership evidence",
  );
  if (value.evidenceVersion !== LITE_RESIDUAL_OWNERSHIP_VERSION) {
    throw new Error(`ownership evidenceVersion must be ${LITE_RESIDUAL_OWNERSHIP_VERSION}`);
  }
  if (value.mode !== "lite") throw new Error('ownership evidence mode must be "lite"');
  if (!isRecord(value.resources)) {
    throw new Error("ownership evidence resources must be a JSON object");
  }
  rejectUnknownKeys(
    value.resources,
    new Set(LITE_RESIDUAL_SERVICES),
    "ownership evidence resources",
  );
  const runId = requireString(value, "runId");
  const environment = requireString(value, "environment");
  const accountId = requireString(value, "accountId");
  const region = requireString(value, "region");
  requirePattern(runId, RUN_ID_PATTERN, "runId", "must be a canonical correlation ID");
  requirePattern(
    environment,
    ENVIRONMENT_PATTERN,
    "environment",
    "must be a canonical Environment tag value",
  );
  requirePattern(accountId, ACCOUNT_ID_PATTERN, "accountId", "must be a 12 digit AWS account ID");
  requirePattern(region, REGION_PATTERN, "region", "must be an explicit AWS region");
  const resources = {
    cloudformation: parseExactIds(
      value.resources.cloudformation,
      "cloudformation",
      accountId,
      region,
    ),
    dynamodb: parseExactIds(value.resources.dynamodb, "dynamodb", accountId, region),
    s3: parseExactIds(value.resources.s3, "s3", accountId, region),
    logs: parseExactIds(value.resources.logs, "logs", accountId, region),
    sns: parseExactIds(value.resources.sns, "sns", accountId, region),
    budgets: parseExactIds(value.resources.budgets, "budgets", accountId, region),
    codebuild: parseExactIds(value.resources.codebuild, "codebuild", accountId, region),
  };
  return {
    evidenceVersion: 1,
    runId,
    mode: "lite",
    environment,
    accountId,
    region,
    releaseIdentity: parseLiteResidualReleaseIdentity(value.releaseIdentity),
    resources,
  };
}

function releaseIdentityMismatchReasons(
  expected: LiteResidualReleaseIdentity,
  observed: LiteResidualReleaseIdentity,
): string[] {
  const reasons: string[] = [];
  if (expected.releaseVersion !== observed.releaseVersion) {
    reasons.push("ownership evidence releaseIdentity.releaseVersion mismatch");
  }
  if (expected.platformCommit !== observed.platformCommit) {
    reasons.push("ownership evidence releaseIdentity.platformCommit mismatch");
  }
  if (expected.catalogCommit !== observed.catalogCommit) {
    reasons.push("ownership evidence releaseIdentity.catalogCommit mismatch");
  }
  if (expected.simulatorImage !== observed.simulatorImage) {
    reasons.push("ownership evidence releaseIdentity.simulatorImage mismatch");
  }
  return reasons;
}

function ownershipMismatchReasons(
  input: LiteResidualScanInput,
  observedAccountId: string,
): string[] {
  const reasons: string[] = [];
  if (input.ownership.runId !== input.runId) reasons.push("ownership evidence runId mismatch");
  if (input.ownership.environment !== input.environment) {
    reasons.push("ownership evidence environment mismatch");
  }
  if (input.ownership.accountId !== input.expectedAccountId) {
    reasons.push("ownership evidence accountId mismatch");
  }
  if (input.ownership.accountId !== observedAccountId) {
    reasons.push("ownership evidence does not belong to the active AWS account");
  }
  if (input.ownership.region !== input.region) reasons.push("ownership evidence region mismatch");
  reasons.push(
    ...releaseIdentityMismatchReasons(input.releaseIdentity, input.ownership.releaseIdentity),
  );
  return reasons;
}

function buildExactOwnership(
  input: LiteResidualScanInput,
): Record<LiteResidualService, Set<string>> {
  const stackNames = resolveLiteStackNames(input.environment);
  return {
    cloudformation: new Set([
      ...input.ownership.resources.cloudformation,
      stackNames.app,
      stackNames.problemDeploy,
    ]),
    dynamodb: new Set(input.ownership.resources.dynamodb),
    s3: new Set(input.ownership.resources.s3),
    logs: new Set(input.ownership.resources.logs),
    sns: new Set(input.ownership.resources.sns),
    budgets: new Set(input.ownership.resources.budgets),
    codebuild: new Set(input.ownership.resources.codebuild),
  };
}

function buildAllowlist(
  accountId: string,
  region: string,
): Readonly<Record<LiteResidualService, ReadonlyMap<string, "cdk-bootstrap">>> {
  return {
    cloudformation: new Map([["CDKToolkit", "cdk-bootstrap"]]),
    dynamodb: new Map(),
    s3: new Map([[`cdk-hnb659fds-assets-${accountId}-${region}`, "cdk-bootstrap"]]),
    logs: new Map(),
    sns: new Map(),
    budgets: new Map(),
    codebuild: new Map(),
  };
}

function classifyResource(
  resource: ObservedResource,
  exactIds: ReadonlySet<string>,
  allowlist: ReadonlyMap<string, "cdk-bootstrap">,
  environment: string,
):
  | { readonly kind: "ignored" }
  | { readonly kind: "allowlisted"; readonly evidence: AllowlistedResourceEvidence }
  | { readonly kind: "unexpected"; readonly evidence: ResidualResourceEvidence } {
  // Exact run-scoped ownership is stronger than the account-level bootstrap allowlist. A captured
  // bootstrap ID is therefore a residual (or malformed ownership upstream), never silently exempt.
  if (exactIds.has(resource.id)) {
    return { kind: "unexpected", evidence: { id: resource.id, ownership: "exact" } };
  }
  const allowlistReason = allowlist.get(resource.id);
  if (allowlistReason) {
    return { kind: "allowlisted", evidence: { id: resource.id, reason: allowlistReason } };
  }
  if (resource.tags?.Project !== "TenkaCloud") return { kind: "ignored" };
  if (resource.tags.Environment === environment) {
    return {
      kind: "unexpected",
      evidence: { id: resource.id, ownership: "project-environment-tags" },
    };
  }
  if (resource.tags.Environment === undefined) {
    return {
      kind: "unexpected",
      evidence: { id: resource.id, ownership: "project-tag-missing-environment" },
    };
  }
  return { kind: "ignored" };
}

function buildServiceReport(
  inventory: ServiceInventory,
  exactIds: ReadonlySet<string>,
  allowlist: ReadonlyMap<string, "cdk-bootstrap">,
  environment: string,
): LiteResidualServiceReport {
  const allowlisted: AllowlistedResourceEvidence[] = [];
  const unexpected: ResidualResourceEvidence[] = [];
  for (const resource of inventory.resources) {
    const classified = classifyResource(resource, exactIds, allowlist, environment);
    if (classified.kind === "allowlisted") allowlisted.push(classified.evidence);
    if (classified.kind === "unexpected") unexpected.push(classified.evidence);
  }
  let decision: LiteResidualDecision = "passed";
  if (unexpected.length > 0) decision = "failed";
  else if (inventory.errors.length > 0) decision = "undecidable";
  return {
    decision,
    scannedResourceCount: inventory.resources.length,
    allowlisted: allowlisted.toSorted((a, b) => a.id.localeCompare(b.id)),
    unexpected: unexpected.toSorted((a, b) => a.id.localeCompare(b.id)),
    errors: inventory.errors,
  };
}

function notRunServiceReport(error: AwsCommandError): LiteResidualServiceReport {
  return {
    decision: "undecidable",
    scannedResourceCount: 0,
    allowlisted: [],
    unexpected: [],
    errors: [error],
  };
}

function allNotRunServices(
  error: AwsCommandError,
): Record<LiteResidualService, LiteResidualServiceReport> {
  return {
    cloudformation: notRunServiceReport(error),
    dynamodb: notRunServiceReport(error),
    s3: notRunServiceReport(error),
    logs: notRunServiceReport(error),
    sns: notRunServiceReport(error),
    budgets: notRunServiceReport(error),
    codebuild: notRunServiceReport(error),
  };
}

function blockedScanReport(
  input: LiteResidualScanInput,
  now: () => Date,
  startedAt: string,
  observedAccountId: string | null,
  decision: "failed" | "undecidable",
  decisionReasons: readonly string[],
  error: AwsCommandError,
): LiteResidualScanReport {
  return {
    reportVersion: LITE_RESIDUAL_SCAN_REPORT_VERSION,
    runId: input.runId,
    mode: "lite",
    environment: input.environment,
    expectedAccountId: input.expectedAccountId,
    observedAccountId,
    region: input.region,
    startedAt,
    completedAt: now().toISOString(),
    releaseIdentity: input.releaseIdentity,
    ownershipEvidence: input.ownership,
    decision,
    decisionReasons,
    services: allNotRunServices(error),
  };
}

function finalDecision(
  services: Readonly<Record<LiteResidualService, LiteResidualServiceReport>>,
): LiteResidualDecision {
  const decisions = LITE_RESIDUAL_SERVICES.map((service) => services[service].decision);
  if (decisions.includes("failed")) return "failed";
  return decisions.includes("undecidable") ? "undecidable" : "passed";
}

function serviceDecisionReasons(
  services: Readonly<Record<LiteResidualService, LiteResidualServiceReport>>,
): string[] {
  const reasons: string[] = [];
  for (const service of LITE_RESIDUAL_SERVICES) {
    const report = services[service];
    if (report.unexpected.length > 0) {
      reasons.push(`${service}: ${report.unexpected.length} unexpected resource(s)`);
    }
    if (report.errors.length > 0) {
      reasons.push(`${service}: ${report.errors.length} inventory error(s)`);
    }
  }
  return reasons;
}

/** Run all seven read-only inventories after a verified STS identity preflight. */
export async function scanLiteResidualResources(
  input: LiteResidualScanInput,
  deps: LiteResidualScanDeps,
): Promise<LiteResidualScanReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const preflight = await deps.inventory.getCallerIdentity(input.region);
  if (!preflight.ok) {
    return blockedScanReport(
      input,
      now,
      startedAt,
      null,
      "undecidable",
      ["AWS identity preflight failed; no resource inventory was trusted"],
      preflight.error,
    );
  }

  if (preflight.identity.accountId !== input.expectedAccountId) {
    const error: AwsCommandError = {
      code: "preflight-failed",
      operation: "sts get-caller-identity",
      message: `active account ${preflight.identity.accountId} does not match expected ${input.expectedAccountId}`,
    };
    return blockedScanReport(
      input,
      now,
      startedAt,
      preflight.identity.accountId,
      "failed",
      [error.message],
      error,
    );
  }

  const mismatchReasons = ownershipMismatchReasons(input, preflight.identity.accountId);
  if (mismatchReasons.length > 0) {
    const error: AwsCommandError = {
      code: "preflight-failed",
      operation: "ownership evidence validation",
      message: mismatchReasons.join("; "),
    };
    return blockedScanReport(
      input,
      now,
      startedAt,
      preflight.identity.accountId,
      "undecidable",
      mismatchReasons,
      error,
    );
  }

  const identity = preflight.identity;
  const exact = buildExactOwnership(input);
  const allowlist = buildAllowlist(input.expectedAccountId, input.region);
  async function scanOne(service: LiteResidualService): Promise<LiteResidualServiceReport> {
    let inventory: ServiceInventory;
    try {
      inventory = await deps.inventory.scanService(service, {
        accountId: input.expectedAccountId,
        region: input.region,
        partition: identity.partition,
      });
    } catch (error) {
      inventory = {
        resources: [],
        errors: [
          {
            code: "aws-command-failed",
            operation: `${service} inventory adapter`,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    return buildServiceReport(inventory, exact[service], allowlist[service], input.environment);
  }
  const [cloudformation, dynamodb, s3, logs, sns, budgets, codebuild] = await Promise.all([
    scanOne("cloudformation"),
    scanOne("dynamodb"),
    scanOne("s3"),
    scanOne("logs"),
    scanOne("sns"),
    scanOne("budgets"),
    scanOne("codebuild"),
  ]);
  const services = { cloudformation, dynamodb, s3, logs, sns, budgets, codebuild };
  const decision = finalDecision(services);
  return {
    reportVersion: LITE_RESIDUAL_SCAN_REPORT_VERSION,
    runId: input.runId,
    mode: "lite",
    environment: input.environment,
    expectedAccountId: input.expectedAccountId,
    observedAccountId: identity.accountId,
    region: input.region,
    startedAt,
    completedAt: now().toISOString(),
    releaseIdentity: input.releaseIdentity,
    ownershipEvidence: input.ownership,
    decision,
    decisionReasons:
      decision === "passed"
        ? ["all supported residual inventories are clean"]
        : serviceDecisionReasons(services),
    services,
  };
}

export function serializeLiteResidualScanReport(report: LiteResidualScanReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function liteResidualScanExitCode(decision: LiteResidualDecision): number {
  if (decision === "passed") return 0;
  return decision === "failed" ? 1 : 2;
}
