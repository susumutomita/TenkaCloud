import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { logCatalogImport } from "../catalog-import-log";
import {
  type CatalogImport,
  CatalogSourceFailure,
  downloadConfiguredCatalog,
} from "../downloaded-catalog";

function problem(root: string, id: string) {
  const directory = join(root, "challenges", id);
  mkdirSync(join(root, "challenges"), { recursive: true });
  cpSync(resolve(import.meta.dirname, "../../../problems/challenges/sqli-demo"), directory, {
    recursive: true,
  });
  const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
  writeFileSync(join(directory, "metadata.json"), JSON.stringify({ ...metadata, id }));
}

test("real mixed acquisition reports every selected source, resolved commit and exact counts after commit", () => {
  const root = mkdtempSync(join(tmpdir(), "tc-import-log-"));
  const config = join(root, "catalog-sources.json");
  const lines: string[] = [];
  const deps = {
    resolveRef: () => "a".repeat(40),
    fetcher: ({ destinationDir }: { destinationDir: string }) => problem(destinationDir, "public"),
  };
  try {
    problem(join(root, "local-a"), "alpha");
    problem(join(root, "local-b"), "bravo");
    problem(join(root, "local-b"), "charlie");
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          { url: "https://example.invalid/catalog.git", ref: "main" },
          { path: "./local-a" },
          { path: "./local-b" },
        ],
      }),
    );
    logCatalogImport(
      () => downloadConfiguredCatalog(root, undefined, deps),
      (line) => {
        if (line.startsWith("Catalog imported:"))
          expect(
            readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8"),
          ).toContain('"digest"');
        lines.push(line);
      },
    );
    const sources = lines
      .filter((line) => line.startsWith("Catalog imported:"))
      .map((line) => JSON.parse(line.slice("Catalog imported: ".length)));
    expect(sources).toHaveLength(3);
    expect(sources[0]).toMatchObject({
      kind: "git",
      ref: "main",
      commit: "a".repeat(40),
      problems: 1,
    });
    expect(sources[1]).toMatchObject({ kind: "local", path: join(root, "local-a"), problems: 1 });
    expect(sources[1]).not.toHaveProperty("commit");
    expect(sources[2]).toMatchObject({ kind: "local", problems: 2 });
    for (const source of sources) expect(source.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(lines.at(-1)).toContain("sources=3 problems=4");
    expect(lines.at(-1)).toContain("Existing events retain their pinned snapshots");
    writeFileSync(
      join(root, "catalog-lock.json"),
      readFileSync(join(root, ".tenkacloud/catalog-store/selected.json")),
    );
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, sources: [{ path: "./local-a" }] }));
    lines.length = 0;
    logCatalogImport(
      () => downloadConfiguredCatalog(root, undefined, deps),
      (line) => lines.push(line),
    );
    expect(lines.filter((line) => line.startsWith("Catalog imported:"))).toHaveLength(1);
    expect(lines.at(-1)).toContain("sources=1 problems=1");

    const previous = readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8");
    lines.length = 0;
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          { path: "./local-a" },
          { url: "https://example.invalid/broken.git", ref: "main" },
        ],
      }),
    );
    expect(() =>
      logCatalogImport(
        () =>
          downloadConfiguredCatalog(root, undefined, {
            resolveRef: () => {
              throw new Error("secret transport body");
            },
          }),
        (line) => lines.push(line),
      ),
    ).toThrow("Source 2 (selected catalog)");
    expect(lines).toEqual(["Catalog import started."]);
    expect(readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8")).toBe(
      previous,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock left by an interrupted run is named with its recovery instead of source advice", () => {
  const root = mkdtempSync(join(tmpdir(), "tc-import-lock-"));
  const lock = join(root, ".tenkacloud/catalog-store/mutation.lock");
  let fetched = false;
  try {
    writeFileSync(
      join(root, "catalog-sources.json"),
      JSON.stringify({
        schemaVersion: 1,
        sources: [{ url: "https://example.invalid/catalog.git", ref: "main" }],
      }),
    );
    mkdirSync(lock, { recursive: true });
    let message = "";
    try {
      logCatalogImport(
        () =>
          downloadConfiguredCatalog(root, undefined, {
            resolveRef: () => {
              fetched = true;
              return "a".repeat(40);
            },
          }),
        () => undefined,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    expect(message).toBe(
      `Catalog import failed; startup/build stopped. Another catalog operation is active. If no make local, make deploy or catalog download is running, an interrupted run left ${lock} behind; remove that directory and retry.`,
    );
    expect(fetched).toBe(false);
    expect(existsSync(lock)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("safe output strips credentials, queries and fragments and never prints arbitrary errors", () => {
  const imported: CatalogImport = [
    {
      revision: {
        url: "https://name:password@example.invalid/catalog.git?token=query-secret#fragment-secret",
        ref: "main",
        commit: "a".repeat(40),
        digest: "b".repeat(64),
        problemsRoot: ".",
      },
      problemCount: 2,
    },
  ];
  const lines: string[] = [];
  logCatalogImport(
    () => imported,
    (line) => lines.push(line),
  );
  expect(lines.join("\n")).toContain("https://example.invalid/catalog.git");
  expect(lines.join("\n")).not.toMatch(/name|password|query-secret|fragment-secret/u);
  expect(() =>
    logCatalogImport(
      () => {
        throw new Error("Bearer private-token\nraw body");
      },
      (line) => lines.push(line),
    ),
  ).toThrow("Catalog import failed; startup/build stopped");
  expect(lines.join("\n")).not.toMatch(/private-token|raw body/u);
});

test("failure source identity is safe even when rejected input contains credentials or unsupported URLs", () => {
  for (const url of [
    "https://user:password@example.invalid/catalog.git?token=query-secret#fragment-secret",
    "data:private-token",
    "invalid private-token",
  ]) {
    const lines: string[] = [];
    let message = "";
    try {
      logCatalogImport(
        () => {
          throw new Error("unsafe outer body", {
            cause: new CatalogSourceFailure(
              { url, ref: "ref-private-secret", subdir: "subdir-private-secret" },
              2,
              true,
              new Error("Bearer raw-secret"),
            ),
          });
        },
        (line) => lines.push(line),
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
      expect(error.cause).toBeUndefined();
    }
    expect(message).toContain("Source 2 (retained snapshot)");
    expect(message).not.toMatch(
      /user|password|query-secret|fragment-secret|private-token|raw-secret|ref-private-secret|subdir-private-secret|unsafe outer body/u,
    );
    expect(lines).toEqual(["Catalog import started."]);
  }
});

test("Git ref failure cannot bypass safe output through child-process stderr", () => {
  const root = mkdtempSync(join(tmpdir(), "tc-import-stderr-"));
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(
      join(root, "bin/git"),
      "#!/bin/sh\necho synthetic-raw-transport-secret >&2\nexit 1\n",
      { mode: 0o700 },
    );
    writeFileSync(
      join(root, "catalog-sources.json"),
      JSON.stringify({
        schemaVersion: 1,
        sources: [{ url: "https://example.invalid/catalog.git", ref: "main" }],
      }),
    );
    const code = `import { logCatalogImport } from ${JSON.stringify(resolve(import.meta.dirname, "../catalog-import-log.ts"))}; import { downloadConfiguredCatalog } from ${JSON.stringify(resolve(import.meta.dirname, "../downloaded-catalog.ts"))}; try { logCatalogImport(() => downloadConfiguredCatalog(${JSON.stringify(root)})); } catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const result = spawnSync(process.execPath, ["-e", code], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("Catalog import started.\n");
    expect(result.stderr).toContain("Source 1 (selected catalog)");
    expect(result.stderr).not.toContain("synthetic-raw-transport-secret");
    expect(result.stderr).not.toContain("Catalog import complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
