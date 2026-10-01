import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const commit = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const image = z
  .object({
    tag: z.string().min(1),
    imageId: digest,
    registryDigests: z.array(z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/)),
  })
  .strict();
export const HostCandidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("unpublished"),
    sources: z.object({ platformCommit: commit.nullable(), catalogCommit: commit }).strict(),
    image: image.nullable(),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.image === null) !== (value.sources.platformCommit === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Image and source commit must be recorded together",
      });
    }
  });
const InspectionSchema = z
  .array(
    z.object({
      Id: digest,
      RepoTags: z.array(z.string()).nullable(),
      RepoDigests: z.array(z.string()).nullable(),
      Config: z.object({ Labels: z.record(z.string()).nullable() }),
    }),
  )
  .length(1);

export function captureCandidate(input: {
  tag: string;
  platformCommit: string;
  catalogCommit: string;
  inspection: unknown;
}) {
  const inspected = InspectionSchema.parse(input.inspection)[0];
  if (!inspected) throw new Error("Expected one inspected image");
  if (!inspected.RepoTags?.includes(input.tag)) throw new Error("Requested image tag is absent");
  const labels = inspected.Config.Labels;
  if (
    labels?.["org.opencontainers.image.revision"] !== input.platformCommit ||
    labels["io.tenkacloud.catalog.revision"] !== input.catalogCommit
  ) {
    throw new Error("Image source/catalog labels do not match the clean checkout");
  }
  return HostCandidateSchema.parse({
    schemaVersion: 1,
    status: "unpublished",
    sources: { platformCommit: input.platformCommit, catalogCommit: input.catalogCommit },
    image: { tag: input.tag, imageId: inspected.Id, registryDigests: inspected.RepoDigests ?? [] },
    limitations: [
      "This record does not publish an image or certify a release.",
      "imageId is Docker inspect Id; registryDigests copies Docker RepoDigests. Neither field proves registry publication.",
      "Attach host build, HTTP/SQLite, browser and durable container restart evidence before publication review.",
    ],
  });
}
function git(root: string, args: string[]): string {
  return execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" }).trim();
}
function catalogPin(root: string): string {
  const value = /^160000 ([a-f0-9]{40}) /.exec(
    git(root, ["ls-files", "-s", "--", "problems"]),
  )?.[1];
  return commit.parse(value);
}
function main(): void {
  const root = resolve(import.meta.dir, "../..");
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--sync-catalog") {
    const path = resolve(root, "release/host-candidate.json");
    const pending = HostCandidateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (pending.image !== null) throw new Error("Cannot change the catalog of a built image");
    writeFileSync(
      path,
      `${JSON.stringify({ ...pending, sources: { ...pending.sources, catalogCommit: catalogPin(root) } }, null, 2)}\n`,
    );
    return;
  }
  if (args.length === 1 && args[0] === "--check") {
    const pending = HostCandidateSchema.parse(
      JSON.parse(readFileSync(resolve(root, "release/host-candidate.json"), "utf8")),
    );
    if (pending.sources.catalogCommit !== catalogPin(root))
      throw new Error("Host candidate catalog pin does not match the gitlink");
    console.log("Unpublished host candidate contract is valid; no release or image was published.");
    return;
  }
  if (args.length !== 4 || args[0] !== "--image" || !args[1] || args[2] !== "--out" || !args[3]) {
    throw new Error("Usage: bun run release:candidate --image <local-tag> --out <evidence.json>");
  }
  if (git(root, ["status", "--porcelain"]))
    throw new Error("Candidate capture requires a clean source checkout");
  // Docker is the developer-selected local engine, as in the host container rehearsal.
  const inspection: unknown = JSON.parse(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- local Docker tooling
    execFileSync("docker", ["image", "inspect", args[1]], { encoding: "utf8" }),
  );
  const candidate = captureCandidate({
    tag: args[1],
    platformCommit: git(root, ["rev-parse", "HEAD"]),
    catalogCommit: catalogPin(root),
    inspection,
  });
  writeFileSync(args[3], `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
}
if (import.meta.main) main();
