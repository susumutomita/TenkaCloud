import type { ProbeFn } from "../lib/http-probe-client";
import { bunOrganizerPasswords } from "./bun-passwords";
import { HostingDomain } from "./hosting-domain";
import { gate, HostError, type RuntimeEngine } from "./model";
import type { OrganizerPasswords } from "./organizer-passwords";
import { ownedBattleEndpoints } from "./simulator-battle-endpoints";
import {
  createBattleRegistrationCommit,
  createBattleRegistrationRemoval,
} from "./simulator-battle-registration-commit";
import { SimulatorBattleRegistrationStore } from "./simulator-battle-registration-store";
import type { OwnedBattleSessionBundle } from "./simulator-battle-session-bundle";
import { runBattleUptimeMinute } from "./simulator-battle-uptime";
import {
  retainedSimulatorBattleOwner,
  simulatorBattleUptimeTarget,
} from "./simulator-battle-uptime-target";
import { readSimulatorStackOrigin } from "./simulator-stack-origin";
import type { HostStore } from "./store";

export type { ApiRequest, ApiResponse } from "../lib/hosting-api";

/** Local composition facade preserves existing callers; domain has no default concrete provider. */
export class HostingService extends HostingDomain {
  constructor(
    store: HostStore,
    engine: RuntimeEngine,
    masterKey: string,
    now: () => number = Date.now,
    log: (message: string) => void = console.error,
    uptimeProbe?: ProbeFn,
    passwords: OrganizerPasswords = bunOrganizerPasswords,
    ownedBattleSession?: OwnedBattleSessionBundle,
  ) {
    super(store, engine, masterKey, now, log, uptimeProbe, passwords, ownedBattleSession);
    if (ownedBattleSession)
      this.ownedBattleEndpoints = async (team, problemId, method, slot, value, authenticate) => {
        if (problemId !== "hello-world-battle") return undefined;
        const id = store.jobId(team.eventId, team.teamId, problemId);
        if (!id || !readSimulatorStackOrigin(store.job(id))) return undefined;
        return ownedBattleSession.run((session) =>
          ownedBattleEndpoints(
            {
              ...session,
              now,
              registrations: new SimulatorBattleRegistrationStore(store, {
                kind: "owned-battle-registration-scope",
                providerDomain: session.clock.domain,
              }),
              commit: createBattleRegistrationCommit(store, session.clock.domain, true),
              remove: createBattleRegistrationRemoval(store, session.clock.domain),
              current: () => {
                const freshTeam = authenticate();
                if (freshTeam.teamId !== team.teamId || freshTeam.eventId !== team.eventId)
                  throw new HostError(403, "Battle participant changed.");
                this.progression.assertAccess(freshTeam, problemId);
                if (
                  !this.progression.allowed(freshTeam, problemId) ||
                  store.jobId(team.eventId, team.teamId, problemId) !== id ||
                  (method !== "GET" && gate(store.event(team.eventId), now()).kind !== "ok")
                )
                  throw new HostError(
                    409,
                    "Battle registration is not active.",
                    "scoring_not_active",
                  );
                return {
                  target: simulatorBattleUptimeTarget(store.job(id)),
                  revision: store.uptimeState(team.eventId, team.teamId, problemId).revision,
                };
              },
            },
            method,
            slot,
            value,
          ),
        );
      };
    if (ownedBattleSession)
      this.uptime.connectOwnedBattleTick(async (job, minute) => {
        if (job.problemId !== "hello-world-battle" || !readSimulatorStackOrigin(job)) return false;
        await ownedBattleSession.run((session) =>
          runBattleUptimeMinute(
            {
              ...session,
              host: store,
              wallNow: now,
              current: () => {
                const current = store.job(job.jobId);
                const team = store.team(current.teamId);
                if (
                  gate(store.event(current.eventId), now()).kind !== "ok" ||
                  !this.progression.allowed(team, current.problemId) ||
                  store.jobId(current.eventId, current.teamId, current.problemId) !== current.jobId
                )
                  throw new Error("Battle scoring is not authorized.");
                return {
                  target: simulatorBattleUptimeTarget(current),
                  revision: store.uptimeState(current.eventId, current.teamId, current.problemId)
                    .revision,
                };
              },
              afterCommit: (team) => {
                this.progression.captureTeam(team);
                this.disruptions.captureTriggers(store.event(team.eventId));
              },
            },
            minute,
          ),
        );
        return true;
      });
  }
}

/** Private shutdown only: listeners, scheduler and accepted work must already be drained.
 * Never clear job ownership on success or failure; cloud stack deletion is separate.
 */
export async function cleanupOwnedBattle(service: HostingDomain): Promise<void> {
  const session = service.ownedBattleSession;
  if (!session) return;
  const failures: unknown[] = [];
  for (const job of service.store.jobs()) {
    if (job.problemId !== "hello-world-battle" || !job.unit) continue;
    try {
      if (!readSimulatorStackOrigin(job)) continue;
      await session.cleanup(retainedSimulatorBattleOwner(job));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Owned Battle cleanup is unconfirmed; retained ownership must not be discarded.",
    );
}
