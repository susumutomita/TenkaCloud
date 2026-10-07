import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { buildSync } from "esbuild";
import {
  LOCAL_COORDINATION_STATE_LIMIT,
  requiredCoordinationTeams,
  reviewedCoordinationBattles,
} from "./coordination-catalog";
import type { HostPlugin } from "./coordination-core";
import { privateDirectory } from "./files";
import { HostError, organizerProblemContent, type Problem } from "./model";

interface CoordinationDefinition {
  kind: "coordination";
  metadata: Record<string, unknown>;
  bundle: string;
  digest: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Reviewed local compatibility list. Game rules remain in the catalog's SDK plugin. */
export function coordinationCatalog(root: string): Problem[] {
  return reviewedCoordinationBattles.map(({ problemId }) => coordinationProblem(root, problemId));
}
function coordinationProblem(root: string, problemId: string): Problem {
  const directory = join(root, "problems/battles", problemId);
  const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8")) as Record<
    string,
    unknown
  >;
  if (metadata.id !== problemId || metadata.category !== "Battle")
    throw new Error(`Invalid reviewed coordination identity: ${problemId}`);
  const coordination = metadata.interTeamCoordination as { plugin: string };
  const built = buildSync({
    entryPoints: [join(directory, coordination.plugin)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  for (const input of Object.values(built.metafile.inputs)) {
    for (const imported of input.imports) {
      const name = imported.original ?? imported.path;
      if (
        !/^[./]/u.test(name) &&
        !["node:crypto", "@tenkacloud/coordination-plugin-sdk"].includes(name)
      )
        throw new Error(`Unsupported local coordination import: ${name}`);
    }
  }
  const bundle = built.outputFiles[0]?.text;
  if (!bundle) throw new Error("Coordination bundle is empty.");
  return {
    problemId,
    name: String(metadata.name),
    organizerContent: organizerProblemContent(metadata),
    runtime: "coordination",
    definition: JSON.stringify({
      kind: "coordination",
      metadata,
      bundle,
      digest: hash(bundle),
    } satisfies CoordinationDefinition),
  };
}

/** Reject an incompatible roster before issuing keys or preparing a match. */
export function assertCoordinationRoster(problems: readonly Problem[], teams: number): void {
  for (const problem of problems) {
    if (problem.runtime !== "coordination") continue;
    const required = requiredCoordinationTeams(problem.problemId);
    const { metadata } = JSON.parse(problem.definition) as CoordinationDefinition;
    const budget = (
      metadata?.interTeamCoordination as
        | { stateBudget?: { baseBytes: number; bytesPerTeam: number } }
        | undefined
    )?.stateBudget;
    if (
      budget &&
      (!Number.isSafeInteger(budget.baseBytes) ||
        budget.baseBytes < 0 ||
        !Number.isSafeInteger(budget.bytesPerTeam) ||
        budget.bytesPerTeam < 1 ||
        budget.baseBytes + budget.bytesPerTeam * teams > LOCAL_COORDINATION_STATE_LIMIT)
    )
      throw new HostError(
        422,
        `${problem.name} exceeds the local coordination state budget for ${teams} teams.`,
      );
    if (required !== undefined && teams !== required)
      throw new HostError(422, `${problem.name} requires exactly ${required} teams.`);
  }
}

export class LocalPluginLoader {
  private readonly plugins = new Map<string, HostPlugin>();
  constructor(private readonly dataDirectory: string) {}
  load(definition: string): HostPlugin {
    const saved = JSON.parse(definition) as CoordinationDefinition;
    if (saved.kind !== "coordination" || hash(saved.bundle) !== saved.digest)
      throw new Error("Invalid pinned coordination bundle.");
    const previous = this.plugins.get(saved.digest);
    if (previous) return previous;
    const directory = privateDirectory(join(this.dataDirectory, "coordination"));
    const path = join(directory, `${saved.digest}.cjs`);
    if (!existsSync(path)) writeFileSync(path, saved.bundle, { mode: 0o600, flag: "wx" });
    if (hash(readFileSync(path, "utf8")) !== saved.digest)
      throw new Error("Pinned coordination bundle was modified.");
    const module = createRequire(import.meta.url)(path) as { default: HostPlugin };
    const plugin = module.default;
    if (
      !plugin ||
      [plugin.initialState, plugin.validateOp, plugin.applyOp, plugin.projectForTeam].some(
        (fn) => typeof fn !== "function",
      )
    )
      throw new Error("Invalid coordination plugin.");
    const version = plugin.stateSchemaVersion ?? 1;
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      (version > 1 && typeof plugin.migrateState !== "function")
    )
      throw new Error("Invalid coordination schema contract.");
    this.plugins.set(saved.digest, plugin);
    return plugin;
  }
}

export function coordinationProblemView(
  problem: Problem,
  score: number,
  createdAt: string,
): Record<string, unknown> {
  const { metadata } = JSON.parse(problem.definition) as CoordinationDefinition;
  const english = (metadata.i18n as { en?: Record<string, unknown> } | undefined)?.en;
  return {
    problemId: problem.problemId,
    name: problem.name,
    coordination: true,
    instructions: metadata.instructions,
    region: "local",
    awsAccountId: "local",
    status: "COMPLETE",
    score,
    createdAt,
    i18n: {
      en: {
        name: english?.name,
        instructions: english?.instructions,
        shortDescription: english?.shortDescription,
      },
    },
    stackOutputs: {},
    deployLog: { cursor: "", entries: [] },
  };
}

export function noCoordinationSurface(): never {
  throw new HostError(
    404,
    "This Battle runs in the participant portal and has no external exercise URL.",
  );
}
