import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadDockerCatalog } from "../../local-host/docker-catalog";
import { CatalogLockSchema, SelectionSchema, selectedCatalogSnapshots } from "../catalog-read";
import {
  downloadCatalog,
  downloadConfiguredCatalog,
  downloadLockedCatalog,
  materializeCatalog,
} from "../downloaded-catalog";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tc-local-source-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const example = resolve(import.meta.dirname, "../../../problems/challenges/sqli-demo");
function problem(root: string, id: string, parent = "challenges") {
  const path = join(root, parent, id);
  mkdirSync(join(root, parent), { recursive: true });
  cpSync(example, path, { recursive: true });
  const metadata = JSON.parse(readFileSync(join(path, "metadata.json"), "utf8"));
  metadata.id = id;
  writeFileSync(join(path, "metadata.json"), JSON.stringify(metadata));
  return path;
}
const selection = (...paths: string[]) => ({
  schemaVersion: 1,
  sources: paths.map((path) => ({ path })),
});
const selected = (root: string) =>
  readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8");

test("mixed Git and multiple local sources use existing metadata discovery, deterministically, without a list", () => {
  const root = fixture(),
    a = fixture(),
    b = fixture();
  problem(a, "zulu");
  problem(a, "alpha");
  problem(b, "bravo");
  writeFileSync(join(a, "README.md"), "not a problem");
  mkdirSync(join(a, "notes"));
  writeFileSync(join(a, "notes/README.md"), "still not a problem");
  downloadCatalog(
    root,
    {
      schemaVersion: 1,
      sources: [
        { url: "https://example.invalid/public.git", ref: "a".repeat(40) },
        { path: a },
        { path: b },
      ],
    },
    {
      fetcher: ({ destinationDir }) => {
        problem(destinationDir, "public");
      },
    },
  );
  materializeCatalog(root);
  expect(loadDockerCatalog(root).map((p) => p.problemId)).toEqual([
    "alpha",
    "bravo",
    "public",
    "zulu",
  ]);
  const previous = selected(root);
  downloadCatalog(
    root,
    {
      schemaVersion: 1,
      sources: [
        { url: "https://example.invalid/public.git", ref: "a".repeat(40) },
        { path: a },
        { path: b },
      ],
    },
    {
      fetcher: ({ destinationDir }) => {
        problem(destinationDir, "public");
      },
    },
  );
  expect(selected(root)).toBe(previous);
});

test("configured relative paths resolve against the config file, include uncommitted changes and retain old bytes", () => {
  const root = fixture();
  const author = join(root, "author");
  const path = problem(author, "draft");
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/sources.json"), JSON.stringify(selection("../author")));
  downloadConfiguredCatalog(root, "config/sources.json");
  const first = selectedCatalogSnapshots(root)[0];
  if (!first) throw new Error("Expected local snapshot");
  writeFileSync(join(path, "README.md"), "uncommitted edit");
  problem(author, "added");
  downloadConfiguredCatalog(root, "config/sources.json");
  materializeCatalog(root);
  expect(loadDockerCatalog(root).map((p) => p.problemId)).toEqual(["added", "draft"]);
  expect(selectedCatalogSnapshots(root)[0]?.revision.digest).not.toBe(first.revision.digest);
  expect(readFileSync(join(first.problemRoot, "challenges/draft/README.md"), "utf8")).not.toBe(
    "uncommitted edit",
  );
  writeFileSync(join(root, "catalog-lock.json"), selected(root));
  rmSync(author, { recursive: true });
  downloadLockedCatalog(root);
  expect(CatalogLockSchema.parse(JSON.parse(selected(root))).retained).toHaveLength(2);
});

test("local copy omits Git, hidden config, credentials, keys and dependency trees", () => {
  const root = fixture(),
    author = fixture();
  const path = problem(author, "safe");
  for (const name of [".git", ".aws", "node_modules", "dist"]) {
    mkdirSync(join(author, name));
    writeFileSync(join(author, name, "private"), "do not include");
  }
  for (const name of [
    ".env",
    ".env.local",
    "credentials.json",
    "secret.json",
    "server.key",
    "id_rsa",
    "client.p12",
  ])
    writeFileSync(join(path, name), "do not include");
  downloadCatalog(root, selection(author));
  const snapshot = selectedCatalogSnapshots(root)[0];
  if (!snapshot) throw new Error("Expected local snapshot");
  const { directory, problemRoot } = snapshot;
  for (const name of [".git", ".aws", "node_modules", "dist"])
    expect(existsSync(join(directory, name))).toBe(false);
  for (const name of [
    ".env",
    ".env.local",
    "credentials.json",
    "secret.json",
    "server.key",
    "id_rsa",
    "client.p12",
  ])
    expect(existsSync(join(problemRoot, "challenges/safe", name))).toBe(false);
});

