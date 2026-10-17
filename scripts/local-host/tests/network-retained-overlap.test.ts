/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic host route inventory only; no native networking. */
import { expect, test } from "bun:test";
import { LinuxNetworkGuard } from "../linux-network-guard";
import { localNetworkPlan, requiredNetworkValue } from "../local-network";
import { networkEngineFixture } from "./network-engine-fixture";

for (const operation of ["resume", "recover"] as const)
  test(`${operation} refuses a retained subnet that a host route now covers, without reinstalling its guard`, async () => {
    const f = networkEngineFixture();
    const { job, admitted } = f.add(`overlap-${operation}`);
    await admitted;
    f.guard.occupiedRoutes = () => ["10.240.0.0/24"];
    try {
      await expect(f.engine[operation]({ ...job })).rejects.toThrow();
      expect(f.calls).not.toContain("install");
      expect(f.calls).toContain("stop-owned");
      const retained = f.store.job(job.jobId);
      expect(retained.status).toBe("STOPPED");
      expect(retained.error).toBe(
        "Competition network overlaps an existing host, LAN/VPN or runtime range. The runtime was stopped; remove the conflicting host route, then restart it.",
      );
      expect(f.engine.terminalSupported(retained)).toBe(false);
      f.guard.occupiedRoutes = () => [];
      await f.engine.resume(retained).catch(() => undefined);
      expect(f.calls).toContain("install");
    } finally {
      await f.close();
    }
  });

test("a publication batch waits for a recovering runtime's guard install before auditing it", async () => {
  const f = networkEngineFixture();
  const alpha = f.add("alpha");
  const beta = f.add("beta");
  await Promise.all([alpha.admitted, beta.admitted]);
  const install = Promise.withResolvers<undefined>();
  let installed = false;
  f.guard.installAsync = async () => {
    await install.promise;
    installed = true;
  };
  f.guard.audit = async (plan) => {
    f.calls.push(`audit-${plan.project}`);
    if (plan.project === "tch-alpha" && !installed) throw new Error("Synthetic absent chains");
  };
  const recovering = f.engine.recover({ ...f.store.job("alpha") }).catch(() => undefined);
  await Bun.sleep(10);
  f.calls.length = 0;
  const reconcile = Reflect.get(f.engine, "reconcilePublications") as (
    eventId: string,
  ) => Promise<void>;
  const batch = reconcile.call(f.engine, "event");
  try {
    await Bun.sleep(20);
    expect(f.calls).toEqual([]);
    install.resolve(undefined);
    await recovering;
    await expect(batch).resolves.toBeUndefined();
    expect(f.calls).toContain("audit-tch-beta");
  } finally {
    install.resolve(undefined);
    await Promise.allSettled([recovering, batch]);
    await f.close();
  }
});

test("only the routes a retained bridge's own addresses create are excluded", () => {
  const plan = localNetworkPlan(
    "tch-own-routes",
    { default: "10.240.0.16/28" },
    {
      composeText: "services:\n  web:\n    networks: [default]\n",
      definition: "own-routes",
      eventId: "event",
    },
  );
  const segment = requiredNetworkValue(plan.segments[0]);
  const network6 = segment.ipv6.replace("::/64", "::");
  const gateway6 = segment.ipv6.replace("::/64", "::1");
  const foreign6 = segment.ipv6.replace("::/64", "::99");
  const routes = {
    ipv4: [
      { dst: segment.ipv4, dev: segment.bridge, protocol: "kernel" },
      { type: "local", dst: "10.240.0.17", dev: segment.bridge, protocol: "kernel" },
      { type: "broadcast", dst: "10.240.0.31", dev: segment.bridge, protocol: "kernel" },
      // A foreign address or narrower prefix on the bridge claims workload addresses.
      { type: "local", dst: "10.240.0.20", dev: segment.bridge, protocol: "kernel" },
      { dst: "10.240.0.28/30", dev: segment.bridge, protocol: "kernel" },
      // Added while the runtime was retained: it reroutes part of the subnet, so it still counts.
      { dst: "10.240.0.24/29", gateway: "10.240.0.20", dev: segment.bridge, protocol: "static" },
      // Kernel routes on the bridge outside its subnet are not this runtime's to exclude.
      { dst: "10.240.0.0/24", dev: segment.bridge, protocol: "kernel" },
      { dst: "192.168.10.0/24", dev: "eth0", protocol: "kernel" },
      { dst: "default", gateway: "192.168.10.1", dev: "eth0" },
    ],
    ipv6: [
      { dst: segment.ipv6, dev: segment.bridge, protocol: "kernel", metric: 256 },
      // Docker adds its own on-link route to the whole IPv6 subnet, without a kernel protocol.
      { dst: segment.ipv6, dev: segment.bridge, metric: 1024 },
      { type: "local", dst: gateway6, dev: segment.bridge, protocol: "kernel" },
      { type: "anycast", dst: network6, dev: segment.bridge, protocol: "kernel" },
      { type: "local", dst: foreign6, dev: segment.bridge, protocol: "kernel" },
      { dst: "fe80::/64", dev: segment.bridge, protocol: "kernel" },
      { dst: "fd99::/64", dev: "tcwg0" },
    ],
  };
  const guard = new LinuxNetworkGuard({
    platform: "linux",
    read: () => "",
    exists: () => true,
    link: () => "net:[1]",
    run: ({ command, args }) => {
      if (command !== "ip") throw new Error(`Unexpected fake command ${command}`);
      return JSON.stringify(args.includes("-6") ? routes.ipv6 : routes.ipv4);
    },
  });
  expect(guard.occupiedRoutes(plan)).toEqual([
    "10.240.0.20/32",
    "10.240.0.28/30",
    "10.240.0.24/29",
    "10.240.0.0/24",
    "192.168.10.0/24",
    `${foreign6}/128`,
    "fe80::/64",
    "fd99::/64",
  ]);
  expect(guard.occupiedRoutes()).toEqual([
    segment.ipv4,
    "10.240.0.17/32",
    "10.240.0.31/32",
    "10.240.0.20/32",
    "10.240.0.28/30",
    "10.240.0.24/29",
    "10.240.0.0/24",
    "192.168.10.0/24",
    segment.ipv6,
    segment.ipv6,
    `${gateway6}/128`,
    `${network6}/128`,
    `${foreign6}/128`,
    "fe80::/64",
    "fd99::/64",
  ]);
});
