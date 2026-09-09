import type { DeploymentsQueryPort } from "../../control-data/domain/deployments-port.js";
import type { DeploymentRecord } from "../../control-data/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import {
  type ParticipantDeploymentsTableSharedResources,
  resolveDeploymentsRepository,
} from "./shared.js";

// Keep initialization within the dispatcher budget without an unbounded fan-out.
const INITIALIZATION_READ_CONCURRENCY = 8;

/**
 * The event roster a coordination plugin's `initialState(ctx)` is built from.
 *
 * Two hosts materialise a namespace: the participant operation path
 * (`makeCoordinationScopeResolver`) and the scoring-driven tick
 * (`coordination-tick.ts`). `initialState` is the only hook that receives
 * `ctx`, so whichever host runs first decides what the plugin knows about the
 * teams for the whole match. Both therefore resolve the roster HERE, from the
 * same rows, by the same rule -- a difference between them is a different
 * initial state depending on who won the race. [Issue #3187] is what that
 * looks like: the tick runs every minute from the moment the event starts, so
 * it wins against the first participant to open the portal, and it used to
 * pass ids alone. Every team was a ULID for the rest of the match, even after
 * #3172 had wired names into the op path.
 *
 * The roster is every team with a deployment row for the SAME problem in the
 * same (tenant, event), sorted by teamId. Sorting is the race defence itself
 * (Issue #3053): whichever request materialises the state, `initialState(ctx)`
 * gets the same input. Read-only projections of an absent run use a provisional
 * index snapshot, which never materialises the namespace. Status is deliberately not filtered -- dropping a
 * mid-deploy team would make the roster depend on deploy timing, which is the
 * same race again.
 *
 * `knownTeamIds` are always on the roster: the requester on the op path, the
 * teams the scoring pass observed on the tick path. A failed roster query
 * may degrade for an existing match; a new state must wait for the full query.
 *
 * Known limit: the state is materialised once. A team that deploys after that
 * does not appear in `state.teams` (the SDK has no roster re-resolution hook)
 * and a team renamed after the match starts keeps its old name. Operators
 * start the match after every team has deployed.
 */
export interface EventRosterTarget {
  readonly tenantId: string;
  readonly eventId: string;
  readonly problemId: string;
  /** Team ids the caller already knows; on the roster whether or not the query succeeds. */
  readonly knownTeamIds: readonly string[];
  /** Durable initialization cannot commit an incomplete roster after a failed query. */
  readonly requireComplete?: boolean;
  /** Index snapshot for an ephemeral projection only; never use for a durable initializer. */
  readonly readOnlyPreview?: boolean;
}

export interface EventRoster {
  readonly deploymentInputs?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Existing matches remain usable, but this roster must never initialize durable state. */
  readonly rosterIncomplete?: true;
  /** teamId 昇順 (= どの host が先に materialize しても `initialState(ctx)` の入力が同一)。 */
  readonly teamIds: readonly string[];
  /**
   * [Issue #3172] teamId → display name. A team with no name at all is left
   * out rather than mapped to an empty string, so the plugin's own fallback
   * to the id is what runs.
   */
  readonly teamNames: Readonly<Record<string, string>>;
}

