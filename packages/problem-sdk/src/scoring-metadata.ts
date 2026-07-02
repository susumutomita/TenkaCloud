/**
 * [Problem SDK / Issue #2106 ← ADR-012 Phase 3.B] Pure `metadata.json:scoring`
 * section parsers — the single source of truth shared by the platform (CDK synth
 * `discoverProblemsScoring`, Lambda runtime scoring) and external Pack authoring.
 *
 * `infrastructure/lib/utils/scoring-metadata.ts` re-exports every symbol here so
 * the platform keeps one schema. The env-decoding helpers (`parseScoringEnv`)
 * stay in infra because they depend on `node:zlib`; everything here is pure and
 * deterministic (no I/O, no env, no clock).
 *
 * 6 builtin kinds (ADR-012 Phase 3.B 5 + #1796 multi-flag) + #2070 composite-probe
 * + #2252 multi-verify (local container problems):
 *   - `flag`              — single submission (Challenge, submission scoring)
 *   - `multi-flag`        — N independent flags in one problem, partial points
 *   - `multi-verify`      — N container-judged checkpoints (docker local-play), partial points
 *   - `uptime-flat`       — independent endpoint probes, points when all OK
 *   - `uptime-multi`      — N slots AND-probed, points all OK / failure penalty
 *   - `phased-polling`    — time-based score rules, platform classification + bonus
 *   - `attack-detection`  — counter-delta detection in stack output
 *   - `composite-probe`   — one probe per composite target (#2070)
 */

/**
 * Issue #742 Phase 1: progressive hint shape.
 *   - id: stable identifier (so reveal records do not drift on metadata reorder)
 *   - content: display text (markdown allowed)
 *   - penalty: positive integer subtracted from `points` on reveal (0 allowed)
 * Backward compat: legacy `hints: string[]` is converted to
 * `{ id: \`hint-${index + 1}\`, content, penalty: 0 }`.
 */
export interface ProgressiveHint {
  readonly id: string;
  readonly content: string;
  readonly penalty: number;
}

export interface FlagScoringMetadata {
  readonly kind: "flag";
  readonly flagOutputKey: string;
  readonly points: number;
  /** Issue #817: per-wrong-answer penalty (brute-force mitigation). 0 / unset = none. */
  readonly wrongAnswerPenalty?: number;
  readonly hints?: readonly ProgressiveHint[];
}

/** Issue #1796: one sub-flag of a multi-flag problem. */
export interface MultiFlagEntry {
  readonly id: string;
  readonly label: string;
  readonly flagOutputKey: string;
  readonly points: number;
  readonly wrongAnswerPenalty?: number;
  readonly hints?: readonly ProgressiveHint[];
}

/** Issue #1796: multi-flag kind. N independent flags summing to the problem total. */
export interface MultiFlagScoringMetadata {
  readonly kind: "multi-flag";
  readonly flags: readonly MultiFlagEntry[];
}

/**
 * Issue #2252: one checkpoint of a `multi-verify` (docker local-play) problem.
 * The container owns the answer and judges a submission per checkpoint via
 * `POST /verify` (`checkpointId` in the request); the platform holds points
 * only — there is deliberately no `flagOutputKey` and no expected value here.
 */
export interface MultiVerifyCheck {
  readonly id: string;
  /** Competitor-facing label. Must not spoil the vulnerability (authoring rule). */
  readonly label: string;
  readonly points: number;
  readonly wrongAnswerPenalty?: number;
  readonly hints?: readonly ProgressiveHint[];
}

/**
 * Issue #2252: `multi-verify` kind — N independent container-judged checkpoints
 * summing to the problem total. Valid only for `runtime.provider: docker`
 * problems (`make local`); the deploy worker never sends these to a cloud.
 */
export interface MultiVerifyScoringMetadata {
  readonly kind: "multi-verify";
  readonly checks: readonly MultiVerifyCheck[];
}

export interface UptimeFlatEndpoint {
  readonly slot?: string;
  readonly outputKey?: string;
  readonly path: string;
  readonly expectStatus: readonly number[];
  readonly pointsPerSuccess?: number;
}

