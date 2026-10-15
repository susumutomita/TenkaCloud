import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import type { LocalComposeUnit } from "../container/container-runner";
import { requiredNetworkValue } from "../local-network";
import type { Job } from "../model";
import { HostingService } from "../service";
import { networkEngineFixture } from "./network-engine-fixture";

test("a new resume error replaces stale STOPPED state when the guard did not persist a new stop", async () => {
  const f = networkEngineFixture();
  const { job } = f.add("stale-stopped");
  job.status = "STOPPED";
  job.deployedAt = 1;
  job.error = "Previous stop";
  f.store.putJob(job);
  f.engine.resume = async () => {
    throw new Error("Retained secret cannot be rewritten");
  };
  const service = new HostingService(f.store, f.engine, "synthetic-host-key");
  try {
    const run = Reflect.get(service, "runDemandOperation") as (
      id: string,
      action: "start",
    ) => Promise<void>;
    await run.call(service, job.jobId, "start");
    expect(f.store.job(job.jobId).status).toBe("FAILED");
    expect(f.store.job(job.jobId).error).toContain("Retained secret cannot be rewritten");
  } finally {
    await service.drain();
    await f.close();
  }
});

test("publication mutation awaits the asynchronous guard instead of synchronous native transports", async () => {
  const f = networkEngineFixture();
  const { job } = f.add("async-publication");
  const foreign = { ...f.add("unrelated-event").job, eventId: "other-event" };
  f.store.putJob(foreign);
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.guard.update = () => {
    throw new Error("Synchronous mutation is forbidden");
  };
  f.guard.publishAsync = async () => {
    entered();
    await barrier;
  };
  const apply = Reflect.get(f.engine, "applyPublications") as (
    event: string,
    changes: Map<string, Job>,
    disabled: Set<string>,
  ) => Promise<void>;
  const pending = apply.call(f.engine, "event", new Map(), new Set());
  try {
    await started;
    expect(f.engine.terminalSupported(job)).toBe(false);
    expect(f.engine.terminalSupported(foreign)).toBe(true);
    expect(() => f.engine.surfaces(job)).toThrow("policy is changing");
    await Bun.sleep(1);
    expect(f.calls).not.toContain("route");
    release();
    await pending;
    expect(f.calls).toContain("retain");
    expect(f.engine.terminalSupported(job)).toBe(true);
  } finally {
    release();
    await pending;
    await f.close();
  }
});

test("a replaced requester cannot receive the previous generation network view", async () => {
  const f = networkEngineFixture();
  const { job } = f.add("replaced-requester");
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.guard.audit = async () => {
    entered();
    await barrier;
  };
  const pending = f.engine.networkView(
    {
      event: f.store.event("event"),
      team: f.store.team(job.teamId),
      jobs: [job],
      now: 1000,
    },
    job.problemId,
  );
  try {
    await started;
    f.add("replaced-requester");
    release();
    await expect(pending).rejects.toThrow("policy is changing");
    expect(f.engine.terminalSupported(f.store.job(job.jobId))).toBe(true);
  } finally {
    release();
    await pending.catch(() => undefined);
    await f.close();
  }
});