export async function resolveEventRoster(
  shared: ParticipantDeploymentsTableSharedResources,
  target: EventRosterTarget,
): Promise<EventRoster> {
  const roster = new Set<string>(target.knownTeamIds);
  const teamNames: Record<string, string> = {};
  const deploymentInputs: Record<string, Record<string, string>> = {};
  let rosterIncomplete: true | undefined;
  try {
    const repository = await resolveDeploymentsRepository(shared);
    // A preview is not persisted, even when a no-op tick leaves the run absent.
    // Defer per-deployment strong reads until an operation/tick initializes it.
    const orderedRows = target.readOnlyPreview
      ? [...(await repository.listByTenantAndEvent(target.tenantId, target.eventId))]
      : await readAuthoritativeRoster(repository, target);
    // Deployment history can contain several jobs per team. Use the newest
    // creation deterministically; repository iteration order is not a contract.
    orderedRows.sort(compareDeploymentCreation);
    for (const row of orderedRows) {
      if (row.problemId !== target.problemId || typeof row.teamId !== "string" || !row.teamId) {
        continue;
      }
      roster.add(row.teamId);
      const inputs = Object.fromEntries(
        Object.entries(parseInitializationOutputs(row.stackOutputs)).filter(([key]) =>
          /^Coordination[A-Z]/.test(key),
        ),
      );
      deploymentInputs[row.teamId] = inputs;
      // `displayTeamName ?? teamName`, the order the leaderboard resolves.
      const name = trimmedString(row.displayTeamName) || trimmedString(row.teamName);
      if (name) teamNames[row.teamId] = name;
    }
  } catch (err) {
    if (target.requireComplete) throw err;
    rosterIncomplete = true;
    // Existing state does not use ctx. Preserve reads and existing operations,
    // while the dispatcher refuses to initialize from this partial result.
    console.warn("[coordination] roster query failed; new match initialization deferred", {
      eventId: target.eventId,
      problemId: target.problemId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const populatedInputs = Object.fromEntries(
    Object.entries(deploymentInputs).filter(([, outputs]) => Object.keys(outputs).length > 0),
  );
  return {
    teamIds: [...roster].sort(),
    teamNames,
    ...(Object.keys(populatedInputs).length ? { deploymentInputs: populatedInputs } : {}),
    ...(rosterIncomplete ? { rosterIncomplete } : {}),
  };
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

/** Present corrupt outputs must not become an immutable empty/default context. */
function parseInitializationOutputs(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Malformed deployment outputs");
  }
  const valid = Array.isArray(parsed)
    ? parsed.every(
        (entry: unknown) =>
          entry !== null &&
          typeof entry === "object" &&
          "OutputKey" in entry &&
          typeof entry.OutputKey === "string" &&
          "OutputValue" in entry &&
          typeof entry.OutputValue === "string",
      )
    : parsed !== null &&
      typeof parsed === "object" &&
      Object.values(parsed).every((value: unknown) => typeof value === "string");
  if (!valid) throw new Error("Malformed deployment outputs");
  return parseStackOutputs(raw);
}

async function readAuthoritativeRoster(
  repository: DeploymentsQueryPort,
  target: EventRosterTarget,
) {
  const rows = await repository.listByTenantAndEvent(target.tenantId, target.eventId);
  // GSI1 is discovery only: its output values may still be pre-deploy values.
  // Only the latest deployment per team can supply immutable inputs. Reading
  // every historical job adds latency and can fail on an already-deleted job.
  const latest = new Map<string, DeploymentRecord>();
  for (const candidate of rows) {
    if (candidate.problemId !== target.problemId || !candidate.teamId) continue;
    const previous = latest.get(candidate.teamId);
    if (!previous || compareDeploymentCreation(previous, candidate) < 0) {
      latest.set(candidate.teamId, candidate);
    }
  }
  const candidates = [...latest.values()];
  const orderedRows: DeploymentRecord[] = [];
  for (let offset = 0; offset < candidates.length; offset += INITIALIZATION_READ_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + INITIALIZATION_READ_CONCURRENCY);
    const current = await Promise.all(
      batch.map((candidate) => readScopedDeployment(repository, target, candidate)),
    );
    orderedRows.push(...current);
  }
  return orderedRows;
}

function compareDeploymentCreation(a: DeploymentRecord, b: DeploymentRecord): number {
  return (
    (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
    (a.jobId ?? "").localeCompare(b.jobId ?? "")
  );
}

async function readScopedDeployment(
  repository: DeploymentsQueryPort,
  target: EventRosterTarget,
  candidate: DeploymentRecord,
): Promise<DeploymentRecord> {
  if (!candidate.jobId) throw new Error("Roster deployment has no job ID");
  const current = await repository.getDeployment(candidate.jobId, { consistentRead: true });
  if (
    !current ||
    current.tenantId !== target.tenantId ||
    current.eventId !== target.eventId ||
    current.problemId !== target.problemId ||
    current.teamId !== candidate.teamId
  ) {
    throw new Error("Roster deployment is missing or no longer belongs to this scope");
  }
  return current;
}