export interface UptimeFlatScoringMetadata {
  /** `uptime-flat` is the new name; `uptime` is the legacy Phase 1 alias. */
  readonly kind: "uptime-flat" | "uptime";
  readonly endpoints: readonly UptimeFlatEndpoint[];
  readonly pointsPerSuccess: number;
  /** Health-check failure tick score delta. Unset = 0. Negative = penalty. */
  readonly failurePenalty?: number;
  readonly hints?: readonly ProgressiveHint[];
}

export interface UptimeMultiProbedSlot {
  readonly slot: string;
  readonly path: string;
  readonly expectStatus: readonly number[];
}

export interface UptimeMultiScoringMetadata {
  readonly kind: "uptime-multi";
  readonly probedSlots: readonly UptimeMultiProbedSlot[];
  readonly pointsAllOk: number;
  readonly failurePenalty?: number;
  /** [ADR-034 / #1666] optional attack-blocked bonus (counter-delta * pointsPerBlock). */
  readonly attackBlocked?: {
    readonly slot: string;
    readonly path: string;
    readonly pointsPerBlock: number;
  };
  /** [ADR-034 / #1666] optional attack-probes (scorer-side defense test). */
  readonly attackProbes?: readonly {
    readonly slot: string;
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly body?: string;
    readonly vulnerableStatus: readonly number[];
    readonly penalty: number;
  }[];
  readonly hints?: readonly ProgressiveHint[];
}

export interface PhasedPollingPlatformRule {
  readonly points: number;
  readonly degradedPoints?: number;
}

export interface PhasedPollingResponsePenalty {
  /** Condition DSL string. Currently only `responseTimeMs > N` (Phase 3.B). */
  readonly if: string;
  readonly points: number;
}

export interface PhasedPollingBonus {
  /** Only known bonus kind is `all-slots-on-platforms` (Phase 3.B). */
  readonly kind: string;
  readonly points: number;
  readonly once?: boolean;
  readonly platforms?: readonly string[];
}

export interface PhasedPollingScoringMetadata {
  readonly kind: "phased-polling";
  readonly intervalMinutes: number;
  readonly probe: {
    readonly metaPath: string;
    readonly scorePath: string;
    readonly posturePath?: string;
  };
  readonly platformRules: Readonly<Record<string, PhasedPollingPlatformRule>>;
  readonly failurePenalty?: number;
  readonly responsePenalties?: readonly PhasedPollingResponsePenalty[];
  readonly bonuses?: readonly PhasedPollingBonus[];
  readonly hints?: readonly ProgressiveHint[];
}

export interface AttackDetectionCategory {
  readonly name: string;
  readonly pointsPerAttack?: number;
}

export interface AttackDetectionScoringMetadata {
  readonly kind: "attack-detection";
  readonly statsOutputKey: string;
  readonly pointsPerAttack: number;
  readonly categories?: readonly AttackDetectionCategory[];
  readonly hints?: readonly ProgressiveHint[];
}

/** Issue #2070: one declared scoring target of a Composite problem. */
export interface CompositeProbeTarget {
  readonly targetId: string;
  readonly probe: "https";
  readonly outputKey: string;
  readonly path?: string;
  readonly expectStatus?: readonly number[];
}

/** Issue #2070: opt-in `composite-probe` scoring kind for Composite problems. */
export interface CompositeProbeScoringMetadata {
  readonly kind: "composite-probe";
  readonly targets: readonly CompositeProbeTarget[];
  readonly success: "all";
  readonly pointsAllOk: number;
  readonly hints?: readonly ProgressiveHint[];
}

/**
 * The validated `metadata.json:scoring` section: a discriminated union over the
 * built-in scoring kinds (`flag` / `multi-flag` / `uptime-flat` (+ legacy
 * `uptime`) / `uptime-multi` / `phased-polling` / `attack-detection` /
 * `composite-probe`), keyed by `kind`. Serializable — it is exactly the shape an
 * author writes and the scoring engine reads.
 */