for (const kind of [
  "missing",
  "invalid",
  "duplicate",
  "external-link",
  "internal-link",
  "root-link",
  "metadata-fields",
  "missing-metadata",
  "readme",
  "not-directory",
])
  test(`invalid local source ${kind} preserves selected edition and generated view`, () => {
    const root = fixture(),
      good = fixture(),
      bad = fixture();
    problem(good, "accepted");
    const path = problem(bad, "broken");
    downloadCatalog(root, selection(good));
    materializeCatalog(root);
    const old = selected(root);
    let source = bad;
    if (kind === "missing") source = join(bad, "absent");
    if (kind === "missing-metadata") rmSync(join(path, "metadata.json"));
    if (kind === "invalid") writeFileSync(join(path, "metadata.json"), "{");
    if (kind === "duplicate") problem(bad, "broken", "battles");
    if (kind === "metadata-fields")
      writeFileSync(
        join(path, "metadata.json"),
        JSON.stringify({ id: "broken", category: "Challenge" }),
      );
    if (kind === "readme") rmSync(join(path, "README.md"));
    if (kind === "external-link") symlinkSync(good, join(path, "escape"));
    if (kind === "internal-link") symlinkSync(join(path, "README.md"), join(path, "alias"));
    if (kind === "root-link") {
      source = join(bad, "linked");
      symlinkSync(path, source);
    }
    if (kind === "not-directory") {
      source = join(bad, "plain");
      writeFileSync(source, "not a directory");
    }
    expect(() => downloadCatalog(root, selection(source))).toThrow();
    expect(selected(root)).toBe(old);
    expect(loadDockerCatalog(root).map((p) => p.problemId)).toEqual(["accepted"]);
  });

test("cross-source ID collision refuses local+local and local+Git before selection swap", () => {
  const root = fixture(),
    author = fixture();
  problem(author, "collision");
  downloadCatalog(root, selection(author));
  const old = selected(root);
  expect(() => downloadCatalog(root, selection(author, author))).toThrow(
    "Duplicate catalog problem ID",
  );
  expect(() =>
    downloadCatalog(
      root,
      {
        schemaVersion: 1,
        sources: [
          { path: author },
          { url: "https://example.invalid/public.git", ref: "a".repeat(40) },
        ],
      },
      {
        fetcher: ({ destinationDir }) => {
          problem(destinationDir, "collision");
        },
      },
    ),
  ).toThrow("Duplicate catalog problem ID");
  expect(selected(root)).toBe(old);
});

test("source selection schema accepts documented variants and rejects ambiguous or unknown fields", () => {
  const git = { url: "https://example.invalid/catalog.git", ref: "main", subdir: "catalog" };
  expect(
    SelectionSchema.parse({ schemaVersion: 1, sources: [git, { path: " ../private " }] })
      .sources[1],
  ).toEqual({ path: "../private" });
  for (const invalid of [
    { schemaVersion: "1", sources: [{ path: "../private" }] },
    { schemaVersion: 1, sources: [] },
    { schemaVersion: 1, sources: [{ path: " " }] },
    { schemaVersion: 1, sources: [{ path: 123 }] },
    { schemaVersion: 1, sources: [{ path: "../private", subdir: "nested" }] },
    { schemaVersion: 1, sources: [{ ...git, path: "../private" }] },
    { schemaVersion: 1, sources: [{ ...git, type: "git" }] },
    { schemaVersion: 1, sources: [{ url: git.url, branch: "main" }] },
    { schemaVersion: 1, sources: [{ path: "../private" }], unknown: true },
  ])
    expect(SelectionSchema.safeParse(invalid).success).toBe(false);
});

test("Japanese and English manual JSON examples validate against the canonical selection schema", () => {
  const examples = ["page.mdx", "page.ja.mdx"].map((page) => {
    const manual = readFileSync(
      resolve(
        import.meta.dirname,
        `../../../apps/developer-portal/src/app/developers/docs/operate/use-existing-pack/${page}`,
      ),
      "utf8",
    );
    const example = /```json\n([\s\S]*?)\n```/u.exec(manual);
    if (!example?.[1]) throw new Error(`Missing executable source example in ${page}`);
    return SelectionSchema.parse(JSON.parse(example[1]));
  });
  expect(examples[0]).toEqual(examples[1]);
  expect(examples[0]?.sources).toHaveLength(3);
  expect(examples[0]?.sources[1]).toEqual({ path: "../../private-event-problems" });
});
