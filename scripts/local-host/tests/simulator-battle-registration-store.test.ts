import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../model";
import {
  type BattleRegistrationInput,
  SimulatorBattleRegistrationStore,
} from "../simulator-battle-registration-store";
import { battleRegistrationLocator, battleUptimeTarget } from "../simulator-battle-uptime-target";
import { HostStore } from "../store";

const domain = `mono-${"a".repeat(32)}`;
const otherDomain = `mono-${"b".repeat(32)}`;
const scope = { kind: "owned-battle-registration-scope" as const, providerDomain: domain };
function job(): Job {
  return {
    jobId: "job",
    eventId: "event",
    teamId: "team",
    problemId: "hello-world-battle",
    definition: JSON.stringify({
      kind: "cloudformation",
      problemId: "hello-world-battle",
      scoring: { kind: "uptime-flat" },
    }),
    offset: 0,
    status: "COMPLETE",
    deployedAt: 1700000000000,
    unit: JSON.stringify({
      kind: "cloudformation",
      stackId: "stack",
      outputs: { InstanceId: "i-one" },
    }),
  };
}
function seed(host: HostStore) {
  host.putEvent({
    eventId: "event",
    name: "Synthetic",
    status: "READY",
    createdAt: "now",
    updatedAt: "now",
    expiresAt: 1,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [],
  });
  for (const id of ["team", "other"])
    host.putTeam({
      teamId: id,
      eventId: "event",
      internalSlug: id,
      displayName: id,
      loginKey: `key-${id}`,
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
    });
  host.putJob(job());
}
function fixture() {
  const database = new Database(":memory:");
  const host = new HostStore(database);
  seed(host);
  const store = new SimulatorBattleRegistrationStore(host, scope);
  return { database, host, store };
}
function input(
  target = battleUptimeTarget(job()),
  slot: "frontend" | "api" = "frontend",
): BattleRegistrationInput {
  return {
    generation: target.generation,
    providerDomain: domain,
    slot,
    locator: battleRegistrationLocator(target, slot),
    registeredAt: "2026-11-12T00:00:00Z",
  };
}
function count(database: Database) {
  return database.query("SELECT COUNT(*) AS count FROM host_simulator_battle_registrations").get();
}
test("no registration table or public override mutation before explicit scoped construction", () => {
  const database = new Database(":memory:");
  const host = new HostStore(database);
  try {
    seed(host);
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE name='host_simulator_battle_registrations'")
        .get(),
    ).toBeNull();
    host.putUptimeOverride("event", "team", "hello-world-battle", {
      slot: "frontend",
      overrideUrl: "https://example.com",
      updatedAt: "old",
    });
    const store = new SimulatorBattleRegistrationStore(host, scope);
    const target = battleUptimeTarget(job());
    expect(store.get(target, "frontend")).toBeUndefined();
    store.put(target, input(target));
    expect(store.get(target, "frontend")?.locator).toBe(
      battleRegistrationLocator(target, "frontend"),
    );
    expect(store.get(target, "api")).toBeUndefined();
    expect(host.uptimeOverrides("event", "team", "hello-world-battle")).toEqual([
      { slot: "frontend", overrideUrl: "https://example.com", updatedAt: "old" },
    ]);
  } finally {
    host.close();
  }
});
test("exact records survive SQLite close/reopen without migration or runtime qualification", () => {
  const directory = mkdtempSync(join(tmpdir(), "battle-registration-"));
  const path = join(directory, "host.sqlite");
  let host = new HostStore(new Database(path));
  try {
    seed(host);
    const target = battleUptimeTarget(job());
    const registrations = new SimulatorBattleRegistrationStore(host, scope);
    registrations.put(target, input(target));
    const before = registrations.get(target, "frontend");
    host.close();
    host = new HostStore(new Database(path));
    expect(new SimulatorBattleRegistrationStore(host, scope).get(target, "frontend")).toEqual(
      before,
    );
    const newRuntime = new SimulatorBattleRegistrationStore(host, {
      ...scope,
      providerDomain: otherDomain,
    });
    expect(newRuntime.get(target, "frontend")).toBeUndefined();
    expect(count(host.database as Database)).toEqual({ count: 1 });
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
for (const [label, change] of [
  [
    "foreign provider",
    (i: BattleRegistrationInput) => {
      i.providerDomain = otherDomain;
    },
  ],
  [
    "foreign generation",
    (i: BattleRegistrationInput) => {
      i.generation = "old";
    },
  ],
  [
    "foreign locator",
    (i: BattleRegistrationInput) => {
      i.locator = `simulator://${"e".repeat(64)}/frontend`;
    },
  ],
  [
    "swapped slot",
    (i: BattleRegistrationInput) => {
      i.slot = "api";
    },
  ],
  [
    "invalid timestamp",
    (i: BattleRegistrationInput) => {
      i.registeredAt = "yesterday";
    },
  ],
] as const)
  test(`writer rejects ${label}`, () => {
    const f = fixture();
    try {
      const value = input();
      change(value);
      expect(() => f.store.put(battleUptimeTarget(job()), value)).toThrow();
      expect(count(f.database)).toEqual({ count: 0 });
    } finally {
      f.host.close();
    }
  });
test("old generation is refused while its original row is preserved", () => {
  const f = fixture();
  try {
    const prior = battleUptimeTarget(job());
    f.store.put(prior, input(prior));
    const nextJob = { ...job(), deployedAt: 1700000000001 };
    f.host.putJob(nextJob);
    expect(() => f.store.get(prior, "frontend")).toThrow("stale or foreign");
    expect(() => f.store.put(prior, input(prior))).toThrow("stale or foreign");
    const current = battleUptimeTarget(nextJob);
    expect(f.store.get(current, "frontend")).toBeUndefined();
    f.store.put(current, input(current));
    expect(count(f.database)).toEqual({ count: 2 });
  } finally {
    f.host.close();
  }
});
test("job/team ownership is checked against relational columns as well as body", () => {
  const f = fixture();
  try {
    const forgedJob = { ...job(), teamId: "other" };
    expect(() =>
      f.store.put(battleUptimeTarget(forgedJob), input(battleUptimeTarget(forgedJob))),
    ).toThrow("stale or foreign");
    f.database.query("UPDATE host_jobs SET body=? WHERE id='job'").run(JSON.stringify(forgedJob));
    expect(() =>
      f.store.put(battleUptimeTarget(forgedJob), input(battleUptimeTarget(forgedJob))),
    ).toThrow("stale or foreign");
    expect(count(f.database)).toEqual({ count: 0 });
  } finally {
    f.host.close();
  }
});
for (const [label, bodyChange] of [
  ["malformed JSON", () => "{"],
  [
    "foreign domain",
    (body: Record<string, unknown>) => JSON.stringify({ ...body, providerDomain: otherDomain }),
  ],
  ["foreign slot", (body: Record<string, unknown>) => JSON.stringify({ ...body, slot: "api" })],
  [
    "foreign owner",
    (body: Record<string, unknown>) => JSON.stringify({ ...body, teamId: "other" }),
  ],
  [
    "foreign generation",
    (body: Record<string, unknown>) => JSON.stringify({ ...body, generation: "old" }),
  ],
  [
    "unknown schema field",
    (body: Record<string, unknown>) => JSON.stringify({ ...body, trusted: true }),
  ],
] as const)
  test(`reader rejects corrupted ${label}`, () => {
    const f = fixture();
    try {
      const target = battleUptimeTarget(job());
      f.store.put(target, input(target));
      const stored = f.store.get(target, "frontend");
      if (!stored) throw new Error("missing test registration");
      f.database
        .query("UPDATE host_simulator_battle_registrations SET body=?")
        .run(bodyChange(stored));
      expect(() => f.store.get(target, "frontend")).toThrow();
      expect(count(f.database)).toEqual({ count: 1 });
    } finally {
      f.host.close();
    }
  });
test("foreign keys refuse orphan registration and do not silently delete retained rows", () => {
  const f = fixture();
  try {
    const target = battleUptimeTarget(job());
    f.store.put(target, input(target));
    expect(() =>
      f.database.exec("UPDATE host_simulator_battle_registrations SET job_id='missing'"),
    ).toThrow();
    expect(() =>
      f.database.exec("UPDATE host_simulator_battle_registrations SET team_id='missing'"),
    ).toThrow();
    expect(() => f.database.exec("DELETE FROM host_jobs WHERE id='job'")).toThrow();
    expect(f.store.get(target, "frontend")).toBeDefined();
  } finally {
    f.host.close();
  }
});
test("invalid provider scope fails before creating a new table", () => {
  const database = new Database(":memory:");
  const host = new HostStore(database);
  try {
    expect(
      () => new SimulatorBattleRegistrationStore(host, { ...scope, providerDomain: "foreign" }),
    ).toThrow();
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE name='host_simulator_battle_registrations'")
        .get(),
    ).toBeNull();
  } finally {
    host.close();
  }
});

test("equivalent target object order does not change ownership", () => {
  const f = fixture();
  try {
    const original = battleUptimeTarget(job());
    const reordered = {
      ownerKey: original.ownerKey,
      generation: original.generation,
      problemId: original.problemId,
      kind: original.kind,
      owner: {
        instanceId: original.owner.instanceId,
        stackId: original.owner.stackId,
        deployedAt: original.owner.deployedAt,
        unitHash: original.owner.unitHash,
        jobId: original.owner.jobId,
        teamId: original.owner.teamId,
        eventId: original.owner.eventId,
      },
    };
    f.store.put(reordered, input(original));
    expect(f.store.get(original, "frontend")).toEqual(f.store.get(reordered, "frontend"));
  } finally {
    f.host.close();
  }
});

test("two actual team jobs keep both slots isolated across update and redeploy", () => {
  const f = fixture();
  try {
    const secondJob = { ...job(), jobId: "other-job", teamId: "other" };
    f.host.putJob(secondJob);
    const first = battleUptimeTarget(job());
    const second = battleUptimeTarget(secondJob);
    for (const target of [first, second])
      for (const slot of ["frontend", "api"] as const) f.store.put(target, input(target, slot));
    const secondBefore = [f.store.get(second, "frontend"), f.store.get(second, "api")];
    expect(count(f.database)).toEqual({ count: 4 });
    expect(first.ownerKey).not.toBe(second.ownerKey);
    for (const slot of ["frontend", "api"] as const) {
      expect(() =>
        f.store.put(first, { ...input(first, slot), locator: input(second, slot).locator }),
      ).toThrow();
      expect(() =>
        f.store.put(second, { ...input(second, slot), locator: input(first, slot).locator }),
      ).toThrow();
    }
    f.store.put(first, { ...input(first), registeredAt: "2026-11-12T01:00:00Z" });
    expect([f.store.get(second, "frontend"), f.store.get(second, "api")]).toEqual(secondBefore);
    const redeployed = { ...job(), deployedAt: first.owner.deployedAt + 1 };
    f.host.putJob(redeployed);
    const next = battleUptimeTarget(redeployed);
    expect(() => f.store.get(first, "frontend")).toThrow();
    expect(f.store.get(next, "frontend")).toBeUndefined();
    for (const slot of ["frontend", "api"] as const) f.store.put(next, input(next, slot));
    expect(count(f.database)).toEqual({ count: 6 });
    expect([f.store.get(second, "frontend"), f.store.get(second, "api")]).toEqual(secondBefore);
  } finally {
    f.host.close();
  }
});
