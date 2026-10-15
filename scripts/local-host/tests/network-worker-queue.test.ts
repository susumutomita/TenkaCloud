import { expect, test } from "bun:test";
import { localNetworkPlan } from "../local-network";
import { auditNetwork, emergencyNetwork, installNetwork } from "../network-audit";

// No native worker, daemon or firewall is invoked: exercise the production queue with injected I/O.
test("512 emergency operations stay bounded and progress independently of wedged audits", async () => {
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- pure queue plan; no connection
  const plan = localNetworkPlan("tch-queue-fixture", { default: "10.249.0.0/28" });
  let releaseAudit: () => void = () => undefined;
  const auditBarrier = new Promise<void>((resolve) => {
    releaseAudit = resolve;
  });
  const audits = [
    auditNetwork(plan, async () => auditBarrier),
    auditNetwork(plan, async () => auditBarrier),
  ];
  let active = 0,
    maximum = 0,
    completed = 0;
  const transport = async () => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await Bun.sleep(1);
      if (++completed % 17 === 0) throw new Error("Synthetic worker failure");
    } finally {
      active--;
    }
  };
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 512 }, () => emergencyNetwork(plan, "quarantine", transport)),
    );
    expect(completed).toBe(512);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(30);
    releaseAudit();
    await Promise.all(audits);
    await emergencyNetwork(plan, "reset", transport);
    expect(completed).toBe(513);
  } finally {
    releaseAudit();
    await Promise.all(audits);
  }
});

test("wedged Docker resets cannot occupy the quarantine-only queue", async () => {
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- pure transport plan; no connection
  const plan = localNetworkPlan("tch-reset-queue", { default: "10.249.0.0/28" });
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resets = [
    emergencyNetwork(plan, "reset", async () => barrier),
    emergencyNetwork(plan, "reset", async () => barrier),
  ];
  let dropped = false;
  try {
    await emergencyNetwork(plan, "quarantine", async () => {
      dropped = true;
    });
    expect(dropped).toBe(true);
  } finally {
    release();
    await Promise.all(resets);
  }
});

test("a guard install and a quarantine never interleave their hook insertions", async () => {
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- pure transport plan; no connection
  const plan = localNetworkPlan("tch-hook-order", { default: "10.249.0.0/28" });
  const events: string[] = [];
  const held = (name: string, gate: Promise<undefined>) => async () => {
    events.push(`${name}-start`);
    await gate;
    events.push(`${name}-end`);
  };
  const install = Promise.withResolvers<undefined>();
  const installing = installNetwork(plan, held("install", install.promise));
  const quarantine = emergencyNetwork(
    plan,
    "quarantine",
    held("quarantine", Promise.resolve(undefined)),
  );
  const audit = auditNetwork(plan, held("audit", Promise.resolve(undefined)));
  await Bun.sleep(5);
  expect(events).toEqual(["install-start", "audit-start", "audit-end"]);
  install.resolve(undefined);
  await Promise.all([installing, quarantine, audit]);
  expect(events.slice(3)).toEqual(["install-end", "quarantine-start", "quarantine-end"]);

  events.length = 0;
  const drops = Promise.withResolvers<undefined>();
  const quarantines = [
    emergencyNetwork(plan, "quarantine", held("first", drops.promise)),
    emergencyNetwork(plan, "quarantine", held("second", drops.promise)),
  ];
  const next = installNetwork(plan, held("install", Promise.resolve(undefined)));
  await Bun.sleep(5);
  expect(events).toEqual(["first-start", "second-start"]);
  drops.resolve(undefined);
  await Promise.all([...quarantines, next]);
  expect(events.slice(-2)).toEqual(["install-start", "install-end"]);
});
