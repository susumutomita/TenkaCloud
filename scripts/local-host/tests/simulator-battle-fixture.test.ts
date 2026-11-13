import { expect, test } from "bun:test";
import { withManagedBattleFixture } from "../integration/simulator-battle-fixture";

const battle = {
  binarySha256: "a".repeat(64),
  runtimeConfigPath: "/private/config.json",
  runtimeConfigSha256: "b".repeat(64),
};
const settings = {
  endpoint: "http://127.0.0.1:43210",
  tokenFile: "/private/token",
  region: "ap-northeast-1",
  bootstrap: true,
};
const clock = {
  domain: "unit-test-only",
  authenticateResponse() {
    throw new Error("not invoked");
  },
  authenticateSample() {
    throw new Error("not invoked");
  },
};
const options = () => ({
  binary: "/private/simulator",
  battle,
  signal: new AbortController().signal,
});
test("fresh fixture passes pinned settings to session without pretending Host readiness", async () => {
  const o = options();
  let created = 0;
  let ran = 0;
  let inspected = false;
  const result = await withManagedBattleFixture(
    o,
    async (f) => {
      expect(inspected).toBe(true);
      ran++;
      expect(f.clock).toBe(clock);
      expect(f.settings).toBe(settings);
      expect(f.battleAcceptancePassed).toBe(false);
      expect(f.status).toBe("runtime-session-only-unqualified");
    },
    {
      inspect: async (actual, actualClock) => {
        expect(actual).toBe(settings);
        expect(actualClock).toBe(clock);
        inspected = true;
        return {
          kind: "authenticated-battle-availability",
          configured: true,
          scoringQualified: false,
          battleAcceptancePassed: false,
        };
      },
      createDirectory: () => {
        created++;
        return "/private/fresh";
      },
      session: async (actual, signal, run) => {
        expect(actual).toEqual({
          dataDirectory: "/private/fresh",
          managedSimulator: { binary: o.binary, battle },
        });
        await run(settings, signal, clock);
      },
    },
  );
  expect(created).toBe(1);
  expect(ran).toBe(1);
  expect(result.physicalCleanupVerified).toBe(false);
});
for (const missing of ["clock", "settings"])
  test(`missing ${missing} blocks user callback`, async () => {
    let ran = false;
    await expect(
      withManagedBattleFixture(
        options(),
        async () => {
          ran = true;
        },
        {
          createDirectory: () => "/private/fresh",
          session: async (_o, signal, run) => {
            await run(
              missing === "settings" ? undefined : settings,
              signal,
              missing === "clock" ? undefined : clock,
            );
          },
        },
      ),
    ).rejects.toThrow("evidence missing");
    expect(ran).toBe(false);
  });
test("runtime launch failure propagates with no fallback", async () => {
  await expect(
    withManagedBattleFixture(
      options(),
      async () => {
        throw new Error("must not run");
      },
      {
        createDirectory: () => "/private/fresh",
        session: async () => {
          throw new Error("missing pinned bundle");
        },
      },
    ),
  ).rejects.toThrow("missing pinned bundle");
});
test("cancelled or incomplete input never creates fixture", async () => {
  const o = options();
  const control = new AbortController();
  control.abort();
  const deps = {
    createDirectory: () => {
      throw new Error("must not create");
    },
  };
  await expect(
    withManagedBattleFixture(
      { ...o, signal: control.signal },
      async () => {
        throw new Error("must not run");
      },
      deps,
    ),
  ).rejects.toThrow();
  await expect(
    withManagedBattleFixture(
      { ...o, binary: "" },
      async () => {
        throw new Error("must not run");
      },
      deps,
    ),
  ).rejects.toThrow("explicit binary");
});

test("failed authenticated availability blocks callback and drains injected session", async () => {
  let ran = false;
  let cleaned = false;
  await expect(
    withManagedBattleFixture(
      options(),
      async () => {
        ran = true;
      },
      {
        createDirectory: () => "/private/fresh",
        inspect: async () => {
          throw new Error("availability missing or signature invalid");
        },
        session: async (_o, signal, run) => {
          try {
            await run(settings, signal, clock);
          } finally {
            cleaned = true;
          }
        },
      },
    ),
  ).rejects.toThrow("availability missing");
  expect(ran).toBe(false);
  expect(cleaned).toBe(true);
});