test("repeated shared views reuse generation-scoped audits", async () => {
  const f = networkEngineFixture();
  f.add("cached-view");
  const view = Reflect.get(f.engine, "sharedPublicServices") as (context: {
    event: { eventId: string };
  }) => Promise<unknown>;
  try {
    await Promise.all(
      Array.from({ length: 20 }, () => view.call(f.engine, { event: { eventId: "event" } })),
    );
    expect(f.calls.filter((call) => call === "audit")).toHaveLength(1);
    await view.call(f.engine, { event: { eventId: "event" } });
    expect(f.calls.filter((call) => call === "audit")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const action of ["pause", "recover", "resume", "stop"] as const)
  for (const missing of [false, true])
    test(`${action} revokes and safely stops retained ownership when Compose is ${missing ? "missing" : "modified"}`, async () => {
      const f = networkEngineFixture();
      const { job, unit } = f.add(`file-${action}-${missing}`);
      if (missing) rmSync(unit.composePath);
      else writeFileSync(unit.composePath, "untrusted replacement");
      f.calls.length = 0;
      try {
        await expect(f.engine[action](job)).rejects.toThrow();
        expect(f.calls).toContain("quarantine");
        expect(f.calls).toContain("stop-owned");
        expect(f.calls.indexOf("quarantine")).toBeLessThan(f.calls.indexOf("stop-owned"));
        expect(f.engine.terminalSupported(job)).toBe(false);
        expect(f.store.job(job.jobId).status).not.toBe("COMPLETE");
      } finally {
        await f.close();
      }
    });

test("six independent terminal checks remain responsive during slow audit and failed shutdown", async () => {
  const f = networkEngineFixture();
  const jobs = Array.from({ length: 6 }, (_, index) => f.add(`audit-${index}`).job);
  let failAudit: (reason: Error) => void = (_reason: Error) => undefined;
  let completeAudit: () => void = () => undefined;
  let releaseQuarantine: () => void = () => undefined;
  const auditBarrier = new Promise<void>((resolve, reject) => {
    completeAudit = resolve;
    failAudit = reject;
  });
  const quarantineBarrier = new Promise<void>((resolve) => {
    releaseQuarantine = resolve;
  });
  f.guard.audit = async (plan) => {
    if (plan.project === "tch-audit-0") await auditBarrier;
  };
  f.guard.quarantineAsync = async () => {
    await quarantineBarrier;
  };
  f.guard.stopOwned = async () => {
    throw new Error("Shutdown unconfirmed");
  };
  try {
    f.setNow(11_001);
    expect(jobs.map((job) => f.engine.terminalSupported(job))).toEqual(Array(6).fill(true));
    await Bun.sleep(5);
    for (let iteration = 0; iteration < 20; iteration++)
      expect(jobs.map((job) => f.engine.terminalSupported(job))).toEqual(Array(6).fill(true));
    failAudit(new Error("Delayed daemon audit failed"));
    await Bun.sleep(5);
    expect(f.engine.terminalSupported(requiredNetworkValue(jobs[0]))).toBe(false);
    expect(jobs.slice(1).every((job) => f.engine.terminalSupported(job))).toBe(true);
    expect(f.store.job(requiredNetworkValue(jobs[0]).jobId).status).toBe("FAILED");
    releaseQuarantine();
    await f.engine.drainNetworkChecks();
    expect(f.store.job(requiredNetworkValue(jobs[0]).jobId).status).toBe("FAILED");
  } finally {
    completeAudit();
    releaseQuarantine();
    await f.close();
  }
});

test("expired proofs revoke immediately while quarantine is pending", async () => {
  const f = networkEngineFixture();
  const { job } = f.add("expired-proof");
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.guard.audit = async () => {
    await barrier;
  };
  f.guard.quarantineAsync = async () => {
    await barrier;
  };
  try {
    f.setNow(61_002);
    expect(f.engine.terminalSupported(job)).toBe(false);
    expect(f.store.job(job.jobId).status).toBe("FAILED");
    release();
    await f.engine.drainNetworkChecks();
    expect(f.store.job(job.jobId).status).toBe("STOPPED");
  } finally {
    release();
    await f.close();
  }
});

test("publication admission closure cannot defer proof expiry revocation", async () => {
  const f = networkEngineFixture();
  const { job } = f.add("publication-proof-expiry");
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.guard.publishAsync = async () => {
    entered();
    await barrier;
  };
  f.guard.quarantineAsync = async () => {
    await barrier;
  };
  const apply = Reflect.get(f.engine, "applyPublications") as (
    event: string,
    changes: Map<string, Job>,
    disabled: Set<string>,
  ) => Promise<void>;
  const pending = apply.call(f.engine, "event", new Map(), new Set());
  try {
    await started;
    f.setNow(61_002);
    expect(f.engine.terminalSupported(job)).toBe(false);
    expect(f.store.job(job.jobId).status).toBe("FAILED");
    release();
    await pending;
    await f.engine.drainNetworkChecks();
    expect(f.engine.terminalSupported(job)).toBe(false);
    expect(f.store.job(job.jobId).status).toBe("STOPPED");
  } finally {
    release();
    await pending;
    await f.close();
  }
});

test("resume waits for an in-flight audit revocation before attempting admission", async () => {
  const f = networkEngineFixture();
  const { job } = f.add("halt-resume");
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.guard.audit = async () => {
    throw new Error("Audit drift");
  };
  f.guard.quarantineAsync = async () => {
    f.calls.push("quarantine");
    await barrier;
  };
  try {
    f.setNow(11_001);
    f.engine.terminalSupported(job);
    await Bun.sleep(5);
    f.calls.length = 0;
    const resumed = f.engine.resume({ ...job }).catch(() => undefined);
    await Bun.sleep(5);
    expect(f.calls).toEqual([]);
    release();
    await resumed;
    await f.engine.drainNetworkChecks();
    expect(f.calls[0]).toBe("stop-owned");
    expect(f.calls[1]).toBe("reset");
    expect(f.engine.terminalSupported(job)).toBe(false);
  } finally {
    release();
    await f.close();
  }
});

test("all publication budgets are validated before any runtime or ledger mutation", async () => {
  const f = networkEngineFixture();
  const jobs = Array.from({ length: 10 }, (_, index) => f.add(`budget-${index}`, 8).job);
  f.guard.endpoints = (plan, service, port) => {
    const segment = requiredNetworkValue(plan.segments[0]);
    const octets = segment.ipv4.split("/")[0]?.split(".") ?? [];
    octets[3] = String(Number(octets[3]) + 2);
    return [
      {
        segment,
        service,
        port,
        // eslint-disable-next-line sonarjs/no-hardcoded-ip -- pure synthetic endpoint; no network connection
        addresses: [octets.join("."), segment.ipv6.replace("::/64", "::2")],
      },
    ];
  };
  const before = f.store.jobs("event");
  f.calls.length = 0;
  try {
    const apply = Reflect.get(f.engine, "applyPublications") as (
      event: string,
      changes: Map<string, never>,
      disabled: Set<string>,
    ) => Promise<void>;
    await expect(
      apply.call(f.engine, "event", new Map<string, never>(), new Set()),
    ).rejects.toThrow("budget exceeded");
    expect(f.calls.every((call) => call === "audit")).toBe(true);
    expect(f.store.jobs("event")).toEqual(before);
    expect(jobs.every((job) => f.engine.terminalSupported(job))).toBe(true);
  } finally {
    await f.close();
  }
});

test("shared view drift quarantines the invalid peer and preserves healthy admission", async () => {
  const f = networkEngineFixture();
  const healthy = f.add("healthy-peer").job;
  const bad = f.add("bad-peer").job;
  f.guard.audit = async (plan) => {
    if (plan.project === "tch-bad-peer") throw new Error("Peer drift");
  };
  try {
    const view = Reflect.get(f.engine, "sharedPublicServices") as (context: {
      event: { eventId: string };
    }) => Promise<unknown>;
    await expect(view.call(f.engine, { event: { eventId: "event" } })).rejects.toThrow();
    expect(f.store.job(bad.jobId).status).toBe("STOPPED");
    expect(f.engine.terminalSupported(bad)).toBe(false);
    expect(f.engine.terminalSupported(healthy)).toBe(true);
    expect(f.calls).toContain("quarantine");
    expect(f.calls).toContain("stop-owned");
  } finally {
    await f.close();
  }
});

test("background proof expiry sweep never waits for queued native audits", async () => {
  const f = networkEngineFixture();
  const { job } = f.add("background-expiry");
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.guard.audit = async () => {
    await barrier;
  };
  f.guard.quarantineAsync = async () => {
    await barrier;
  };
  try {
    f.setNow(11_001);
    await f.engine.auditNetworks();
    expect(f.engine.terminalSupported(job)).toBe(true);
    f.setNow(61_002);
    await f.engine.auditNetworks();
    expect(f.engine.terminalSupported(job)).toBe(false);
    expect(f.store.job(job.jobId).status).toBe("FAILED");
  } finally {
    release();
    await f.close();
  }
});

test("failed quarantine and shutdown remain retryable after admission is revoked", async () => {
  const f = networkEngineFixture();
  const { job, unit } = f.add("retry-shutdown");
  let outage = true;
  f.guard.quarantineAsync = async () => {
    f.calls.push("quarantine");
    if (outage) throw new Error("Transient xtables failure");
  };
  f.guard.stopOwned = async () => {
    f.calls.push("stop-owned");
    if (outage) throw new Error("Transient Docker failure");
  };
  writeFileSync(unit.composePath, "untrusted replacement");
  try {
    await expect(f.engine.pause(job)).rejects.toThrow();
    expect(f.engine.terminalSupported(job)).toBe(false);
    expect(f.store.job(job.jobId).status).toBe("FAILED");
    await expect(f.engine.resume({ ...job })).rejects.toThrow("unconfirmed");
    f.calls.length = 0;
    outage = false;
    await f.engine.auditNetworks();
    await f.engine.drainNetworkChecks();
    expect(f.calls).toEqual(["quarantine", "retain", "stop-owned", "reset", "retain"]);
    expect(f.store.job(job.jobId).status).toBe("STOPPED");
    f.calls.length = 0;
    await f.engine.auditNetworks();
    await f.engine.drainNetworkChecks();
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const publication of [false, true])
  test(`SQLite failure cannot abort ${publication ? "publication" : "single-job"} quarantine or shutdown`, async () => {
    const f = networkEngineFixture();
    const { job, unit } = f.add(`persist-failure-${publication}`);
    if (publication) f.add("persist-other-peer");
    f.store.database.exec(
      "CREATE TRIGGER fail_guard_update BEFORE UPDATE ON host_jobs BEGIN SELECT RAISE(FAIL, 'Synthetic disk full'); END",
    );
    f.calls.length = 0;
    try {
      if (publication) {
        const apply = Reflect.get(f.engine, "applyPublications") as (
          event: string,
          changes: Map<string, never>,
          disabled: Set<string>,
        ) => Promise<void>;
        await expect(
          apply.call(f.engine, "event", new Map<string, never>(), new Set()),
        ).rejects.toThrow();
        expect(f.calls.filter((call) => call === "stop-owned")).toHaveLength(2);
        const firstStop = f.calls.indexOf("stop-owned");
        expect(
          f.calls.slice(0, firstStop).filter((call) => call === "quarantine").length,
        ).toBeGreaterThanOrEqual(2);
      } else {
        writeFileSync(unit.composePath, "untrusted replacement");
        await expect(f.engine.pause(job)).rejects.toThrow();
        expect(f.calls).toContain("stop-owned");
      }
      expect(f.calls).toContain("quarantine");
      expect(f.calls).toContain("reset");
      expect(f.calls.indexOf("quarantine")).toBeLessThan(f.calls.indexOf("stop-owned"));
      expect(f.engine.terminalSupported(job)).toBe(false);
    } finally {
      f.store.database.exec("DROP TRIGGER fail_guard_update");
      await f.close();
    }
  });

for (const demand of [false, true])
  test(`domain ${demand ? "on-demand" : "organizer"} stop preserves guard-confirmed STOPPED across recovery`, async () => {
    const f = networkEngineFixture();
    const { job, unit } = f.add(`domain-stop-${demand}`);
    const service = new HostingService(f.store, f.engine, "synthetic-host-key");
    job.operation = "stop";
    f.store.putJob(job);
    writeFileSync(unit.composePath, "untrusted replacement");
    try {
      const run = Reflect.get(service, demand ? "runDemandOperation" : "runJobOperation") as (
        id: string,
        operation: "stop",
      ) => Promise<void>;
      await run.call(service, job.jobId, "stop");
      const stopped = f.store.job(job.jobId);
      expect(stopped.status).toBe("STOPPED");
      expect(stopped.operation).toBeUndefined();
      expect(stopped.error).toContain("stopped");
      let recovered = false;
      f.engine.recover = async () => {
        recovered = true;
      };
      const recover = Reflect.get(service, "recoverJob") as (job: typeof stopped) => Promise<void>;
      await recover.call(service, stopped);
      expect(recovered).toBe(false);
      expect(f.store.job(job.jobId).status).toBe("STOPPED");
    } finally {
      await service.drain();
      await f.close();
    }
  });

test("publication-wide quarantine blocks recovery until every owned cleanup worker finishes", async () => {
  const f = networkEngineFixture();
  const { job } = f.add("publication-barrier");
  f.add("publication-other");
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.guard.update = () => {
    throw new Error("Partial publication failure");
  };
  f.guard.quarantineAsync = async (plan) => {
    f.calls.push("quarantine");
    if (plan.project === "tch-publication-barrier") await barrier;
  };
  const apply = Reflect.get(f.engine, "applyPublications") as (
    event: string,
    changes: Map<string, never>,
    disabled: Set<string>,
  ) => Promise<void>;
  const publication = apply
    .call(f.engine, "event", new Map<string, never>(), new Set())
    .catch(() => undefined);
  try {
    await Bun.sleep(5);
    expect(f.calls.filter((call) => call === "quarantine")).toHaveLength(2);
    f.calls.length = 0;
    const resume = f.engine.resume({ ...job }).catch(() => undefined);
    await f.engine.auditNetworks();
    await Bun.sleep(5);
    expect(f.calls).toEqual([]);
    release();
    await Promise.all([publication, resume]);
    await f.engine.drainNetworkChecks();
    expect(f.engine.terminalSupported(job)).toBe(false);
    expect(f.store.job(job.jobId).status).toBe("STOPPED");
  } finally {
    release();
    await publication;
    await f.close();
  }
});

test("a waiter follows publication replacement of an earlier per-job halt", async () => {
  const f = networkEngineFixture();
  const { job, unit } = f.add("replacement-waiter");
  let releaseFirst: () => void = () => undefined;
  let releaseBatch: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const batch = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  let quarantines = 0;
  f.guard.quarantineAsync = async () => {
    quarantines++;
    await (quarantines === 1 ? first : batch);
  };
  writeFileSync(unit.composePath, "untrusted replacement");
  const halt = f.engine.pause(job).catch(() => undefined);
  await Bun.sleep(5);
  const resume = f.engine.resume({ ...job }).catch(() => undefined);
  const plan = (
    Reflect.get(f.engine, "guardPlan") as (
      job: Job,
      unit: LocalComposeUnit,
    ) => import("../local-network").LocalNetworkPlan
  ).call(f.engine, job, unit);
  const stop = Reflect.get(f.engine, "stopFailedPublications") as (
    jobs: (typeof job)[],
    plans: Map<string, typeof plan>,
    error: Error,
  ) => Promise<never>;
  const cleanup = stop
    .call(f.engine, [{ ...job }], new Map([[job.jobId, plan]]), new Error("Publication failure"))
    .catch(() => undefined);
  try {
    releaseFirst();
    await halt;
    await Bun.sleep(5);
    expect(quarantines).toBe(2);
    expect(f.calls).not.toContain("install");
    releaseBatch();
    await Promise.all([cleanup, resume]);
    expect(f.engine.terminalSupported(job)).toBe(false);
  } finally {
    releaseFirst();
    releaseBatch();
    await Promise.all([halt, cleanup, resume]);
    await f.close();
  }
});

test("a failed VPN seal cannot abort owned bridge quarantine, shutdown or durable revocation", async () => {
  const f = networkEngineFixture();
  let failSeal = false;
  const plan = {
    version: 1 as const,
    interface: "tcwg0",
    serverPublicKey: "public-only-fixture",
    serverIpv4: "synthetic",
    serverIpv6: "synthetic",
    participantPort: 5175,
    peers: [],
    generation: "fixture",
  };
  f.engine.bindVpnIngress({
    plan,
    seal: () => {
      if (failSeal) throw new Error("Injected VPN seal failure");
    },
    validate: () => undefined,
    reconcile: async () => undefined,
    authorize: () => undefined,
  });
  const { job, admitted } = f.add("vpn-seal-failure");
  await admitted;
  f.guard.audit = async () => {
    throw new Error("Injected network drift");
  };
  failSeal = true;
  f.setNow(12_000);
  try {
    await f.engine.auditNetworks();
    await f.engine.drainNetworkChecks();
    expect(f.calls).toContain("quarantine");
    expect(f.calls).toContain("stop-owned");
    expect(["STOPPED", "FAILED"]).toContain(f.store.job(job.jobId).status);
    expect(f.engine.terminalSupported(f.store.job(job.jobId))).toBe(false);
    await expect(f.engine.closeTransports()).rejects.toThrow("Injected VPN seal failure");
  } finally {
    failSeal = false;
    await f.close();
  }
});

test("VPN budget rejection precedes publication mutation and preserves current runtimes", async () => {
  const f = networkEngineFixture();
  const plan = {
    version: 1 as const,
    interface: "tcwg0",
    serverPublicKey: "fixture",
    serverIpv4: "fixture",
    serverIpv6: "fixture",
    participantPort: 5175,
    peers: [],
    generation: "fixture",
  };
  f.engine.bindVpnIngress({
    plan,
    seal: () => undefined,
    validate: () => {
      throw new Error("VPN rule budget exceeded");
    },
    reconcile: async () => undefined,
    authorize: () => undefined,
  });
  const { job, admitted } = f.add("vpn-publication-budget");
  await admitted;
  const unit = f.store.job(job.jobId).unit;
  f.calls.length = 0;
  const apply = Reflect.get(f.engine, "applyPublications") as (
    event: string,
    changes: Map<string, Job>,
    disabled: Set<string>,
  ) => Promise<void>;
  try {
    await expect(apply.call(f.engine, "event", new Map(), new Set())).rejects.toThrow(
      "VPN rule budget exceeded",
    );
    expect(f.calls).not.toContain("update");
    expect(f.calls).not.toContain("route");
    expect(f.calls).not.toContain("retain");
    expect(f.calls).not.toContain("stop-owned");
    expect(f.store.job(job.jobId).unit).toBe(unit);
    expect(f.engine.terminalSupported(job)).toBe(true);
  } finally {
    await f.close();
  }
});
