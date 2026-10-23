/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic addresses are test data and are never contacted. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { LocalComposeUnit } from "../container/container-runner";
import { allocateNetworkSubnets } from "../docker-networks";
import type { LocalNetworkPlan } from "../local-network";
import { egressComposeSource, requiredNetworkValue } from "../local-network";
import type { Job } from "../model";
import { publishedComposePorts } from "../runtime-ports";
import { linuxNetworkGuardFixture } from "./linux-network-guard-fixture";
import { networkEngineFixture } from "./network-engine-fixture";

async function withSyntheticCompose(run: () => Promise<void>) {
  const bin = mkdtempSync(join(tmpdir(), "tc-egress-start-"));
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const path = process.env.PATH;
  const cli = process.env.TENKACLOUD_COMPOSE_CLI;
  process.env.PATH = `${bin}:${path ?? ""}`;
  process.env.TENKACLOUD_COMPOSE_CLI = "docker compose";
  try {
    await run();
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    if (cli === undefined) delete process.env.TENKACLOUD_COMPOSE_CLI;
    else process.env.TENKACLOUD_COMPOSE_CLI = cli;
    rmSync(bin, { recursive: true, force: true });
  }
}

function request(f: ReturnType<typeof networkEngineFixture>) {
  const definition = JSON.parse(requiredNetworkValue(f.engine.catalog()[0]).definition);
  return {
    id: "upstream",
    service: requiredNetworkValue(Object.keys(parse(definition.composeText).services)[0]),
    destination: "8.8.8.8",
    port: 443,
    purpose: "Synthetic upstream, never contacted",
  };
}
function planOf(f: ReturnType<typeof networkEngineFixture>, job: Job): LocalNetworkPlan {
  const plan = Reflect.get(f.engine, "guardPlan") as (
    job: Job,
    unit: LocalComposeUnit,
  ) => LocalNetworkPlan;
  return plan.call(f.engine, job, JSON.parse(requiredNetworkValue(job.unit)));
}

test("revocation updates running egress tuples immediately and leaves the owned network for cleanup", async () => {
  const f = networkEngineFixture();
  try {
    const { job, admitted } = f.add("egress-revoke", 0, 0, false, [request(f)]);
    await admitted;
    expect(planOf(f, job).egressRoutes).toHaveLength(1);
    expect(planOf(f, { ...job, eventId: "another-event" }).egressRoutes).toEqual([]);
    const updated: LocalNetworkPlan[] = [];
    f.guard.update = (plan, previous) => {
      expect(previous.egressRoutes).toHaveLength(1);
      updated.push(plan);
    };
    await f.engine.updateInternetAccess(
      job.eventId,
      job.problemId,
      () => f.grants.delete(job.eventId, job.problemId),
      "revoke",
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.egressRoutes).toEqual([]);
    expect(updated[0]?.egressSegments).toHaveLength(1);
    expect(f.engine.networkSupported(job)).toBe(true);
    expect(JSON.parse(requiredNetworkValue(job.unit)).egressRequestIds).toEqual(["upstream"]);
  } finally {
    await f.close();
  }
});

for (const phase of ["apply", "verify"] as const)
  test(`failed egress revocation ${phase} quarantines and halts instead of reporting success`, async () => {
    const f = networkEngineFixture();
    try {
      const { job, admitted } = f.add("egress-failure", 0, 0, false, [request(f)]);
      await admitted;
      const fail = () => {
        throw new Error(`synthetic egress ${phase} failure`);
      };
      if (phase === "apply") f.guard.update = fail;
      else f.guard.verifyNetworks = fail;
      await expect(
        f.engine.updateInternetAccess(job.eventId, job.problemId, () =>
          f.grants.delete(job.eventId, job.problemId),
        ),
      ).rejects.toThrow(`synthetic egress ${phase} failure`);
      expect(f.grants.get(job.eventId, job.problemId)).toBeUndefined();
      expect(f.calls).toContain("quarantine");
      expect(f.calls).toContain("stop-owned");
      expect(f.store.job(job.jobId).status).toBe("STOPPED");
      expect(f.engine.networkSupported(job)).toBe(false);
    } finally {
      await f.close();
    }
  });

