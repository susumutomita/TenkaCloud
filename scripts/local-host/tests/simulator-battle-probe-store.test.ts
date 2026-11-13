import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimulatorBattleProbeStore } from "../simulator-battle-probe-store";
import { HostStore } from "../store";
import { descriptor, scope, seed, snapshot } from "./simulator-battle-journal-fixture";

test("journal CAS survives reopen; result readiness does not release active intent", () => {
  const directory = mkdtempSync(join(tmpdir(), "battle-journal-"));
  const path = join(directory, "state.sqlite");
  let host = new HostStore(new Database(path));
  try {
    const job = seed(host);
    const d = descriptor(job);
    let store = new SimulatorBattleProbeStore(host, scope);
    store.prepare(d, { authorizationRevision: 0 });
    expect(store.claimStart(d.key, 0).state).toBe("start-uncertain");
    expect(() => store.claimStart(d.key, 0)).toThrow();
    host.close();
    host = new HostStore(new Database(path));
    store = new SimulatorBattleProbeStore(host, scope);
    expect(store.get(d.key).descriptor).toEqual(d);
    expect(() =>
      store.prepare(descriptor(job, "d".repeat(32), `mono-${"e".repeat(32)}`), {
        authorizationRevision: 0,
      }),
    ).toThrow();
    const ready = store.saveSnapshot(d.key, 1, snapshot(d));
    expect(ready.state).toBe("start-uncertain");
    expect(() =>
      store.prepare(descriptor(job, "d".repeat(32)), { authorizationRevision: 0 }),
    ).toThrow();
    const settled = store.saveSnapshot(d.key, 2, snapshot(d, true));
    expect(settled.state).toBe("settled");
    expect(() => store.saveSnapshot(d.key, 3, snapshot(d))).toThrow();
    expect(() => store.recordUnknown(d.key, 3, "lost")).toThrow();
    expect(store.prepare(descriptor(job, "d".repeat(32)), { authorizationRevision: 0 }).state).toBe(
      "prepared",
    );
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("old generations remain readable and block replacement while other teams remain independent", () => {
  const host = new HostStore(new Database(":memory:"));
  try {
    const job = seed(host);
    const other = seed(host, "other");
    const store = new SimulatorBattleProbeStore(host, scope);
    const d = descriptor(job);
    store.prepare(d, { authorizationRevision: 0 });
    store.claimStart(d.key, 0);
    store.recordUnknown(d.key, 1, "response lost");
    job.deployedAt = 2000;
    host.putJob(job);
    expect(store.get(d.key).unknown).toBe("response lost");
    expect(store.active("event", "team", "frontend")?.descriptor.key).toBe(d.key);
    expect(store.active("event", "other", "frontend")).toBeUndefined();
    expect(() =>
      store.prepare(descriptor(job, "d".repeat(32)), { authorizationRevision: 0 }),
    ).toThrow();
    expect(
      store.prepare(descriptor(other, "e".repeat(32)), { authorizationRevision: 0 }).state,
    ).toBe("prepared");
    expect(() => store.saveSnapshot(d.key, 2, null)).toThrow();
    expect(store.get(d.key).revision).toBe(2);
  } finally {
    host.close();
  }
});

test("failed writes roll back CAS and snapshot state; corrupt ownership is rejected", () => {
  const host = new HostStore(new Database(":memory:"));
  try {
    const job = seed(host);
    const store = new SimulatorBattleProbeStore(host, scope);
    const d = descriptor(job);
    store.prepare(d, { authorizationRevision: 0 });
    host.database.exec(
      "CREATE TRIGGER refuse_probe BEFORE UPDATE ON host_simulator_battle_probes BEGIN SELECT RAISE(ABORT,'save failed'); END;",
    );
    expect(() => store.claimStart(d.key, 0)).toThrow("save failed");
    expect(store.get(d.key).state).toBe("prepared");
    host.database.exec("DROP TRIGGER refuse_probe;");
    store.claimStart(d.key, 0);
    host.database.exec(
      "CREATE TRIGGER refuse_probe BEFORE UPDATE ON host_simulator_battle_probes BEGIN SELECT RAISE(ABORT,'save failed'); END;",
    );
    expect(() => store.saveSnapshot(d.key, 1, snapshot(d, true))).toThrow("save failed");
    expect(store.get(d.key).state).toBe("start-uncertain");
    host.database.exec(
      "DROP TRIGGER refuse_probe; UPDATE host_simulator_battle_probes SET revision=99;",
    );
    expect(() => store.get(d.key)).toThrow("Foreign");
  } finally {
    host.close();
  }
});

test.each([
  "CREATE TRIGGER corrupt_claim BEFORE UPDATE ON host_simulator_battle_probes BEGIN SELECT RAISE(IGNORE); END;",
  "CREATE TRIGGER corrupt_claim AFTER UPDATE ON host_simulator_battle_probes BEGIN UPDATE host_simulator_battle_probes SET body=json_set(NEW.body,'$.unknown','rewritten') WHERE id=NEW.id; END;",
])("claim requires exactly one verified durable write: %s", (trigger) => {
  const host = new HostStore(new Database(":memory:"));
  try {
    const d = descriptor(seed(host));
    const store = new SimulatorBattleProbeStore(host, scope);
    const before = store.prepare(d, { authorizationRevision: 0 });
    host.database.exec(trigger);
    expect(() => store.claimStart(d.key, 0)).toThrow();
    expect(store.get(d.key)).toEqual(before);
  } finally {
    host.close();
  }
});

test("ignored INSERT is not reported as a prepared intent", () => {
  const host = new HostStore(new Database(":memory:"));
  try {
    const d = descriptor(seed(host));
    const store = new SimulatorBattleProbeStore(host, scope);
    host.database.exec(
      "CREATE TRIGGER ignore_prepare BEFORE INSERT ON host_simulator_battle_probes BEGIN SELECT RAISE(IGNORE); END;",
    );
    expect(() => store.prepare(d, { authorizationRevision: 0 })).toThrow();
    expect(store.active("event", "team", "frontend")).toBeUndefined();
  } finally {
    host.close();
  }
});

test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
  "invalid authorization revision %s cannot be saved",
  (authorizationRevision) => {
    const host = new HostStore(new Database(":memory:"));
    try {
      const d = descriptor(seed(host));
      const store = new SimulatorBattleProbeStore(host, scope);
      expect(() => store.prepare(d, { authorizationRevision })).toThrow();
      expect(store.active("event", "team", "frontend")).toBeUndefined();
    } finally {
      host.close();
    }
  },
);

test("minute slot pair persists after settlement and reopen without redispatch selection", () => {
  const directory = mkdtempSync(join(tmpdir(), "battle-minute-"));
  const path = join(directory, "state.sqlite");
  let host = new HostStore(new Database(path));
  try {
    const job = seed(host);
    const frontend = descriptor(job);
    const api = { ...descriptor(job, "d".repeat(32)), slot: "api" as const };
    let store = new SimulatorBattleProbeStore(host, scope);
    store.prepareMinute([frontend, api], { authorizationRevision: 0, minute: 42 });
    store.claimStart(frontend.key, 0);
    store.saveSnapshot(frontend.key, 1, snapshot(frontend, true));
    store.claimStart(api.key, 0);
    store.saveSnapshot(api.key, 1, {
      ...snapshot(api, true),
      service: api.receipt.slots.api.service,
      binding: api.receipt.slots.api.wireBinding,
    });
    host.close();
    host = new HostStore(new Database(path));
    store = new SimulatorBattleProbeStore(host, scope);
    expect(store.forMinute("event", "team", "frontend", 42)?.state).toBe("settled");
    expect(store.forMinute("event", "team", "api", 42)?.descriptor.key).toBe(api.key);
    expect(store.forMinute("event", "other", "frontend", 42)).toBeUndefined();
    expect(() =>
      store.prepareMinute([descriptor(job, "e".repeat(32)), { ...api, key: "f".repeat(32) }], {
        authorizationRevision: 0,
        minute: 42,
      }),
    ).toThrow();
    expect(store.forMinute("event", "team", "frontend", 42)?.descriptor.key).toBe(frontend.key);
    expect(() => store.get("e".repeat(32))).toThrow();
    expect(() => store.forMinute("event", "team", "frontend", -1)).toThrow();
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("minute pair rolls back the first slot if second insert fails", () => {
  const host = new HostStore(new Database(":memory:"));
  try {
    const job = seed(host);
    const store = new SimulatorBattleProbeStore(host, scope);
    const frontend = descriptor(job);
    const api = { ...descriptor(job, "d".repeat(32)), slot: "api" as const };
    host.database.exec(
      "CREATE TRIGGER fail_api BEFORE INSERT ON host_simulator_battle_probes WHEN NEW.slot='api' BEGIN SELECT RAISE(ABORT,'api failed'); END;",
    );
    expect(() =>
      store.prepareMinute([frontend, api], { authorizationRevision: 0, minute: 42 }),
    ).toThrow("api failed");
    expect(store.forMinute("event", "team", "frontend", 42)).toBeUndefined();
    expect(store.active("event", "team", "frontend")).toBeUndefined();
    host.database.exec("DROP TRIGGER fail_api;");
    expect(
      store.prepareMinute([frontend, api], { authorizationRevision: 0, minute: 42 }),
    ).toHaveLength(2);
  } finally {
    host.close();
  }
});

test("minute pair rejects differing provider receipts", () => {
  const host = new HostStore(new Database(":memory:"));
  try {
    const job = seed(host);
    const store = new SimulatorBattleProbeStore(host, scope);
    const frontend = descriptor(job);
    const api = { ...descriptor(job, "d".repeat(32)), slot: "api" as const };
    api.receipt = structuredClone(api.receipt);
    const oldHandle = api.receipt.handle;
    api.receipt.handle = "e".repeat(64);
    for (const slot of ["frontend", "api"] as const)
      api.receipt.binding.endpoints[slot] = api.receipt.binding.endpoints[slot].replace(
        oldHandle,
        api.receipt.handle,
      );
    expect(() =>
      store.prepareMinute([frontend, api], { authorizationRevision: 0, minute: 42 }),
    ).toThrow("Battle minute requires matching frontend and api intents.");
    expect(store.forMinute("event", "team", "frontend", 42)).toBeUndefined();
  } finally {
    host.close();
  }
});

test("expiration CAS retains minute tombstone and cannot regress or race a start", () => {
  const host = new HostStore(new Database(":memory:"));
  try {
    const job = seed(host);
    const d = descriptor(job);
    const api = { ...d, slot: "api" as const, key: "d".repeat(32) };
    const store = new SimulatorBattleProbeStore(host, scope);
    store.prepareMinute([d, api], { authorizationRevision: 0, minute: 1 });
    expect(() => store.expireUnstarted(d.key, 0, 1)).toThrow();
    const expired = store.expireUnstarted(d.key, 0, 2);
    expect(expired.state).toBe("expired-unstarted");
    expect(store.active("event", "team", "frontend")).toBeUndefined();
    expect(store.forMinute("event", "team", "frontend", 1)).toEqual(expired);
    expect(() => store.claimStart(d.key, 1)).toThrow();
    expect(() => store.saveSnapshot(d.key, 1, snapshot(d, true))).toThrow();
    expect(() => store.recordUnknown(d.key, 1, "lost")).toThrow();
    store.claimStart(api.key, 0);
    expect(() => store.expireUnstarted(api.key, 0, 2)).toThrow();
    expect(() => store.expireUnstarted(api.key, 1, 2)).toThrow();
    expect(store.active("event", "team", "api")?.state).toBe("start-uncertain");
  } finally {
    host.close();
  }
});

test("silently ignored expiration rolls back and keeps active intent", () => {
  const host = new HostStore(new Database(":memory:"));
  try {
    const d = descriptor(seed(host));
    const store = new SimulatorBattleProbeStore(host, scope);
    store.prepareMinute([d, { ...d, slot: "api", key: "d".repeat(32) }], {
      authorizationRevision: 0,
      minute: 1,
    });
    host.database.exec(
      "CREATE TRIGGER ignore_expire BEFORE UPDATE ON host_simulator_battle_probes BEGIN SELECT RAISE(IGNORE); END;",
    );
    expect(() => store.expireUnstarted(d.key, 0, 2)).toThrow();
    expect(store.active("event", "team", "frontend")?.state).toBe("prepared");
  } finally {
    host.close();
  }
});
