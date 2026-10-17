/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic addresses are test data and are never contacted. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { LocalComposeUnit } from "../container/container-runner";
import { allocateNetworkSubnets } from "../docker-networks";
import type { LocalNetworkPlan } from "../local-network";
import { requiredNetworkValue } from "../local-network";
import type { Job } from "../model";
import { publishedComposePorts } from "../runtime-ports";
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
      const bin = mkdtempSync(join(tmpdir(), "tc-egress-recovery-"));
      mkdirSync(join(bin, "bin"));
      writeFileSync(join(bin, "bin/docker"), "#!/bin/sh\necho synthetic-running-container\n", {
        mode: 0o700,
      });
      const oldPath = process.env.PATH;
      const oldCli = process.env.TENKACLOUD_COMPOSE_CLI;
      process.env.PATH = `${bin}/bin:${oldPath ?? ""}`;
      process.env.TENKACLOUD_COMPOSE_CLI = "docker compose";
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
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldCli === undefined) delete process.env.TENKACLOUD_COMPOSE_CLI;
        else process.env.TENKACLOUD_COMPOSE_CLI = oldCli;
        rmSync(bin, { recursive: true, force: true });
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

/* eslint-enable sonarjs/no-hardcoded-ip */