for (const operation of ["resume", "recover"] as const)
  for (const condition of ["revoked", "different digest"] as const)
    test(`${operation} installs only DROP with ${condition} grant`, async () => {
      const f = networkEngineFixture();
      f.setUnitRunning(true);
      try {
        const { job, admitted } = f.add("egress-retained", 0, 0, false, [request(f)]);
        await admitted;
        const grant = requiredNetworkValue(f.grants.get(job.eventId, job.problemId));
        if (condition === "revoked") f.grants.delete(job.eventId, job.problemId);
        else f.grants.put({ ...grant, definitionDigest: "another-definition" });
        const installed: LocalNetworkPlan[] = [];
        f.guard.install = (plan) => {
          installed.push(plan);
        };
        const prepare = Reflect.get(f.engine, "plan").bind(f.engine);
        Reflect.set(
          f.engine,
          "plan",
          (job: Job, _verify = true, subnets?: Record<string, string>, claim = false) => {
            const planned = prepare(job, false, subnets, claim);
            planned.started.problem.verifyUrl = "data:text/plain,ready";
            return planned;
          },
        );
        Reflect.set(f.engine, "runCompose", async () => {
          return undefined;
        });
        Reflect.set(f.engine, "openRelays", async () => {
          return undefined;
        });
        Reflect.set(f.engine, "readySurfaces", async () => {
          return undefined;
        });
        await f.engine[operation]({ ...job });
        expect(installed).toHaveLength(1);
        expect(installed[0]?.egressRoutes).toEqual([]);
        expect(installed[0]?.egressSegments).toHaveLength(1);
        expect(f.engine.networkSupported(job)).toBe(true);
      } finally {
        await f.close();
      }
    });

for (const destination of ["8.8.8.8", "2606:4700:4700::1111"])
  test(`periodic live inventory failure halts applied egress for ${destination}`, async () => {
    const f = networkEngineFixture();
    try {
      const { job, admitted } = f.add("egress-audit", 0, 0, false, [
        { ...request(f), destination },
      ]);
      await admitted;
      f.guard.audit = async (plan) => {
        if (plan.egressRoutes.some((route) => route.address === destination))
          throw new Error("Internet destination overlaps a protected live route");
      };
      f.setNow(12_000);
      await f.engine.auditNetworks();
      await f.engine.drainNetworkChecks();
      expect(f.store.job(job.jobId).status).toBe("STOPPED");
      expect(f.calls).toContain("quarantine");
      expect(f.calls).toContain("stop-owned");
    } finally {
      await f.close();
    }
  });