const probeOwner = {
  eventId: "event",
  teamId: "team",
  jobId: "job",
  unitHash: "a".repeat(64),
  deployedAt: 1700000000000,
  stackId: "stack",
  instanceId: "i-one",
};
const probeResult = {
  snapshot: {
    version: 2 as const,
    clockDomain: "unit-test-only",
    key: "1".repeat(32),
    binding: {
      owner: "a".repeat(64),
      deployment: "b".repeat(64),
      lease: "c".repeat(64),
      backendIncarnation: "d".repeat(64),
    },
    service: { name: "api", port: 8080, path: "/healthz" as const },
    startedAtMs: 100,
    deadlineMs: 200,
    resultReady: false,
    settled: false,
  },
  scoringQualified: false as const,
  battleAcceptancePassed: false as const,
};
type FixtureDependencies = NonNullable<Parameters<typeof withManagedBattleFixture>[2]>;
function probeFixture(prepare: NonNullable<FixtureDependencies["prepare"]>) {
  const control = new AbortController();
  let cleaned = false;
  const run = (callback: Parameters<typeof withManagedBattleFixture>[1]) =>
    withManagedBattleFixture({ ...options(), signal: control.signal }, callback, {
      prepare,
      createDirectory: () => "/private/fresh",
      inspect: async () => ({
        kind: "authenticated-battle-availability",
        configured: true,
        scoringQualified: false,
        battleAcceptancePassed: false,
      }),
      session: async (_options, signal, callback) => {
        try {
          await callback(settings, signal, clock);
        } finally {
          cleaned = true;
        }
      },
    });
  return { control, run, cleaned: () => cleaned };
}
function operation(start = async () => probeResult, read = async () => probeResult) {
  return Object.freeze({
    key: "1".repeat(32),
    deadline: Object.freeze({ domain: clock.domain, ticksMs: 200 }),
    start,
    read,
  });
}
test("fixture binds prepare/start/read to its owned settings and clock without qualification", async () => {
  const calls: string[] = [];
  const raw = operation(
    async () => {
      calls.push("start");
      return probeResult;
    },
    async () => {
      calls.push("read");
      return probeResult;
    },
  );
  const f = probeFixture(async (actualSettings, actualClock, owner, slot, budget) => {
    expect(actualSettings).toBe(settings);
    expect(actualClock).toBe(clock);
    expect(owner).toBe(probeOwner);
    expect(slot).toBe("api");
    expect(budget).toBe(777);
    calls.push("prepare");
    return raw;
  });
  const completed = await f.run(async (fixture) => {
    const probe = await fixture.prepareProbe(probeOwner, "api", 777);
    expect(probe.key).toBe(raw.key);
    expect(probe.deadline).toBe(raw.deadline);
    expect(await probe.start()).toBe(probeResult);
    expect(await probe.read()).toBe(probeResult);
    expect(fixture.battleAcceptancePassed).toBe(false);
  });
  expect(calls).toEqual(["prepare", "start", "read"]);
  expect(completed.battleAcceptancePassed).toBe(false);
  expect(completed.physicalCleanupVerified).toBe(false);
  expect(f.cleaned()).toBe(true);
});
for (const stage of ["prepare", "start", "read"] as const) {
  test(`abort before ${stage} prevents its underlying operation and session drains`, async () => {
    const calls: string[] = [];
    const f = probeFixture(async () => {
      calls.push("prepare");
      return operation(
        async () => {
          calls.push("start");
          return probeResult;
        },
        async () => {
          calls.push("read");
          return probeResult;
        },
      );
    });
    await expect(
      f.run(async (fixture) => {
        if (stage === "prepare") {
          f.control.abort(new Error("fixture cancelled"));
          await fixture.prepareProbe(probeOwner, "frontend", 100);
        } else {
          const probe = await fixture.prepareProbe(probeOwner, "frontend", 100);
          if (stage === "read") await probe.start();
          f.control.abort(new Error("fixture cancelled"));
          await probe[stage]();
        }
      }),
    ).rejects.toThrow("fixture cancelled");
    const expectedCalls = { prepare: [], start: ["prepare"], read: ["prepare", "start"] };
    expect(calls).toEqual(expectedCalls[stage]);
    expect(f.cleaned()).toBe(true);
  });
  test(`abort during ${stage} rejects the late success and session drains`, async () => {
    const f = probeFixture(async () => {
      if (stage === "prepare") f.control.abort(new Error("fixture cancelled"));
      return operation(
        async () => {
          if (stage === "start") f.control.abort(new Error("fixture cancelled"));
          return probeResult;
        },
        async () => {
          if (stage === "read") f.control.abort(new Error("fixture cancelled"));
          return probeResult;
        },
      );
    });
    await expect(
      f.run(async (fixture) => {
        const probe = await fixture.prepareProbe(probeOwner, "frontend", 100);
        await probe.start();
        await probe.read();
      }),
    ).rejects.toThrow("fixture cancelled");
    expect(f.cleaned()).toBe(true);
  });
  test(`${stage} failure is not swallowed or translated to healthy`, async () => {
    const failure = new Error(`${stage} signature or unknown outcome`);
    const f = probeFixture(async () => {
      if (stage === "prepare") throw failure;
      return operation(
        async () => {
          if (stage === "start") throw failure;
          return probeResult;
        },
        async () => {
          if (stage === "read") throw failure;
          return probeResult;
        },
      );
    });
    await expect(
      f.run(async (fixture) => {
        const probe = await fixture.prepareProbe(probeOwner, "frontend", 100);
        await probe.start();
        await probe.read();
      }),
    ).rejects.toBe(failure);
    expect(f.cleaned()).toBe(true);
  });
}
test("callback abort cannot yield a successful fixture result without any probe", async () => {
  const f = probeFixture(async () => operation());
  await expect(
    f.run(async () => {
      f.control.abort(new Error("callback cancelled"));
    }),
  ).rejects.toThrow("callback cancelled");
  expect(f.cleaned()).toBe(true);
});
test("escaped probe and prepare handles cannot be used after callback lifetime", async () => {
  const f = probeFixture(async () => operation());
  let laterStart: (() => Promise<unknown>) | undefined;
  let laterPrepare: (() => Promise<unknown>) | undefined;
  await f.run(async (fixture) => {
    const probe = await fixture.prepareProbe(probeOwner, "frontend", 100);
    laterStart = () => probe.start();
    laterPrepare = () => fixture.prepareProbe(probeOwner, "frontend", 100);
  });
  if (!laterStart || !laterPrepare) throw new Error("missing captured callback");
  await expect(laterStart()).rejects.toThrow("callback has ended");
  await expect(laterPrepare()).rejects.toThrow("callback has ended");
});