export type ProblemScoringMetadata =
  | FlagScoringMetadata
  | MultiFlagScoringMetadata
  | MultiVerifyScoringMetadata
  | UptimeFlatScoringMetadata
  | UptimeMultiScoringMetadata
  | PhasedPollingScoringMetadata
  | AttackDetectionScoringMetadata
  | CompositeProbeScoringMetadata;

/**
 * Narrow one `scoring` value to {@link ProblemScoringMetadata}, or `undefined`
 * when malformed. Legacy `kind: "uptime"` normalizes to `uptime-flat` semantics
 * while preserving the literal so legacy metadata views stay compatible.
 */
export function parseScoringMetadata(value: unknown): ProblemScoringMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { kind?: unknown };
  if (v.kind === "flag") return parseFlag(value);
  if (v.kind === "multi-flag") return parseMultiFlag(value);
  if (v.kind === "multi-verify") return parseMultiVerify(value);
  if (v.kind === "uptime" || v.kind === "uptime-flat") return parseUptimeFlat(value, v.kind);
  if (v.kind === "uptime-multi") return parseUptimeMulti(value);
  if (v.kind === "phased-polling") return parsePhasedPolling(value);
  if (v.kind === "attack-detection") return parseAttackDetection(value);
  if (v.kind === "composite-probe") return parseCompositeProbe(value);
  return undefined;
}

/**
 * Issue #2070: narrow the opt-in `composite-probe` kind. Fail-loud (whole-object
 * reject) because a silently dropped target would change which targets gate the
 * award.
 */
function parseCompositeProbe(value: unknown): CompositeProbeScoringMetadata | undefined {
  const c = value as {
    targets?: unknown;
    success?: unknown;
    pointsAllOk?: unknown;
    hints?: unknown;
  };
  if (c.success !== "all") return undefined;
  if (typeof c.pointsAllOk !== "number" || !Number.isFinite(c.pointsAllOk) || c.pointsAllOk <= 0) {
    return undefined;
  }
  if (!Array.isArray(c.targets) || c.targets.length === 0) return undefined;

  const targets: CompositeProbeTarget[] = [];
  const seenTargetIds = new Set<string>();
  for (const raw of c.targets) {
    const target = parseCompositeProbeTarget(raw);
    if (!target) return undefined;
    if (seenTargetIds.has(target.targetId)) return undefined;
    seenTargetIds.add(target.targetId);
    targets.push(target);
  }

  const hints = parseHints(c.hints);
  return {
    kind: "composite-probe",
    targets,
    success: "all",
    pointsAllOk: c.pointsAllOk,
    ...(hints ? { hints } : {}),
  };
}

function parseCompositeProbeTarget(value: unknown): CompositeProbeTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const t = value as {
    targetId?: unknown;
    probe?: unknown;
    outputKey?: unknown;
    path?: unknown;
    expectStatus?: unknown;
  };
  const targetId = optionalNonEmptyString(t.targetId);
  const outputKey = optionalNonEmptyString(t.outputKey);
  if (!targetId || !outputKey) return undefined;
  if (t.probe !== "https") return undefined;
  const path = optionalNonEmptyString(t.path);
  const expectStatus = parseExpectedStatuses(t.expectStatus);
  return {
    targetId,
    probe: "https",
    outputKey,
    ...(path ? { path } : {}),
    ...(expectStatus ? { expectStatus } : {}),
  };
}

function parseFlag(value: unknown): FlagScoringMetadata | undefined {
  const f = value as {
    flagOutputKey?: unknown;
    points?: unknown;
    wrongAnswerPenalty?: unknown;
    hints?: unknown;
  };
  if (typeof f.flagOutputKey !== "string") return undefined;
  if (typeof f.points !== "number" || !Number.isFinite(f.points) || f.points <= 0) return undefined;
  return {
    kind: "flag",
    flagOutputKey: f.flagOutputKey,
    points: f.points,
    wrongAnswerPenalty: clampWrongAnswerPenalty(f.wrongAnswerPenalty),
    hints: parseHints(f.hints),
  };
}

/**
 * Issue #817: wrongAnswerPenalty is optional. Invalid (negative / non-integer /
 * non-number) clamps to undefined (= no penalty, safe side).
 */
