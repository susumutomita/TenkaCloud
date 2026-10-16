import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartedContainer } from "../container/container-runner";
import type { Job } from "../model";
import { networkEngineFixture } from "./network-engine-fixture";

for (const phase of ["readiness", "verification", "admission"] as const)
  for (const fails of [false, true])
    test(`publication waits through recovery ${phase}, including ${fails ? "failure cleanup" : "final admission"}`, async () => {
      const f = networkEngineFixture();
      const alpha = f.add("alpha", 1);
      const beta = f.add("beta", 1);
      await Promise.all([alpha.admitted, beta.admitted]);
      const bin = mkdtempSync(join(tmpdir(), "tc-recovery-docker-fake-"));
      mkdirSync(join(bin, "bin"));
      writeFileSync(join(bin, "bin/docker"), "#!/bin/sh\necho synthetic-running-container\n", {
        mode: 0o700,
      });
      const oldPath = process.env.PATH;
      const oldCli = process.env.TENKACLOUD_COMPOSE_CLI;
      process.env.PATH = `${bin}/bin:${oldPath ?? ""}`;
      process.env.TENKACLOUD_COMPOSE_CLI = "docker compose";
      const entered = Promise.withResolvers<undefined>();
      const gate = Promise.withResolvers<undefined>();
      const pause = async () => {
        entered.resolve(undefined);
        await gate.promise;
        if (fails) throw new Error("Synthetic final recovery failure");
      };
      const originalPlan = Reflect.get(f.engine, "plan").bind(f.engine);
      Reflect.set(f.engine, "plan", (job: Job) => {
        const planned = originalPlan(job);
        planned.started.problem.verifyUrl = "data:text/plain,ready";
        return planned;
      });
      Reflect.set(f.engine, "openRelays", async () => undefined);
      Reflect.set(f.engine, "readySurfaces", phase === "readiness" ? pause : async () => undefined);
      let audits = 0;
      f.guard.audit = async () => {
        if (++audits === 2 && phase === "verification") await pause();
      };
      if (phase === "admission") {
        const admit = Reflect.get(f.engine, "admitRunning").bind(f.engine);
        Reflect.set(f.engine, "admitRunning", async (job: Job, started: StartedContainer) => {
          if (job.jobId === "alpha") await pause();
          await admit(job, started);
        });
      }
      const recovery = f.engine.recover({ ...f.store.job("alpha") });
      const result = recovery.catch((error: unknown) => error);
      let published = false;
      const reconcile = Reflect.get(f.engine, "reconcilePublications").bind(f.engine);
      let batch: Promise<void> | undefined;
      try {
        await entered.promise;
        batch = reconcile("event").then(() => {
          published = true;
        });
        await Bun.sleep(10);
        expect(published).toBe(false);
        expect(f.calls).not.toContain("update");
        gate.resolve(undefined);
        if (fails) {
          expect(await result).toBeInstanceOf(AggregateError);
          expect(f.store.job("alpha").status).toBe("STOPPED");
          expect(f.calls).toContain("stop-owned");
        } else {
          await expect(recovery).resolves.toBeUndefined();
          expect(f.engine.networkSupported(f.store.job("alpha"))).toBe(true);
        }
        await batch;
        expect(published).toBe(true);
        expect(f.calls).toContain("update");
      } finally {
        gate.resolve(undefined);
        await Promise.allSettled([result, batch]);
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldCli === undefined) delete process.env.TENKACLOUD_COMPOSE_CLI;
        else process.env.TENKACLOUD_COMPOSE_CLI = oldCli;
        rmSync(bin, { recursive: true, force: true });
        await f.close();
      }
    });