test("native declarations remain default deny and later approval does not add a network to an existing unit", async () => {
  const f = networkEngineFixture();
  try {
    const entry = requiredNetworkValue(f.engine.catalog()[0]);
    const original = entry.definition;
    const definition = JSON.parse(original);
    definition.problem.internetAccess = [request(f)];
    definition.catalogSnapshot ??= { root: "/synthetic", digest: "synthetic-digest" };
    Object.assign(entry, { definition: JSON.stringify(definition) });
    const { job, admitted } = f.add("ungranted-declaration");
    Object.assign(entry, { definition: original });
    await admitted;
    expect(planOf(f, job).egressSegments).toEqual([]);
    expect(JSON.parse(requiredNetworkValue(job.unit)).egressRequestIds).toEqual([]);
    f.grants.put({
      eventId: job.eventId,
      problemId: job.problemId,
      definitionDigest: definition.catalogSnapshot.digest,
      requestIds: ["upstream"],
      grantedAt: "2026-10-16T00:00:00Z",
    });
    expect(planOf(f, job).egressSegments).toEqual([]);
    expect(planOf(f, job).egressRoutes).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const phase of ["settle", "previous plan"])
  test(`revocation deletes approval before ${phase} failure and subsequent admission has no egress accepts`, async () => {
    const f = networkEngineFixture();
    try {
      const { job, admitted } = f.add("egress-early-failure", 0, 0, false, [request(f)]);
      await admitted;
      const method = phase === "settle" ? "awaitEventSettled" : "guardPlan";
      const original = Reflect.get(f.engine, method);
      if (phase === "previous plan") Reflect.get(f.engine, "guardProofs").delete(job.jobId);
      Reflect.set(f.engine, method, () => {
        throw new Error(`Synthetic ${phase} failure.`);
      });
      const failure = await f.engine
        .updateInternetAccess(
          job.eventId,
          job.problemId,
          () => f.grants.delete(job.eventId, job.problemId),
          "revoke",
        )
        .catch((error: unknown) => error);
      expect(f.grants.get(job.eventId, job.problemId)).toBeUndefined();
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("Expected revocation failure");
      expect(failure.message).toBe(
        `Internet access approval was revoked. Affected environments were halted. Error: Synthetic ${phase} failure.`,
      );
      expect(f.store.job(job.jobId).status).toBe("STOPPED");
      Reflect.set(f.engine, method, original);
      expect(planOf(f, job).egressRoutes).toEqual([]);
      const prepare = Reflect.get(f.engine, "plan").bind(f.engine);
      const definition = JSON.parse(job.definition);
      Reflect.set(f.engine, "allocateNetworks", () =>
        allocateNetworkSubnets(definition.composeText, "10.240.0.0/24", []),
      );
      Reflect.set(
        f.engine,
        "plan",
        (next: Job, _verify: boolean, subnets: Record<string, string>) => {
          const prepared = prepare(next, false, subnets);
          prepared.started.problem.verifyUrl = "data:text/plain,ready";
          return prepared;
        },
      );
      for (const method of ["runCompose", "openRelays", "readySurfaces", "reconcilePublications"])
        Reflect.set(f.engine, method, async () => undefined);
      const installed: LocalNetworkPlan[] = [];
      f.guard.install = (plan) => {
        installed.push(plan);
      };
      Reflect.set(f.engine, "networkPool", "10.240.0.0/24");
      const next: Job = {
        ...job,
        jobId: `${job.jobId}-next`,
        runtimePorts: Object.fromEntries(
          publishedComposePorts(definition.composeText).map((port, index) => [
            String(port),
            30000 + index,
          ]),
        ),
        unit: null,
      };
      await withSyntheticCompose(() =>
        f.engine.start(next, (unit) => {
          next.unit = unit;
        }),
      );
      expect(installed).toHaveLength(1);
      expect(installed[0]?.egressRoutes).toEqual([]);
      expect(installed[0]?.egressSegments).toEqual([]);
    } finally {
      await f.close();
    }
  });

test("failed approval apply reports that the decision was saved and environments were halted", async () => {
  const f = networkEngineFixture();
  try {
    const { job, admitted } = f.add("egress-put-failure", 0, 0, false, [request(f)]);
    await admitted;
    const grant = requiredNetworkValue(f.grants.get(job.eventId, job.problemId));
    f.guard.update = () => {
      throw new Error("Synthetic approval apply failure.");
    };
    await expect(
      f.engine.updateInternetAccess(job.eventId, job.problemId, () => f.grants.put(grant)),
    ).rejects.toThrow(
      "Internet access approval was saved. Affected environments were halted. Error: Synthetic approval apply failure.",
    );
    expect(f.grants.get(job.eventId, job.problemId)).toEqual(grant);
  } finally {
    await f.close();
  }
});

test("revocation reports when affected environments could not be halted", async () => {
  const f = networkEngineFixture();
  try {
    const { job, admitted } = f.add("egress-halt-failure", 0, 0, false, [request(f)]);
    await admitted;
    f.guard.update = () => {
      throw new Error("Synthetic apply failure.");
    };
    f.guard.stopOwned = async () => {
      throw new Error("Synthetic shutdown failure.");
    };
    await expect(
      f.engine.updateInternetAccess(
        job.eventId,
        job.problemId,
        () => f.grants.delete(job.eventId, job.problemId),
        "revoke",
      ),
    ).rejects.toThrow(
      "Internet access approval was revoked. Some affected environments could not be halted; quarantine and shutdown were attempted. Check the host before retrying. Error: Synthetic apply failure.",
    );
    expect(f.grants.get(job.eventId, job.problemId)).toBeUndefined();
    expect(f.engine.networkSupported(job)).toBe(false);
  } finally {
    await f.close();
  }
});

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError)
    return [error.message, ...error.errors.flatMap(errorMessages)];
  return error instanceof Error ? [error.message] : [];
}