function clampWrongAnswerPenalty(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isInteger(value)
    ? value
    : undefined;
}

/**
 * Issue #1796: narrow the multi-flag kind. Never partial-drop — one invalid entry
 * rejects the whole object (a silently dropped flag would change the problem total
 * per competitor). Duplicate id / flagOutputKey also reject.
 */
function parseMultiFlag(value: unknown): MultiFlagScoringMetadata | undefined {
  const m = value as { flags?: unknown };
  if (!Array.isArray(m.flags) || m.flags.length === 0) return undefined;

  const flags: MultiFlagEntry[] = [];
  const seenIds = new Set<string>();
  const seenOutputKeys = new Set<string>();
  for (const raw of m.flags) {
    const entry = parseMultiFlagEntry(raw);
    if (!entry) return undefined;
    if (seenIds.has(entry.id) || seenOutputKeys.has(entry.flagOutputKey)) return undefined;
    seenIds.add(entry.id);
    seenOutputKeys.add(entry.flagOutputKey);
    flags.push(entry);
  }
  return { kind: "multi-flag", flags };
}

function parseMultiFlagEntry(value: unknown): MultiFlagEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const e = value as {
    id?: unknown;
    label?: unknown;
    flagOutputKey?: unknown;
    points?: unknown;
    wrongAnswerPenalty?: unknown;
    hints?: unknown;
  };
  const id = optionalNonEmptyString(e.id);
  const label = optionalNonEmptyString(e.label);
  const flagOutputKey = optionalNonEmptyString(e.flagOutputKey);
  if (!id || !label || !flagOutputKey) return undefined;
  if (typeof e.points !== "number" || !Number.isFinite(e.points) || e.points <= 0) return undefined;
  const hints = parseHints(e.hints);
  return {
    id,
    label,
    flagOutputKey,
    points: e.points,
    wrongAnswerPenalty: clampWrongAnswerPenalty(e.wrongAnswerPenalty),
    ...(hints ? { hints } : {}),
  };
}

const MULTI_VERIFY_CHECK_ID = /^[a-z0-9-]+$/;

/**
 * Issue #2252: narrow the multi-verify kind. Same never-partial-drop policy as
 * multi-flag — one invalid check rejects the whole object (a silently dropped
 * checkpoint would change the problem total per competitor). Fail-closed extras
 * per the #2252 contract: check ids must match `^[a-z0-9-]+$` and be unique,
 * points must be positive integers, and hint ids must be unique within a check
 * (the reveal record is keyed on them).
 */
function parseMultiVerify(value: unknown): MultiVerifyScoringMetadata | undefined {
  const m = value as { checks?: unknown };
  if (!Array.isArray(m.checks) || m.checks.length === 0) return undefined;

  const checks: MultiVerifyCheck[] = [];
  const seenIds = new Set<string>();
  for (const raw of m.checks) {
    const check = parseMultiVerifyCheck(raw);
    if (!check) return undefined;
    if (seenIds.has(check.id)) return undefined;
    seenIds.add(check.id);
    checks.push(check);
  }
  return { kind: "multi-verify", checks };
}

function parseMultiVerifyCheck(value: unknown): MultiVerifyCheck | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const c = value as {
    id?: unknown;
    label?: unknown;
    points?: unknown;
    wrongAnswerPenalty?: unknown;
    hints?: unknown;
  };
  const id = optionalNonEmptyString(c.id);
  const label = optionalNonEmptyString(c.label);
  if (!id || !MULTI_VERIFY_CHECK_ID.test(id) || !label) return undefined;
  if (typeof c.points !== "number" || !Number.isInteger(c.points) || c.points <= 0) {
    return undefined;
  }
  const hints = parseHints(c.hints);
  if (hints) {
    const hintIds = new Set(hints.map((hint) => hint.id));
    if (hintIds.size !== hints.length) return undefined;
  }
  return {
    id,
    label,
    points: c.points,
    wrongAnswerPenalty: clampWrongAnswerPenalty(c.wrongAnswerPenalty),
    ...(hints ? { hints } : {}),
  };
}

