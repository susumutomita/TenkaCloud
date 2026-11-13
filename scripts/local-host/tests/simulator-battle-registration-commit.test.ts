import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SimulatorBattleProbeStore } from "../simulator-battle-probe-store";
import { createBattleRegistrationCommit } from "../simulator-battle-registration-commit";
import { SimulatorBattleRegistrationStore } from "../simulator-battle-registration-store";
import { simulatorBattleUptimeTarget } from "../simulator-battle-uptime-target";
import { HostStore } from "../store";
import { descriptor, seed } from "./simulator-battle-journal-fixture";

function fixture() {
  const host = new HostStore(new Database(":memory:"));
  const job = seed(host);
  const second = seed(host, "other");
  const domain = descriptor(job).deadline.domain;
  const registrations = new SimulatorBattleRegistrationStore(host, {
    kind: "owned-battle-registration-scope",
    providerDomain: domain,
  });
  const commit = createBattleRegistrationCommit(host, domain);
  const intent = {
    target: simulatorBattleUptimeTarget(job),
    expectedRevision: 0,
    slot: "frontend" as const,
    providerDomain: domain,
    registeredAt: "2026-11-12T00:00:00.000Z",
  };
  return { host, second, registrations, commit, intent };
}
test("registration and persistent revision commit together with independent teams", () => {
  const f = fixture();
  try {
    expect(f.commit(f.intent)).toEqual({ revision: 1 });
    expect(f.registrations.get(f.intent.target, "frontend")).toBeDefined();
    expect(f.host.uptimeState("event", "team", "hello-world-battle").revision).toBe(1);
    expect(f.host.uptimeState("event", "other", "hello-world-battle").revision).toBe(0);
    expect(() => f.commit(f.intent)).toThrow("revision changed");
    expect(f.commit({ ...f.intent, target: simulatorBattleUptimeTarget(f.second) })).toEqual({
      revision: 1,
    });
    expect(f.commit({ ...f.intent, expectedRevision: 1 })).toEqual({ revision: 2 });
  } finally {
    f.host.close();
  }
});
test.each([
  "CREATE TRIGGER fail_revision BEFORE INSERT ON host_uptime_state BEGIN SELECT RAISE(ABORT,'revision failed'); END;",
  "CREATE TRIGGER fail_revision BEFORE INSERT ON host_uptime_state BEGIN SELECT RAISE(IGNORE); END;",
  "CREATE TRIGGER fail_registration BEFORE INSERT ON host_simulator_battle_registrations BEGIN SELECT RAISE(IGNORE); END;",
  "CREATE TRIGGER rewrite_revision AFTER INSERT ON host_uptime_state BEGIN UPDATE host_uptime_state SET body=json_set(NEW.body,'$.revision',17); END;",
])("atomic failure rolls back registration and revision: %s", (trigger) => {
  const f = fixture();
  try {
    f.host.database.exec(trigger);
    expect(() => f.commit(f.intent)).toThrow();
    expect(f.registrations.get(f.intent.target, "frontend")).toBeUndefined();
    expect(f.host.uptimeState("event", "team", "hello-world-battle").revision).toBe(0);
  } finally {
    f.host.close();
  }
});
test("silently ignored same-value re-registration cannot advance only the revision", () => {
  const f = fixture();
  try {
    f.commit(f.intent);
    const before = f.registrations.get(f.intent.target, "frontend");
    f.host.database.exec(
      "CREATE TRIGGER ignore_update BEFORE UPDATE ON host_simulator_battle_registrations BEGIN SELECT RAISE(IGNORE); END;",
    );
    expect(() => f.commit({ ...f.intent, expectedRevision: 1 })).toThrow();
    expect(f.registrations.get(f.intent.target, "frontend")).toEqual(before);
    expect(f.host.uptimeState("event", "team", "hello-world-battle").revision).toBe(1);
  } finally {
    f.host.close();
  }
});
test("foreign target and domain cannot commit or advance a revision", () => {
  const f = fixture();
  try {
    expect(() => f.commit({ ...f.intent, providerDomain: `mono-${"e".repeat(32)}` })).toThrow();
    expect(() =>
      f.commit({
        ...f.intent,
        target: { ...f.intent.target, owner: { ...f.intent.target.owner, teamId: "other" } },
      }),
    ).toThrow();
    expect(f.host.uptimeState("event", "team", "hello-world-battle").revision).toBe(0);
    expect(f.host.uptimeState("event", "other", "hello-world-battle").revision).toBe(0);
  } finally {
    f.host.close();
  }
});

