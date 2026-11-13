import { z } from "zod";
import { battleOwnerKey } from "./simulator-battle-binding";
import {
  type BattleProbeDescriptor,
  parseBattleProbeDescriptor,
  validateBattleProbeSnapshot,
} from "./simulator-battle-probe";
import { simulatorBattleUptimeTarget } from "./simulator-battle-uptime-target";
import type { HostStore } from "./store";

const trustedMetadata = z.strictObject({
  authorizationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  minute: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
const metadata = z.strictObject({
  authorizationRevision: trustedMetadata.shape.authorizationRevision,
  minute: trustedMetadata.shape.minute,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["prepared", "start-uncertain", "settled", "expired-unstarted"]),
  descriptor: z.unknown(),
  snapshot: z.unknown().optional(),
  unknown: z.string().min(1).max(256).optional(),
});
const columns = z.strictObject({
  id: z.string(),
  event_id: z.string(),
  team_id: z.string(),
  job_id: z.string(),
  slot: z.string(),
  active: z.number(),
  revision: z.number(),
  body: z.string(),
});
export interface BattleProbeRecord {
  readonly revision: number;
  readonly authorizationRevision: number;
  readonly minute?: number;
  readonly state: "prepared" | "start-uncertain" | "settled" | "expired-unstarted";
  readonly descriptor: BattleProbeDescriptor;
  readonly snapshot?: ReturnType<typeof validateBattleProbeSnapshot>;
  readonly unknown?: string;
}

/** Explicitly owned runtime only. Durable correlation, not provider/scoring authority.
 * Old generations/domains remain readable and block replacement while unresolved.
 */
export class SimulatorBattleProbeStore {
  constructor(
    private readonly host: HostStore,
    scope: { kind: "owned-battle-probe-journal" },
  ) {
    if (scope.kind !== "owned-battle-probe-journal")
      throw new Error("Owned Battle journal required.");
    host.database.exec(`CREATE TABLE IF NOT EXISTS host_simulator_battle_probes (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES host_events(id),
      team_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES host_jobs(id),
      slot TEXT NOT NULL CHECK(slot IN ('frontend','api')),
      active INTEGER NOT NULL CHECK(active IN (0,1)), revision INTEGER NOT NULL,
      body TEXT NOT NULL,
      FOREIGN KEY(team_id,event_id) REFERENCES host_teams(id,event_id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS host_simulator_battle_probes_active
      ON host_simulator_battle_probes(event_id,team_id,slot) WHERE active=1;
    CREATE UNIQUE INDEX IF NOT EXISTS host_simulator_battle_probes_minute
      ON host_simulator_battle_probes(event_id,team_id,slot,json_extract(body,'$.minute'))
      WHERE json_extract(body,'$.minute') IS NOT NULL;`);
  }
  prepare(value: unknown, authorization: { authorizationRevision: number }): BattleProbeRecord {
    const trusted = trustedMetadata.parse(authorization);
    return this.host.transaction(() => this.insert(value, trusted));
  }
  /** Both slots are fixed atomically before either can be dispatched. */
  prepareMinute(
    values: readonly [unknown, unknown],
    authorization: { authorizationRevision: number; minute: number },
  ): readonly [BattleProbeRecord, BattleProbeRecord] {
    const trusted = trustedMetadata
      .extend({ minute: trustedMetadata.shape.minute.unwrap() })
      .parse(authorization);
    const [frontend, api] = values.map(parseBattleProbeDescriptor);
    if (
      !frontend ||
      !api ||
      frontend.slot !== "frontend" ||
      api.slot !== "api" ||
      battleOwnerKey(frontend.owner) !== battleOwnerKey(api.owner) ||
      frontend.generation !== api.generation ||
      JSON.stringify(frontend.receipt) !== JSON.stringify(api.receipt) ||
      frontend.deadline.domain !== api.deadline.domain
    )
      throw new Error("Battle minute requires matching frontend and api intents.");
    return this.host.transaction(
      () => [this.insert(frontend, trusted), this.insert(api, trusted)] as const,
    );
  }
  private insert(
    value: unknown,
    authorization: { authorizationRevision: number; minute?: number },
  ): BattleProbeRecord {
    const descriptor = parseBattleProbeDescriptor(value);
    this.assertCurrent(descriptor);
    const record = this.validate({ ...authorization, revision: 0, state: "prepared", descriptor });
    const statement = this.host.database.prepare(
      "INSERT INTO host_simulator_battle_probes(id,event_id,team_id,job_id,slot,active,revision,body) VALUES(?,?,?,?,?,1,0,?)",
    );
    try {
      const o = descriptor.owner;
      const result = statement.run(
        descriptor.key,
        o.eventId,
        o.teamId,
        o.jobId,
        descriptor.slot,
        JSON.stringify(record),
      );
      z.object({ changes: z.literal(1) }).parse(result);
    } finally {
      statement.finalize?.();
    }
    this.assertSaved(record);
    return record;
  }
  get(id: string): BattleProbeRecord {
    const statement = this.host.database.prepare(
      "SELECT * FROM host_simulator_battle_probes WHERE id=?",
    );
    try {
      const row = columns.parse(statement.get(id));
      const record = this.validate(JSON.parse(row.body));
      const d = record.descriptor;
      if (
        row.id !== d.key ||
        row.event_id !== d.owner.eventId ||
        row.team_id !== d.owner.teamId ||
        row.job_id !== d.owner.jobId ||
        row.slot !== d.slot ||
        row.revision !== record.revision ||
        row.active !== Number(record.state === "prepared" || record.state === "start-uncertain")
      )
        throw new Error("Foreign Battle journal row.");
      this.assertOwnership(d);
      return record;
    } finally {
      statement.finalize?.();
    }
  }
  active(eventId: string, teamId: string, slot: "frontend" | "api"): BattleProbeRecord | undefined {
    z.enum(["frontend", "api"]).parse(slot);
    const statement = this.host.database.prepare(
      "SELECT id FROM host_simulator_battle_probes WHERE event_id=? AND team_id=? AND slot=? AND active=1",
    );
    try {
      const row = statement.get(eventId, teamId, slot);
      return row ? this.get(z.strictObject({ id: z.string() }).parse(row).id) : undefined;
    } finally {
      statement.finalize?.();
    }
  }
  /** Durable scoring-minute association, not scoring qualification. Settled records
   * keep their claim so a crash before score commit cannot cause another dispatch.
   * Generation/domain/revision must still be checked by the caller. */
  forMinute(
    eventId: string,
    teamId: string,
    slot: "frontend" | "api",
    minute: number,
  ): BattleProbeRecord | undefined {
    z.enum(["frontend", "api"]).parse(slot);
    trustedMetadata.shape.minute.unwrap().parse(minute);
    const statement = this.host.database.prepare(
      "SELECT id FROM host_simulator_battle_probes WHERE event_id=? AND team_id=? AND slot=? AND json_extract(body,'$.minute')=?",
    );
    try {
      const row = statement.get(eventId, teamId, slot, minute);
      const record = row ? this.get(z.strictObject({ id: z.string() }).parse(row).id) : undefined;
      if (record && record.minute !== minute) throw new Error("Foreign Battle probe minute.");
      return record;
    } finally {
      statement.finalize?.();
    }
  }
  /** Trusted scheduler minute only. CAS competes with claimStart: never release a
   * possibly dispatched intent. Tombstone preserves its key/minute permanently. */
  expireUnstarted(id: string, revision: number, currentMinute: number): BattleProbeRecord {
    trustedMetadata.shape.minute.unwrap().parse(currentMinute);
    return this.change(id, revision, (prior) => {
      if (prior.state !== "prepared" || prior.minute === undefined || prior.minute >= currentMinute)
        throw new Error("Only a prior-minute unstarted Battle intent can expire.");
      return { ...prior, state: "expired-unstarted" };
    });
  }
  claimStart(id: string, revision: number): BattleProbeRecord {
    return this.change(id, revision, (prior) => {
      if (prior.state !== "prepared") throw new Error("Battle start already claimed.");
      this.assertCurrent(prior.descriptor);
      return { ...prior, state: "start-uncertain" };
    });
  }
  saveSnapshot(id: string, revision: number, value: unknown): BattleProbeRecord {
    return this.change(id, revision, (prior) => {
      if (prior.state === "expired-unstarted")
        throw new Error("Expired intent cannot receive a snapshot.");
      const snapshot = validateBattleProbeSnapshot(value, prior.descriptor, prior.snapshot);
      return {
        ...prior,
        snapshot,
        unknown: undefined,
        state: snapshot.settled ? "settled" : "start-uncertain",
      };
    });
  }
  recordUnknown(id: string, revision: number, reason: string): BattleProbeRecord {
    return this.change(id, revision, (prior) => {
      if (prior.state === "settled" || prior.state === "expired-unstarted")
        throw new Error("Settled Battle intent cannot regress.");
      return { ...prior, unknown: reason };
    });
  }
  private change(
    id: string,
    revision: number,
    update: (prior: BattleProbeRecord) => Omit<BattleProbeRecord, "revision">,
  ): BattleProbeRecord {
    return this.host.transaction(() => {
      const prior = this.get(id);
      if (prior.revision !== revision || revision === Number.MAX_SAFE_INTEGER)
        throw new Error("Battle journal revision changed.");
      const next = this.validate({ ...update(prior), revision: revision + 1 });
      const statement = this.host.database.prepare(
        "UPDATE host_simulator_battle_probes SET body=?,revision=?,active=? WHERE id=? AND revision=?",
      );
      try {
        const result = statement.run(
          JSON.stringify(next),
          next.revision,
          Number(next.state === "prepared" || next.state === "start-uncertain"),
          id,
          revision,
        );
        z.object({ changes: z.literal(1) }).parse(result);
      } finally {
        statement.finalize?.();
      }
      this.assertSaved(next);
      return next;
    });
  }
  private assertSaved(expected: BattleProbeRecord): void {
    const actual = this.get(expected.descriptor.key);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error("Battle journal saved state differs from intent.");
    const statement = this.host.database.prepare(
      "SELECT body FROM host_simulator_battle_probes WHERE id=?",
    );
    try {
      const row = z
        .strictObject({ body: z.string() })
        .parse(statement.get(expected.descriptor.key));
      if (row.body !== JSON.stringify(expected))
        throw new Error("Battle journal body was rewritten.");
    } finally {
      statement.finalize?.();
    }
  }
  private validate(value: unknown): BattleProbeRecord {
    const row = metadata.parse(value);
    const descriptor = parseBattleProbeDescriptor(row.descriptor);
    const snapshot =
      row.snapshot === undefined
        ? undefined
        : validateBattleProbeSnapshot(row.snapshot, descriptor);
    if (
      (row.state === "settled") !== (snapshot?.settled === true) ||
      ((row.state === "prepared" || row.state === "expired-unstarted") && snapshot) ||
      (row.state === "expired-unstarted" && (row.minute === undefined || row.unknown !== undefined))
    )
      throw new Error("Inconsistent Battle journal settlement.");
    return Object.freeze({ ...row, descriptor, snapshot });
  }
  private assertOwnership(d: BattleProbeDescriptor): void {
    const statement = this.host.database.prepare(
      "SELECT event_id,team_id,problem_id FROM host_jobs WHERE id=?",
    );
    try {
      const row = z
        .strictObject({ event_id: z.string(), team_id: z.string(), problem_id: z.string() })
        .parse(statement.get(d.owner.jobId));
      if (
        row.event_id !== d.owner.eventId ||
        row.team_id !== d.owner.teamId ||
        row.problem_id !== "hello-world-battle"
      )
        throw new Error("Foreign Battle journal ownership.");
    } finally {
      statement.finalize?.();
    }
  }
  private assertCurrent(d: BattleProbeDescriptor): void {
    this.assertOwnership(d);
    const current = simulatorBattleUptimeTarget(this.host.job(d.owner.jobId));
    if (
      current.generation !== d.generation ||
      battleOwnerKey(current.owner) !== battleOwnerKey(d.owner)
    )
      throw new Error("Stale Battle journal deployment.");
  }
}
