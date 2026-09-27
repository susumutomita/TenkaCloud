import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMatch, transitionMatch } from "../coordination-core";
import { coordinationCatalog, LocalPluginLoader } from "../coordination-runtime";

interface Projection {
  ready: { count: number; total: number; me: boolean };
  myContracts: { id: string; allowedMethods: string[]; status: string }[];
  vault: unknown;
  teams: Record<string, { score: number }>;
}

describe("real catalog crypto plugin in local runtime", () => {
  test("all teams ready, LEAK scoring, replay rejection and durable reload", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenka-crypto-core-"));
    try {
      const root = fileURLToPath(new URL("../../../", import.meta.url));
      const catalog = coordinationCatalog(root);
      const definition = required(catalog[0]).definition;
      const plugin = new LocalPluginLoader(directory).load(definition);
      const context = {
        eventId: "local-proof",
        teamIds: ["alpha", "beta"],
        teamNames: { alpha: "Alpha", beta: "Beta" },
      };
      const initial = createMatch(plugin, context);
      const first = transitionMatch(plugin, initial, context.teamIds, 0, {
        teamId: "alpha",
        op: { kind: "ready" },
      });
      const waiting = plugin.projectForTeam(first.match.state, "alpha") as Projection;
      expect(waiting.ready).toMatchObject({ count: 1, total: 2, me: true });
      expect(waiting.myContracts).toHaveLength(0);
      let match = transitionMatch(plugin, first.match, context.teamIds, 0, {
        teamId: "beta",
        op: { kind: "ready" },
      }).match;
      match = transitionMatch(plugin, match, context.teamIds, 1).match;
      const own = plugin.projectForTeam(match.state, "alpha") as Projection;
      const order = own.myContracts.find((contract) => contract.allowedMethods.includes("leak"));
      expect(order).toBeDefined();
      const move = { teamId: "alpha", op: { kind: "leak", contractId: required(order).id } };
      const submitted = transitionMatch(plugin, match, context.teamIds, 1, move);
      expect(submitted.rejection).toBeUndefined();
      expect(submitted.deltas.alpha).toBeGreaterThan(0);
      expect(submitted.deltas.beta).toBe(0);
      const duplicate = transitionMatch(plugin, submitted.match, context.teamIds, 1, move);
      expect(duplicate.rejection).toBeDefined();
      expect(duplicate.deltas.alpha).toBe(0);
      const saved = JSON.parse(JSON.stringify(submitted.match));
      const reloaded = new LocalPluginLoader(directory).load(definition);
      expect(reloaded.projectForTeam(saved.state, "alpha")).toEqual(
        plugin.projectForTeam(submitted.match.state, "alpha"),
      );
      const beta = plugin.projectForTeam(saved.state, "beta") as Projection;
      expect(beta.vault).not.toEqual(own.vault);
      expect(JSON.stringify(beta)).not.toContain(saved.matchSecret);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected a present test value.");
  return value;
}
