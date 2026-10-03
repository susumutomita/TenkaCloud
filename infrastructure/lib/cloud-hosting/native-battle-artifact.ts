import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { buildSync } from "esbuild";
import { z } from "zod";
import { contentDigest } from "../problem-deploy/handlers/shared/execution-catalog.js";
import { repositoryArtifactFile } from "./execution-artifact-path.js";

/** Build da2's reviewed pure plugin closure; the optional AWS variant has separate source bytes. */
export function nativeBattleArtifact(repositoryRoot: string) {
  const problemDir = "problems/battles/ac26-crypto-battle";
  const entry = `${problemDir}/coordination/crypto-battle.ts`;
  const metadata = z
    .object({
      id: z.literal("ac26-crypto-battle"),
      name: z.string(),
      description: z.string(),
      instructions: z.string(),
      interTeamCoordination: z.object({
        plugin: z.literal("coordination/crypto-battle.ts"),
        stateBudget: z.object({ bytesPerTeam: z.literal(31744), baseBytes: z.literal(1536) }),
      }),
      i18n: z.object({
        en: z.object({ name: z.string(), description: z.string(), instructions: z.string() }),
      }),
    })
    .parse(
      JSON.parse(
        readFileSync(repositoryArtifactFile(repositoryRoot, `${problemDir}/metadata.json`), "utf8"),
      ) as unknown,
    );
  const result = buildSync({
    absWorkingDir: realpathSync(repositoryRoot),
    entryPoints: [repositoryArtifactFile(repositoryRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  for (const [input, details] of Object.entries(result.metafile.inputs)) {
    const path = relative(
      realpathSync(repositoryRoot),
      resolve(realpathSync(repositoryRoot), input),
    )
      .split(sep)
      .join("/");
    if (
      path !== entry &&
      !path.startsWith(`${problemDir}/game/src/`) &&
      !path.startsWith("packages/coordination-plugin-sdk/src/")
    )
      throw new Error("Native plugin import is outside the reviewed closure.");
    repositoryArtifactFile(repositoryRoot, path);
    if (details.imports.some((item) => item.external && item.path !== "node:crypto"))
      throw new Error("Native plugin has an unreviewed external import.");
  }
  for (const output of Object.values(result.metafile.outputs))
    if (output.imports.some((item) => !item.external || item.path !== "node:crypto"))
      throw new Error("Native plugin bundle is not self-contained.");
  const source = result.outputFiles?.[0]?.text;
  if (
    !source ||
    Buffer.byteLength(source) > 1024 * 1024 ||
    /\b(?:require|import)\s*\(/u.test(source)
  )
    throw new Error("Native plugin bundle contains an unsupported dynamic import.");
  const artifactDigest = contentDigest(source);
  const pluginKey = `plugins/${artifactDigest}.mjs`;
  return {
    source,
    descriptor: {
      kind: "coordination" as const,
      problemId: metadata.id,
      problemDir,
      artifactDigest,
      pluginKey,
      stateBudget: metadata.interTeamCoordination.stateBudget,
      name: metadata.name,
      description: metadata.description,
      instructions: metadata.instructions,
      i18n: metadata.i18n,
    },
  };
}