/**
 * Issue #742 Phase 1: normalize hints v1 (string[]) and v2 (object[]) to a common
 * `ProgressiveHint[]`. Invalid elements are filtered (so a partial hint typo does
 * not stop a deploy).
 */
function parseHints(value: unknown): readonly ProgressiveHint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hints = value
    .map((hint, index) => parseHint(hint, index))
    .filter((hint): hint is ProgressiveHint => hint !== undefined);
  return hints.length > 0 ? hints : undefined;
}

function parseHint(value: unknown, index: number): ProgressiveHint | undefined {
  if (typeof value === "string") {
    return { id: `hint-${index + 1}`, content: value, penalty: 0 };
  }
  if (!value || typeof value !== "object") return undefined;
  const hint = value as { id?: unknown; content?: unknown; penalty?: unknown };
  if (typeof hint.id !== "string" || hint.id.length === 0) return undefined;
  if (typeof hint.content !== "string" || hint.content.length === 0) return undefined;
  return { id: hint.id, content: hint.content, penalty: normalizeHintPenalty(hint.penalty) };
}

function normalizeHintPenalty(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function parseUptimeFlat(
  value: unknown,
  kindLiteral: "uptime" | "uptime-flat",
): UptimeFlatScoringMetadata | undefined {
  const u = value as {
    endpoints?: unknown;
    pointsPerSuccess?: unknown;
    failurePenalty?: unknown;
    hints?: unknown;
  };
  if (!Array.isArray(u.endpoints) || u.endpoints.length === 0) return undefined;
  if (typeof u.pointsPerSuccess !== "number" || u.pointsPerSuccess <= 0) return undefined;
  const endpoints = u.endpoints
    .map(parseUptimeFlatEndpoint)
    .filter((endpoint): endpoint is UptimeFlatEndpoint => endpoint !== undefined);
  if (endpoints.length === 0) return undefined;
  const hints = parseHints(u.hints);
  return {
    kind: kindLiteral,
    endpoints,
    pointsPerSuccess: u.pointsPerSuccess,
    ...(typeof u.failurePenalty === "number" ? { failurePenalty: u.failurePenalty } : {}),
    ...(hints ? { hints } : {}),
  };
}

function parseUptimeFlatEndpoint(value: unknown): UptimeFlatEndpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const endpoint = value as {
    slot?: unknown;
    outputKey?: unknown;
    path?: unknown;
    expectStatus?: unknown;
    pointsPerSuccess?: unknown;
  };
  if (typeof endpoint.path !== "string") return undefined;
  const expectStatus = parseExpectedStatuses(endpoint.expectStatus);
  if (!expectStatus) return undefined;
  const slot = optionalNonEmptyString(endpoint.slot);
  const outputKey = optionalNonEmptyString(endpoint.outputKey);
  if (!slot && !outputKey) return undefined;
  return {
    ...(slot ? { slot } : {}),
    ...(outputKey ? { outputKey } : {}),
    path: endpoint.path,
    expectStatus,
    ...(isPositiveNumber(endpoint.pointsPerSuccess)
      ? { pointsPerSuccess: endpoint.pointsPerSuccess }
      : {}),
  };
}

function parseUptimeMulti(value: unknown): UptimeMultiScoringMetadata | undefined {
  const u = value as {
    probedSlots?: unknown;
    pointsAllOk?: unknown;
    failurePenalty?: unknown;
    attackBlocked?: unknown;
    attackProbes?: unknown;
    hints?: unknown;
  };
  if (!Array.isArray(u.probedSlots) || u.probedSlots.length === 0) return undefined;
  if (typeof u.pointsAllOk !== "number" || u.pointsAllOk <= 0) return undefined;
  const probedSlots = u.probedSlots
    .map(parseUptimeMultiSlot)
    .filter((slot): slot is UptimeMultiProbedSlot => slot !== undefined);
  if (probedSlots.length === 0) return undefined;
  const hints = parseHints(u.hints);
  const attackBlocked = parseAttackBlocked(u.attackBlocked);
  const attackProbes = Array.isArray(u.attackProbes)
    ? u.attackProbes
        .map(parseAttackProbe)
        .filter((p): p is NonNullable<UptimeMultiScoringMetadata["attackProbes"]>[number] => !!p)
    : undefined;
  return {
    kind: "uptime-multi",
    probedSlots,
    pointsAllOk: u.pointsAllOk,
    ...(typeof u.failurePenalty === "number" ? { failurePenalty: u.failurePenalty } : {}),
    ...(attackBlocked ? { attackBlocked } : {}),
    ...(attackProbes && attackProbes.length > 0 ? { attackProbes } : {}),
    ...(hints ? { hints } : {}),
  };
}

