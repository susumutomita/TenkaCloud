import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  CatalogLockSchema,
  lockPath,
  type Revision,
  readCatalogSelection,
  SelectionSchema,
  store,
} from "./catalog-read.js";
import { verifyCatalogLock } from "./downloaded-catalog.js";

export const challengeUrl = "https://github.com/susumutomita/TenkaCloudChallenge.git";
const ReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.url(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});
const numeric = "(?:0|[1-9][0-9]*)";
const identifier = `(?:${numeric}|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)`;
const semver = new RegExp(
  `^v?${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  "u",
);

export function isNewerRelease(current: string, target: string): boolean {
  return (
    semver.test(current) &&
    semver.test(target) &&
    !target.split("+")[0]?.includes("-") &&
    Bun.semver.order(target.replace(/^v/u, ""), current.replace(/^v/u, "")) > 0
  );
}

function retain(entries: Revision[], previous: Revision): Revision[] {
  return [
    ...new Map(
      [...entries, { ...previous, ref: previous.commit }].map((r) => [r.commit, r]),
    ).values(),
  ];
}

export function planCatalogBump(selectionInput: unknown, lockInput: unknown, tag: string) {
  const selection = SelectionSchema.parse(selectionInput);
  const lock = CatalogLockSchema.parse(lockInput);
  const source = selection.sources.find((entry) => entry.url === challengeUrl);
  if (!source) throw new Error("TenkaCloudChallenge source is missing");
  if (!isNewerRelease(source.ref, tag)) return null;
  const previous = lock.sources.find(
    (entry) => entry.url === source.url && entry.subdir === source.subdir,
  );
  if (!previous || previous.ref !== source.ref) throw new Error("Catalog source and lock disagree");
  return {
    oldTag: source.ref,
    selection: {
      ...selection,
      sources: selection.sources.map((entry) =>
        entry === source ? { ...entry, ref: tag } : entry,
      ),
      retained: retain(selection.retained ?? [], previous),
    },
    retained: retain(lock.retained ?? [], previous),
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function make(root: string, ...args: string[]): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixed executable, argument array, no shell
  execFileSync("make", args, { cwd: root, stdio: "inherit" });
}

/** Stage the reviewed files; acquisition and every validation must succeed before publication. */
export function bumpCatalog(
  root: string,
  plan: NonNullable<ReturnType<typeof planCatalogBump>>,
  deps: {
    acquire?: (sourcesPath: string) => void;
    verify?: (stagingRoot: string) => void;
    prepare?: () => void;
  } = {},
) {
  const scratch = mkdtempSync(join(tmpdir(), "catalog-bump-"));
  try {
    const sourcesPath = join(scratch, "catalog-sources.json");
    writeFileSync(sourcesPath, json(plan.selection));
    (deps.acquire ?? ((path) => make(root, "catalog-download", `CATALOG_SOURCES=${path}`)))(
      sourcesPath,
    );
    const selectedText = readCatalogSelection(root);
    const selected = CatalogLockSchema.parse(JSON.parse(selectedText));
    const expectedSources = selected.sources.map(({ url, ref, subdir }) => ({
      url,
      ref,
      ...(subdir === undefined ? {} : { subdir }),
    }));
    if (json(expectedSources) !== json(plan.selection.sources))
      throw new Error("Acquisition selected unexpected sources");
    const lock = CatalogLockSchema.parse({
      schemaVersion: 1,
      sources: selected.sources,
      retained: plan.retained,
    });
    mkdirSync(store(scratch), { recursive: true });
    writeFileSync(lockPath(scratch), selectedText);
    writeFileSync(join(scratch, "catalog-lock.json"), json(lock));
    (deps.verify ?? verifyCatalogLock)(scratch);
    (deps.prepare ?? (() => make(root, "catalog-prepare", "validate-problems")))();
    writeFileSync(join(root, "catalog-sources.json"), json(plan.selection));
    writeFileSync(join(root, "catalog-lock.json"), json(lock));
    return lock;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function findCatalogBump(
  root: string,
  override: string,
  deps: {
    release: (tag: string) => Promise<unknown>;
    exists: (branch: string) => Promise<boolean>;
  },
) {
  const selection = SelectionSchema.parse(
    JSON.parse(readFileSync(join(root, "catalog-sources.json"), "utf8")),
  );
  const current = selection.sources.find((entry) => entry.url === challengeUrl);
  if (!current) throw new Error("TenkaCloudChallenge source is missing");
  if (!semver.test(current.ref)) return null;
  if (override && !isNewerRelease(current.ref, override)) return null;
  const release = ReleaseSchema.parse(await deps.release(override));
  if (release.draft || release.prerelease || (override && release.tag_name !== override))
    return null;
  const plan = planCatalogBump(
    selection,
    JSON.parse(readFileSync(join(root, "catalog-lock.json"), "utf8")),
    release.tag_name,
  );
  if (!plan) return null;
  const branch = `catalog/bump-${release.tag_name}`;
  if (await deps.exists(branch)) return null;
  return { plan, release, branch };
}