function freshStart(f: ReturnType<typeof networkEngineFixture>, seed: Job, composeText?: string) {
  const definition = JSON.parse(seed.definition);
  if (composeText) definition.composeText = composeText;
  const next: Job = {
    ...seed,
    jobId: `${seed.jobId}-fresh`,
    teamId: `${seed.teamId}-fresh`,
    definition: JSON.stringify(definition),
    unit: null,
    runtimePorts: Object.fromEntries(
      publishedComposePorts(definition.composeText).map((port, index) => [
        String(port),
        31000 + index,
      ]),
    ),
  };
  const prepare = Reflect.get(f.engine, "plan").bind(f.engine);
  Reflect.set(f.engine, "allocateNetworks", (job: Job) => {
    const definition = JSON.parse(job.definition);
    return allocateNetworkSubnets(
      egressComposeSource(definition.composeText, [request(f).service]),
      "10.240.1.0/24",
      [],
    );
  });
  Reflect.set(
    f.engine,
    "plan",
    (job: Job, _verify: boolean, subnets?: Record<string, string>, claim = false) => {
      const prepared = prepare(job, false, subnets, claim);
      prepared.started.problem.verifyUrl = "data:text/plain,ready";
      return prepared;
    },
  );
  for (const method of ["openRelays", "readySurfaces", "reconcilePublications"])
    Reflect.set(f.engine, method, async () => undefined);
  Reflect.set(f.engine, "networkPool", "10.240.1.0/24");
  f.store.putTeam({
    ...f.store.team(seed.teamId),
    teamId: next.teamId,
    internalSlug: next.teamId,
    loginKey: `synthetic-${next.teamId}`,
  });
  f.store.putJob(next);
  return {
    next,
    start: () =>
      f.engine.start(next, (unit) => {
        next.unit = unit;
        f.store.putJob(next);
      }),
  };
}

for (const phase of ["install", "before admission"] as const)
  test(`revocation waits for a fresh start at ${phase} and refuses stale admission`, async () => {
    await withSyntheticCompose(async () => {
      const f = networkEngineFixture();
      const { promise: gate, resolve: release } = Promise.withResolvers<undefined>();
      try {
        const { job, admitted } = f.add("egress-racing", 0, 0, false, [request(f)]);
        await admitted;
        const { next, start } = freshStart(f, job);
        const { promise: waiting, resolve: entered } = Promise.withResolvers<undefined>();
        const installed: LocalNetworkPlan[] = [];
        f.guard.installAsync = async (plan) => {
          installed.push(plan);
          if (phase === "install") {
            entered(undefined);
            await gate;
          }
        };
        if (phase === "before admission")
          Reflect.set(f.engine, "readySurfaces", async () => {
            entered(undefined);
            await gate;
          });
        const compose: string[] = [];
        Reflect.set(f.engine, "runCompose", async (_unit: LocalComposeUnit, action: string) => {
          compose.push(action);
        });
        const started = start().then(
          () => null,
          (error: unknown) => error,
        );
        await waiting;
        let revoked = false;
        const revocation = f.engine
          .updateInternetAccess(
            job.eventId,
            job.problemId,
            () => f.grants.delete(job.eventId, job.problemId),
            "revoke",
          )
          .then(() => {
            revoked = true;
          });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const returnedBeforeStartSettled = revoked;
        release(undefined);
        const error = await started;
        await revocation;
        expect(returnedBeforeStartSettled).toBe(false);
        expect(error).toMatchObject({
          status: 409,
          message: "Competition network policy is changing",
        });
        expect(installed[0]?.egressRoutes).toHaveLength(1);
        expect(f.engine.networkSupported(next)).toBe(false);
        expect(f.engine.networkSupported(job)).toBe(true);
        expect(planOf(f, job).egressRoutes).toEqual([]);
        expect(f.grants.get(job.eventId, job.problemId)).toBeUndefined();
        expect(next.unit).toBeNull();
        expect(compose).toEqual(phase === "install" ? ["down"] : ["up", "down"]);
      } finally {
        release(undefined);
        await f.close();
      }
    });
  });

