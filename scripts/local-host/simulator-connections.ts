import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { CloudHosting } from "./cloud-hosting";
import type { CloudFormationEngine } from "./cloudformation-engine";
import type { AccountConnection } from "./model";
import {
  authorityBinding,
  authorityUnavailable,
  type SimulatorAuthority,
  sameAuthority,
  simulatorAuthoritySchema,
} from "./simulator-authority";
import {
  connectSimulatorHosting,
  readSimulatorPrivateFile,
  type SimulatorSettings,
  simulatorSettings,
} from "./simulator-hosting";

const manifestSchema = z
  .object({
    version: z.literal(1),
    connections: z
      .array(
        z
          .object({
            ...simulatorAuthoritySchema.shape,
            endpoint: z.string(),
            region: z.string(),
            tokenFile: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

/** Only explicit external connections. No startup, bootstrap, reload or secret values. */
export function loadSimulatorConnections(path: string): readonly SimulatorSettings[] {
  try {
    const manifest = manifestSchema.parse(JSON.parse(readSimulatorPrivateFile(path, 65536)));
    const ids = new Set<string>();
    const endpoints = new Set<string>();
    const files = new Set<string>();
    return manifest.connections.map(({ authorityId, generation, endpoint, region, tokenFile }) => {
      const settings = simulatorSettings({
        "simulator-endpoint": endpoint,
        "simulator-region": region,
        "simulator-token-file": resolve(dirname(path), tokenFile),
      });
      if (
        !settings ||
        !("tokenFile" in settings) ||
        ids.has(authorityId) ||
        endpoints.has(settings.endpoint) ||
        files.has(settings.tokenFile)
      )
        throw authorityUnavailable();
      ids.add(authorityId);
      endpoints.add(settings.endpoint);
      files.add(settings.tokenFile);
      return { ...settings, authority: { authorityId, generation } };
    });
  } catch {
    // JSON/schema/fs errors can contain private input. Never propagate them.
    throw new Error(
      "Invalid private Simulator connections file; require version 1 and distinct explicit authority IDs, loopback endpoints and private token file references.",
    );
  }
}

type ConnectedSimulator = NonNullable<Awaited<ReturnType<typeof connectSimulatorHosting>>>;

/** One selection for the entire client bundle, shared by verification and runtime engines. */
export function simulatorConnections(
  entries: readonly { binding: SimulatorAuthority; connection: ConnectedSimulator }[],
): CloudHosting & AccountConnection {
  const first = entries[0];
  if (!first) throw authorityUnavailable();
  const select = (binding: SimulatorAuthority) => {
    const entry = entries.find((candidate) => sameAuthority(candidate.binding, binding));
    if (!entry) throw authorityUnavailable();
    return entry.connection;
  };
  return {
    ...first.connection,
    // The top-level transport is never an implicit default.
    simulator: undefined,
    authorities: entries.map(({ binding, connection }) => ({
      ...binding,
      region: connection.region,
      awsAccountId: connection.simulator.awsAccountId,
      bootstrapRoleName: connection.simulator.bootstrapRoleName,
    })),
    selectAuthority: select,
    verify: async () => {
      throw authorityUnavailable();
    },
    engine: (team) => {
      const engines = new Map<string, CloudFormationEngine>();
      const resolver = (binding: SimulatorAuthority) => {
        select(binding);
        return engines.get(binding.authorityId);
      };
      for (const { binding, connection } of entries)
        engines.set(binding.authorityId, connection.engine(team, resolver));
      const engine = engines.get(first.binding.authorityId);
      if (!engine) throw authorityUnavailable();
      return engine;
    },
  };
}

export async function connectSimulatorConnections(
  root: string,
  directory: string,
  settings: readonly SimulatorSettings[],
) {
  // Validate every binding before any credential read or transport call.
  const ids = new Set<string>();
  for (const entry of settings) {
    const binding = authorityBinding(entry.authority);
    if (!binding || ids.has(binding.authorityId)) throw authorityUnavailable();
    ids.add(binding.authorityId);
  }
  const entries = [];
  for (const entry of settings) {
    let connection: Awaited<ReturnType<typeof connectSimulatorHosting>>;
    try {
      connection = await connectSimulatorHosting(root, directory, entry);
    } catch {
      throw new Error(
        "Could not connect the explicitly configured Simulator authority. Check its private configuration; no fallback was attempted.",
      );
    }
    if (!connection || !entry.authority) throw authorityUnavailable();
    entries.push({ binding: entry.authority, connection });
  }
  return simulatorConnections(entries);
}