/** [ADR-034 / #1666] parse one attack-probe fail-safe. slot/path/vulnerableStatus/penalty required. */
function parseAttackProbe(
  value: unknown,
): NonNullable<UptimeMultiScoringMetadata["attackProbes"]>[number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const p = value as {
    slot?: unknown;
    path?: unknown;
    method?: unknown;
    body?: unknown;
    vulnerableStatus?: unknown;
    penalty?: unknown;
  };
  if (typeof p.slot !== "string" || p.slot.length === 0) return undefined;
  if (typeof p.path !== "string" || p.path.length === 0) return undefined;
  if (typeof p.penalty !== "number" || p.penalty <= 0) return undefined;
  const vulnerableStatus = Array.isArray(p.vulnerableStatus)
    ? p.vulnerableStatus.filter((s): s is number => typeof s === "number")
    : [];
  if (vulnerableStatus.length === 0) return undefined;
  return {
    slot: p.slot,
    path: p.path,
    ...(p.method === "POST" || p.method === "GET" ? { method: p.method } : {}),
    ...(typeof p.body === "string" ? { body: p.body } : {}),
    vulnerableStatus,
    penalty: p.penalty,
  };
}

/** [ADR-034 / #1666] attack-blocked bonus enabled only when slot/path/pointsPerBlock all present. */
function parseAttackBlocked(
  value: unknown,
): UptimeMultiScoringMetadata["attackBlocked"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const a = value as { slot?: unknown; path?: unknown; pointsPerBlock?: unknown };
  if (typeof a.slot !== "string" || a.slot.length === 0) return undefined;
  if (typeof a.path !== "string" || a.path.length === 0) return undefined;
  if (typeof a.pointsPerBlock !== "number" || a.pointsPerBlock <= 0) return undefined;
  return { slot: a.slot, path: a.path, pointsPerBlock: a.pointsPerBlock };
}

function parseUptimeMultiSlot(value: unknown): UptimeMultiProbedSlot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const slot = value as { slot?: unknown; path?: unknown; expectStatus?: unknown };
  if (typeof slot.slot !== "string" || typeof slot.path !== "string") return undefined;
  const expectStatus = parseExpectedStatuses(slot.expectStatus);
  return expectStatus ? { slot: slot.slot, path: slot.path, expectStatus } : undefined;
}

function parsePhasedPolling(value: unknown): PhasedPollingScoringMetadata | undefined {
  const p = value as {
    intervalMinutes?: unknown;
    probe?: unknown;
    platformRules?: unknown;
    failurePenalty?: unknown;
    responsePenalties?: unknown;
    bonuses?: unknown;
    hints?: unknown;
  };
  if (typeof p.intervalMinutes !== "number" || p.intervalMinutes <= 0) return undefined;
  const probe = parsePhasedPollingProbe(p.probe);
  const platformRules = parsePlatformRules(p.platformRules);
  if (!probe) return undefined;
  if (Object.keys(platformRules).length === 0) return undefined;

  const responsePenalties = parseResponsePenalties(p.responsePenalties);
  const bonuses = parsePhasedPollingBonuses(p.bonuses);
  const hints = parseHints(p.hints);
  return {
    kind: "phased-polling",
    intervalMinutes: p.intervalMinutes,
    probe: {
      metaPath: probe.metaPath,
      scorePath: probe.scorePath,
      ...(probe.posturePath ? { posturePath: probe.posturePath } : {}),
    },
    platformRules,
    ...(typeof p.failurePenalty === "number" ? { failurePenalty: p.failurePenalty } : {}),
    ...(responsePenalties.length > 0 ? { responsePenalties } : {}),
    ...(bonuses.length > 0 ? { bonuses } : {}),
    ...(hints ? { hints } : {}),
  };
}