test("revocation during running admission releases publication waiters and proves zero egress", async () => {
  await withSyntheticCompose(async () => {
    const f = networkEngineFixture();
    const { promise: gate, resolve: release } = Promise.withResolvers<undefined>();
    try {
      const { job, admitted } = f.add("egress-admitting", 0, 0, false, [request(f)]);
      await admitted;
      const { next, start } = freshStart(f, job);
      const { promise: waiting, resolve: entered } = Promise.withResolvers<undefined>();
      const admit = Reflect.get(f.engine, "admitRunning").bind(f.engine);
      Reflect.set(f.engine, "admitRunning", async (job: Job, started: unknown) => {
        await admit(job, started);
        if (job.jobId === next.jobId) {
          entered(undefined);
          await gate;
        }
      });
      const installed: LocalNetworkPlan[] = [];
      f.guard.install = (plan) => {
        installed.push(plan);
      };
      f.guard.update = (plan) => {
        installed.push(plan);
      };
      Reflect.set(f.engine, "runCompose", async () => undefined);
      Reflect.set(f.engine, "reconcilePublications", async () => {
        await Reflect.get(f.engine, "publicMutation");
      });
      const started = start();
      await waiting;
      const revoked = f.engine.updateInternetAccess(
        job.eventId,
        job.problemId,
        () => f.grants.delete(job.eventId, job.problemId),
        "revoke",
      );
      release(undefined);
      await Promise.all([started, revoked]);
      expect(f.engine.networkSupported(next)).toBe(true);
      const proof = Reflect.get(f.engine, "guardProofs").get(next.jobId);
      expect(proof.plan.egressRoutes).toEqual([]);
      expect(installed.at(-1)).toEqual(proof.plan);
    } finally {
      release(undefined);
      await f.close();
    }
  });
});

for (const phase of ["install", "before admission"])
  test(`fresh start rederives egress routes at ${phase} even without an epoch bump`, async () => {
    await withSyntheticCompose(async () => {
      const f = networkEngineFixture();
      try {
        const { job, admitted } = f.add("egress-rederive", 0, 0, false, [request(f)]);
        await admitted;
        const { next, start } = freshStart(f, job);
        const changeGrant = async () => {
          f.grants.delete(job.eventId, job.problemId);
        };
        if (phase === "install") f.guard.installAsync = changeGrant;
        else Reflect.set(f.engine, "readySurfaces", changeGrant);
        const compose: string[] = [];
        Reflect.set(f.engine, "runCompose", async (_unit: LocalComposeUnit, action: string) => {
          compose.push(action);
        });
        await expect(start()).rejects.toThrow("Competition network policy is changing");
        expect(f.engine.networkSupported(next)).toBe(false);
        expect(compose).toEqual(phase === "install" ? ["down"] : ["up", "down"]);
      } finally {
        await f.close();
      }
    });
  });

for (const phase of ["install", "before admission"])
  test(`a DMZ publication epoch change at ${phase} does not refuse an unchanged fresh start`, async () => {
    await withSyntheticCompose(async () => {
      const f = networkEngineFixture();
      try {
        const { job, admitted } = f.add("egress-epoch", 0, 0, false, [request(f)]);
        await admitted;
        const { next, start } = freshStart(f, job);
        const publish = async () => {
          const epochs: Map<string, number> = Reflect.get(f.engine, "policyEpochs");
          epochs.set(job.eventId, (epochs.get(job.eventId) ?? 0) + 1);
        };
        if (phase === "install") f.guard.installAsync = publish;
        else Reflect.set(f.engine, "readySurfaces", publish);
        Reflect.set(f.engine, "runCompose", async () => undefined);
        await start();
        expect(f.engine.networkSupported(next)).toBe(true);
        expect(Reflect.get(f.engine, "guardProofs").get(next.jobId).plan.egressRoutes).toHaveLength(
          1,
        );
      } finally {
        await f.close();
      }
    });
  });

