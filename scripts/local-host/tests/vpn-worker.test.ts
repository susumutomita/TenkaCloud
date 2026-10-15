import { expect, test } from "bun:test";
import { NativeVpnIngress } from "../vpn/native-ingress";
import type { VpnPeerProof } from "../vpn/peer-admission";
import type { VpnPeerPlan } from "../vpn/peer-plan";

// Controller scheduling only; fake backend never runs a native command.
const plan: VpnPeerPlan = {
  version: 1,
  interface: "tcwg0",
  serverPublicKey: "public-fixture",
  serverIpv4: "fixture",
  serverIpv6: "fixture",
  participantPort: 5175,
  peers: [],
  generation: "generation",
};
function fixture() {
  let release: (proof: VpnPeerProof) => void = (proof) => {
    throw new Error(`Missing stage for ${proof.generation}`);
  };
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const commits: VpnPeerProof[] = [];
  let closed = true;
  const ingress = new NativeVpnIngress(
    plan,
    async () =>
      new Promise<VpnPeerProof>((resolve) => {
        release = resolve;
        enter();
      }),
    {
      seal: () => {
        closed = true;
      },
      suspend: () => {
        closed = true;
      },
      commit: (proof) => {
        commits.push(proof);
        closed = false;
      },
      authorize: () => {
        if (closed) throw new Error("Closed");
      },
    },
  );
  return {
    ingress,
    entered,
    commits,
    release: () => {
      const proof: VpnPeerProof = { generation: plan.generation, verifiedAt: 1000 };
      release(proof);
    },
    closed: () => closed,
  };
}
test("VPN worker staging leaves the event loop responsive and only opens after preparation", async () => {
  const f = fixture();
  const task = f.ingress.reconcile([]);
  await f.entered;
  let heartbeat = false;
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      heartbeat = true;
      resolve();
    }, 0),
  );
  expect(heartbeat).toBe(true);
  expect(f.closed()).toBe(true);
  expect(f.commits).toHaveLength(0);
  f.release();
  await task;
  expect(f.commits).toHaveLength(1);
  expect(f.closed()).toBe(false);
});
test("revocation during worker preparation cannot reopen stale policy", async () => {
  const f = fixture();
  const task = f.ingress.reconcile([]);
  const rejected = task.catch((error: unknown) => error);
  await f.entered;
  f.ingress.seal();
  f.release();
  expect(String(await rejected)).toContain("revoked during");
  expect(f.closed()).toBe(true);
  expect(f.commits).toHaveLength(0);
});
test("new snapshots coalesce and callers follow the latest preparation without reopening old policy", async () => {
  const f = fixture();
  const one = f.ingress.reconcile([]);
  await f.entered;
  const two = f.ingress.reconcile([]);
  const three = f.ingress.reconcile([]);
  expect(f.closed()).toBe(true);
  f.release();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(f.commits).toHaveLength(0);
  f.release();
  await Promise.all([one, two, three]);
  expect(f.commits).toHaveLength(1);
  expect(f.closed()).toBe(false);
});

test("reconcile arriving at commit completion waits for the next desired policy", async () => {
  let release: (proof: VpnPeerProof) => void = (proof) => {
    throw new Error(`Missing native stage for ${proof.generation}`);
  };
  let second: Promise<void> | undefined;
  let commits = 0;
  let stageCalls = 0;
  let closed = true;
  const ingress = new NativeVpnIngress(
    plan,
    () =>
      new Promise<VpnPeerProof>((resolve) => {
        release = resolve;
        stageCalls++;
      }),
    {
      seal: () => {
        closed = true;
      },
      suspend: () => {
        closed = true;
      },
      commit: () => {
        commits++;
        closed = false;
        if (commits === 1)
          queueMicrotask(() => {
            second = ingress.reconcile([]);
          });
      },
      authorize: () => undefined,
    },
  );
  const first = ingress.reconcile([]);
  release({ generation: plan.generation, verifiedAt: 1000 });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(stageCalls).toBe(2);
  expect(closed).toBe(true);
  release({ generation: plan.generation, verifiedAt: 1000 });
  await Promise.all([first, second]);
  expect(commits).toBe(2);
  expect(closed).toBe(false);
});

test("commit failure invokes hard identity revocation before reporting failure", async () => {
  let hardSeals = 0;
  let closed = false;
  const ingress = new NativeVpnIngress(
    plan,
    async () => ({ generation: plan.generation, verifiedAt: 1000 }),
    {
      suspend: () => {
        closed = true;
      },
      seal: () => {
        hardSeals++;
        closed = true;
      },
      commit: () => {
        closed = false;
        throw new Error("Injected partial commit");
      },
      authorize: () => {
        if (closed) throw new Error("Closed");
      },
    },
  );
  await expect(ingress.reconcile([])).rejects.toThrow("Injected partial commit");
  expect(hardSeals).toBe(1);
  expect(closed).toBe(true);
  expect(() => ingress.authorize("fixture", { eventId: "event", teamId: "team" })).toThrow();
});