function parsePhasedPollingProbe(
  value: unknown,
): PhasedPollingScoringMetadata["probe"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const probe = value as { metaPath?: unknown; scorePath?: unknown; posturePath?: unknown };
  if (typeof probe.metaPath !== "string" || typeof probe.scorePath !== "string") {
    return undefined;
  }
  if (probe.posturePath !== undefined && typeof probe.posturePath !== "string") {
    return undefined;
  }
  return {
    metaPath: probe.metaPath,
    scorePath: probe.scorePath,
    ...(probe.posturePath ? { posturePath: probe.posturePath } : {}),
  };
}

function parsePlatformRules(value: unknown): Record<string, PhasedPollingPlatformRule> {
  if (!value || typeof value !== "object") return {};
  const rules: Record<string, PhasedPollingPlatformRule> = {};
  for (const [name, rawRule] of Object.entries(value as Record<string, unknown>)) {
    if (!rawRule || typeof rawRule !== "object") continue;
    const rule = rawRule as { points?: unknown; degradedPoints?: unknown };
    if (typeof rule.points !== "number") continue;
    rules[name] = {
      points: rule.points,
      ...(typeof rule.degradedPoints === "number" ? { degradedPoints: rule.degradedPoints } : {}),
    };
  }
  return rules;
}

function parseResponsePenalties(value: unknown): PhasedPollingResponsePenalty[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const penalty = entry as { if?: unknown; points?: unknown };
      if (typeof penalty.if !== "string" || typeof penalty.points !== "number") return undefined;
      return { if: penalty.if, points: penalty.points };
    })
    .filter((penalty): penalty is PhasedPollingResponsePenalty => penalty !== undefined);
}

function parsePhasedPollingBonuses(value: unknown): PhasedPollingBonus[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parsePhasedPollingBonus)
    .filter((bonus): bonus is PhasedPollingBonus => bonus !== undefined);
}

function parsePhasedPollingBonus(value: unknown): PhasedPollingBonus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const bonus = value as { kind?: unknown; points?: unknown; once?: unknown; platforms?: unknown };
  if (typeof bonus.kind !== "string" || typeof bonus.points !== "number") return undefined;
  return {
    kind: bonus.kind,
    points: bonus.points,
    ...(typeof bonus.once === "boolean" ? { once: bonus.once } : {}),
    ...(Array.isArray(bonus.platforms)
      ? {
          platforms: bonus.platforms.filter(
            (platform): platform is string => typeof platform === "string",
          ),
        }
      : {}),
  };
}

function parseAttackDetection(value: unknown): AttackDetectionScoringMetadata | undefined {
  const a = value as {
    statsOutputKey?: unknown;
    pointsPerAttack?: unknown;
    categories?: unknown;
    hints?: unknown;
  };
  if (typeof a.statsOutputKey !== "string" || a.statsOutputKey.length === 0) return undefined;
  if (typeof a.pointsPerAttack !== "number" || a.pointsPerAttack <= 0) return undefined;
  const categories = parseAttackDetectionCategories(a.categories);
  const hints = parseHints(a.hints);
  return {
    kind: "attack-detection",
    statsOutputKey: a.statsOutputKey,
    pointsPerAttack: a.pointsPerAttack,
    ...(categories.length > 0 ? { categories } : {}),
    ...(hints ? { hints } : {}),
  };
}

function parseAttackDetectionCategories(value: unknown): AttackDetectionCategory[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const category = entry as { name?: unknown; pointsPerAttack?: unknown };
      if (typeof category.name !== "string") return undefined;
      return {
        name: category.name,
        ...(typeof category.pointsPerAttack === "number"
          ? { pointsPerAttack: category.pointsPerAttack }
          : {}),
      };
    })
    .filter((category): category is AttackDetectionCategory => category !== undefined);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && value > 0;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseExpectedStatuses(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const statuses = value.filter((status): status is number => typeof status === "number");
  return statuses.length > 0 ? statuses : undefined;
}