test("revocation deletes the grant immediately while another event publication is pending", async () => {
  const f = networkEngineFixture();
  const { promise: pending, resolve: release } = Promise.withResolvers<undefined>();
  try {
    const { job, admitted } = f.add("egress-queued", 0, 0, false, [request(f)]);
    await admitted;
    Reflect.set(f.engine, "publicMutation", pending);
    const revocation = f.engine.updateInternetAccess(
      job.eventId,
      job.problemId,
      () => f.grants.delete(job.eventId, job.problemId),
      "revoke",
    );
    const grantWhileQueued = f.grants.get(job.eventId, job.problemId);
    release(undefined);
    await revocation;
    expect(grantWhileQueued).toBeUndefined();
  } finally {
    release(undefined);
    await f.close();
  }
});

for (const broken of [false, true])
  test(`Internet availability and approval both read Docker bridge host none inventory${broken ? " and refuse malformed Config" : ""}`, async () => {
    const f = networkEngineFixture();
    try {
      const inventory = linuxNetworkGuardFixture();
      inventory.settings.defaultNetworks = true;
      if (broken) inventory.settings.defaultConfig = {};
      f.guard.assertInternetTargets = (addresses) =>
        inventory.guard.assertInternetTargets(addresses);
      expect(f.engine.internetAccessAvailability().available).toBe(!broken);
      if (broken)
        expect(() => f.engine.checkInternetAccess(["8.8.8.8"])).toThrow(
          "Invalid Docker subnet inventory",
        );
      else expect(() => f.engine.checkInternetAccess(["8.8.8.8"])).not.toThrow();
      expect(
        inventory.calls.filter((call) => call.args[0] === "network" && call.args[1] === "inspect"),
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

for (const alias of ["networks object", "whole service", "alias chain"])
  for (const operation of ["start", "resume", "recover"] as const)
    test(`${operation} refuses ${alias} before Compose when egress is granted`, async () => {
      await withSyntheticCompose(async () => {
        const f = networkEngineFixture();
        try {
          const { job, admitted } = f.add("egress-alias", 0, 0, false, [request(f)]);
          await admitted;
          const name = request(f).service;
          const authoredForms: Record<string, string> = {
            "networks object": `services:\n  ${name}: {image: synthetic, networks: &n {default: {}}}\n  evil: {image: synthetic, networks: *n}\n`,
            "whole service": `services:\n  ${name}: &s {image: synthetic}\n  evil: *s\n`,
            "alias chain": `x-networks: &n {default: {}}\nx-base: &b {image: synthetic, networks: *n}\nservices:\n  ${name}: {<<: *b}\n  evil: {<<: *b}\n`,
          };
          const authored = requiredNetworkValue(authoredForms[alias]);
          const { next, start } = freshStart(f, job, authored);
          const compose: string[] = [];
          Reflect.set(f.engine, "runCompose", async (_unit: LocalComposeUnit, action: string) => {
            compose.push(action);
          });
          if (operation !== "start") {
            next.unit = job.unit;
            next.jobId = job.jobId;
            next.teamId = job.teamId;
          }
          const failure = await (operation === "start" ? start() : f.engine[operation](next)).then(
            () => null,
            (error: unknown) => error,
          );
          expect(compose).toEqual([]);
          expect(errorMessages(failure).some((message) => message.includes("YAML aliases"))).toBe(
            true,
          );
          expect(f.engine.networkSupported(next)).toBe(false);
        } finally {
          await f.close();
        }
      });
    });

/* eslint-enable sonarjs/no-hardcoded-ip */