test("participant registration atomically refuses unresolved probe revision invalidation", () => {
  const f = fixture();
  try {
    const job = f.host.job(f.intent.target.owner.jobId);
    const probes = new SimulatorBattleProbeStore(f.host, { kind: "owned-battle-probe-journal" });
    const d = descriptor(job);
    probes.prepare(d, { authorizationRevision: 0 });
    probes.claimStart(d.key, 0);
    const participantCommit = createBattleRegistrationCommit(f.host, f.intent.providerDomain, true);
    expect(() => participantCommit(f.intent)).toThrow("unresolved");
    expect(f.host.uptimeState("event", "team", "hello-world-battle").revision).toBe(0);
    expect(probes.get(d.key).state).toBe("start-uncertain");
    expect(probes.get(d.key).authorizationRevision).toBe(0);
  } finally {
    f.host.close();
  }
});

test("idle removal is atomic and retains the other registered slot", async () => {
  const { createBattleRegistrationRemoval } = await import(
    "../simulator-battle-registration-commit"
  );
  const f = fixture();
  try {
    f.commit(f.intent);
    f.commit({ ...f.intent, slot: "api", expectedRevision: 1 });
    const remove = createBattleRegistrationRemoval(f.host, f.intent.providerDomain);
    expect(remove({ ...f.intent, expectedRevision: 2 }).revision).toBe(3);
    expect(f.registrations.get(f.intent.target, "frontend")).toBeUndefined();
    expect(f.registrations.get(f.intent.target, "api")).toBeDefined();
    expect(() => remove({ ...f.intent, expectedRevision: 3 })).toThrow();
    expect(f.host.uptimeState("event", "team", "hello-world-battle").revision).toBe(3);
  } finally {
    f.host.close();
  }
});
test.each(["ignore_delete", "ignore_revision", "uncertain"])(
  "removal preserves registration on %s",
  async (kind) => {
    const { createBattleRegistrationRemoval } = await import(
      "../simulator-battle-registration-commit"
    );
    const f = fixture();
    try {
      f.commit(f.intent);
      if (kind === "ignore_delete")
        f.host.database.exec(
          "CREATE TRIGGER ignore_delete BEFORE DELETE ON host_simulator_battle_registrations BEGIN SELECT RAISE(IGNORE); END;",
        );
      if (kind === "ignore_revision")
        f.host.database.exec(
          "CREATE TRIGGER ignore_revision BEFORE UPDATE ON host_uptime_state BEGIN SELECT RAISE(IGNORE); END;",
        );
      if (kind === "uncertain") {
        const probes = new SimulatorBattleProbeStore(f.host, {
          kind: "owned-battle-probe-journal",
        });
        const d = descriptor(f.host.job(f.intent.target.owner.jobId));
        probes.prepare(d, { authorizationRevision: 1 });
        probes.claimStart(d.key, 0);
      }
      const remove = createBattleRegistrationRemoval(f.host, f.intent.providerDomain);
      expect(() => remove({ ...f.intent, expectedRevision: 1 })).toThrow();
      expect(f.registrations.get(f.intent.target, "frontend")).toBeDefined();
      expect(f.host.uptimeState("event", "team", "hello-world-battle").revision).toBe(1);
    } finally {
      f.host.close();
    }
  },
);
