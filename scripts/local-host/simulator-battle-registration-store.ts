import { z } from "zod";
import { battleOwnerKey } from "./simulator-battle-binding";
import {
  type BattleUptimeTarget,
  battleRegistrationLocator,
  battleUptimeTarget,
} from "./simulator-battle-uptime-target";
import type { HostStore } from "./store";

const providerDomain = z.string().regex(/^mono-[a-f0-9]{32}$/u);
const slotSchema = z.enum(["frontend", "api"]);
const rowSchema = z.strictObject({
  version: z.literal(1),
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  jobId: z.string().min(1),
  problemId: z.literal("hello-world-battle"),
  generation: z.string().min(1),
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/u),
  providerDomain,
  slot: slotSchema,
  locator: z.string().min(1),
  registeredAt: z.iso.datetime(),
});
const inputSchema = rowSchema.pick({
  generation: true,
  providerDomain: true,
  slot: true,
  locator: true,
  registeredAt: true,
});
export type BattleRegistrationInput = z.infer<typeof inputSchema>;
export type BattleRegistration = Readonly<z.infer<typeof rowSchema>>;
export interface OwnedBattleRegistrationScope {
  readonly kind: "owned-battle-registration-scope";
  readonly providerDomain: string;
}

/** Low-level storage, not an authority factory. Construct only in explicit owned
 * runtime composition. The caller must authenticate resolve and recheck gates
 * before put; neither a scope string nor a stored row proves VM ownership.
 * Prior generations/domains are retained, never silently migrated or deleted.
 */
export class SimulatorBattleRegistrationStore {
  private readonly domain: string;
  constructor(
    private readonly host: HostStore,
    scope: OwnedBattleRegistrationScope,
  ) {
    if (scope.kind !== "owned-battle-registration-scope")
      throw new Error("Explicit owned Battle registration scope required.");
    this.domain = providerDomain.parse(scope.providerDomain);
    host.database.exec(`CREATE TABLE IF NOT EXISTS host_simulator_battle_registrations (
      event_id TEXT NOT NULL REFERENCES host_events(id),
      team_id TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES host_jobs(id),
      problem_id TEXT NOT NULL,
      generation TEXT NOT NULL, provider_domain TEXT NOT NULL, slot TEXT NOT NULL,
      body TEXT NOT NULL,
      FOREIGN KEY(team_id,event_id) REFERENCES host_teams(id,event_id),
      PRIMARY KEY(event_id,team_id,job_id,problem_id,generation,provider_domain,slot)
    ) STRICT;`);
  }
  get(target: BattleUptimeTarget, slot: "frontend" | "api"): BattleRegistration | undefined {
    this.assertCurrent(target);
    slotSchema.parse(slot);
    const statement = this.host.database.prepare(
      "SELECT body FROM host_simulator_battle_registrations WHERE event_id=? AND team_id=? AND job_id=? AND problem_id=? AND generation=? AND provider_domain=? AND slot=?",
    );
    try {
      const row = statement.get(...this.keys(target, slot));
      if (!row) return undefined;
      const parsed = rowSchema.parse(
        JSON.parse(z.strictObject({ body: z.string() }).parse(row).body),
      );
      this.assertRow(parsed, target, slot);
      return Object.freeze(parsed);
    } finally {
      statement.finalize?.();
    }
  }
  put(target: BattleUptimeTarget, input: BattleRegistrationInput): void {
    this.assertCurrent(target);
    const parsed = inputSchema.parse(input);
    const row = rowSchema.parse({
      version: 1,
      eventId: target.owner.eventId,
      teamId: target.owner.teamId,
      jobId: target.owner.jobId,
      problemId: target.problemId,
      ownerKey: target.ownerKey,
      ...parsed,
    });
    this.assertRow(row, target, parsed.slot);
    const statement = this.host.database.prepare(
      "INSERT INTO host_simulator_battle_registrations(event_id,team_id,job_id,problem_id,generation,provider_domain,slot,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id,team_id,job_id,problem_id,generation,provider_domain,slot) DO UPDATE SET body=excluded.body",
    );
    try {
      const result = statement.run(...this.keys(target, parsed.slot), JSON.stringify(row));
      z.object({ changes: z.literal(1) }).parse(result);
    } finally {
      statement.finalize?.();
    }
  }
  remove(target: BattleUptimeTarget, slot: "frontend" | "api"): void {
    // Validate ownership and existing body before removal; retained generations are untouched.
    if (!this.get(target, slot)) throw new Error("Battle registration is not present.");
    const statement = this.host.database.prepare(
      "DELETE FROM host_simulator_battle_registrations WHERE event_id=? AND team_id=? AND job_id=? AND problem_id=? AND generation=? AND provider_domain=? AND slot=?",
    );
    try {
      z.object({ changes: z.literal(1) }).parse(statement.run(...this.keys(target, slot)));
    } finally {
      statement.finalize?.();
    }
  }
  private keys(target: BattleUptimeTarget, slot: "frontend" | "api") {
    return [
      target.owner.eventId,
      target.owner.teamId,
      target.owner.jobId,
      target.problemId,
      target.generation,
      this.domain,
      slot,
    ];
  }
  private assertRow(row: BattleRegistration, target: BattleUptimeTarget, slot: "frontend" | "api") {
    if (
      row.eventId !== target.owner.eventId ||
      row.teamId !== target.owner.teamId ||
      row.jobId !== target.owner.jobId ||
      row.problemId !== target.problemId ||
      row.generation !== target.generation ||
      row.ownerKey !== target.ownerKey ||
      row.providerDomain !== this.domain ||
      row.slot !== slot ||
      row.locator !== battleRegistrationLocator(target, slot)
    )
      throw new Error("Battle registration ownership or generation changed.");
  }
  private assertCurrent(target: BattleUptimeTarget) {
    const current = battleUptimeTarget(this.host.job(target.owner.jobId));
    const statement = this.host.database.prepare(
      "SELECT event_id,team_id,problem_id FROM host_jobs WHERE id=?",
    );
    try {
      const columns = z
        .strictObject({ event_id: z.string(), team_id: z.string(), problem_id: z.string() })
        .parse(statement.get(target.owner.jobId));
      if (
        columns.event_id !== current.owner.eventId ||
        columns.team_id !== current.owner.teamId ||
        columns.problem_id !== current.problemId ||
        current.kind !== target.kind ||
        current.problemId !== target.problemId ||
        current.generation !== target.generation ||
        current.ownerKey !== target.ownerKey ||
        battleOwnerKey(target.owner) !== current.ownerKey
      )
        throw new Error("Battle registration target is stale or foreign.");
    } finally {
      statement.finalize?.();
    }
  }
}
