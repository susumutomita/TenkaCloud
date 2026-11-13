import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeEngine } from "../model";
import { startLocalHost } from "../server";
import type { OwnedBattleSessionBundle } from "../simulator-battle-session-bundle";
import { HostStore } from "../store";
import { seed } from "./simulator-battle-journal-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
for (const fail of [false, true]) {
  test(`real Host stop preserves Battle ownership after cleanup failure=${String(fail)}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "tc-battle-stop-"));
    const order: string[] = [];
    const units = new Map<string, string | null>();
    const unavailable = async (): Promise<never> => {
      throw new Error("Unexpected gameplay call");
    };
    const bundle: OwnedBattleSessionBundle = {
      assertActive: () => undefined,
      run: unavailable,
      cleanup: async (owner) => {
        order.push(`cleanup:${owner.teamId}`);
        if (fail && owner.teamId === "first") throw new Error("Unconfirmed seal response");
        return { sealed: true, joined: true };
      },
    };
    const engine: RuntimeEngine = {
      catalog: () => [],
      start: unavailable,
      stop: unavailable,
      recover: async () => undefined,
      pause: unavailable,
      resume: unavailable,
      view: unavailable,
      submit: unavailable,
      hint: unavailable,
      surface: () => {
        throw new Error("Unexpected surface call");
      },
      closeTransports: async () => {
        order.push("transports");
      },
    };
    try {
      const host = await startLocalHost(
        root,
        {
          dataDirectory: directory,
          hostname: "127.0.0.1",
          adminPort: 0,
          participantPort: 0,
          gatewayPorts: { start: 58200, end: 58239 },
          ownedBattleSession: bundle,
        },
        (_directory, store) => {
          for (const team of ["first", "second"]) {
            const job = seed(store, team);
            units.set(job.jobId, job.unit);
          }
          return engine;
        },
        () => undefined,
      );
      if (fail) await expect(host.stop()).rejects.toThrow("Battle cleanup unconfirmed");
      else await host.stop();
      expect(order).toEqual(["cleanup:first", "cleanup:second", "transports"]);
      const reopened = new HostStore(new Database(host.databasePath));
      try {
        for (const [jobId, unit] of units) {
          expect(reopened.job(jobId).unit).toBe(unit);
          expect(reopened.job(jobId).status).not.toBe("DELETED");
        }
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
