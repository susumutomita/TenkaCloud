import { expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostBrowserProblemPaths } from "../../local-host/browser-metadata.js";
import { dockerDefinitionOf, loadDockerCatalog } from "../../local-host/docker-catalog.js";
import type { Job } from "../../local-host/model.js";
import { CatalogLockSchema, retainedCatalogRoots, selectedCatalogRoots } from "../catalog-read.js";
import {
  downloadCatalog,
  downloadConfiguredCatalog,
  downloadLockedCatalog,
  materializeCatalog,
  verifyCatalogLock,
} from "../downloaded-catalog.js";
import type { GitArchiveFetcher } from "../git-source.js";

const repository = resolve(import.meta.dirname, "../../..");
const revision = "a".repeat(40);
const config = (ids: string[]) => ({
  schemaVersion: 1,
  sources: ids.map((id) => ({ url: `https://example.invalid/${id}.git`, ref: revision })),
});

test("configured branch acquisition resolves again, keeps old snapshots internally and fails closed", () =>
  fixture((root, fetcher) => {
    const selection = {
      schemaVersion: 1,
      sources: [{ url: "https://example.invalid/branch.git", ref: "main" }],
    };
    const path = join(root, "catalog-sources.json");
    const text = JSON.stringify(selection);
    writeFileSync(path, text);
    let commit = revision;
    const deps = {
      resolveRef: (url: string, ref: string) => {
        expect(url).toBe(selection.sources[0]?.url);
        expect(ref).toBe("main");
        return commit;
      },
      fetcher: ((request) => {
        fetcher(request);
        writeFileSync(join(request.destinationDir, "shared.txt"), request.commit);
      }) satisfies GitArchiveFetcher,
    };
    downloadConfiguredCatalog(root, undefined, deps);
    const first = selectedCatalogRoots(root)[0];
    expect(first).toBeDefined();
    const lock = readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8");
    writeFileSync(join(root, "catalog-lock.json"), lock);
    commit = "b".repeat(40);
    downloadConfiguredCatalog(root, undefined, deps);
    expect(selectedCatalogRoots(root)[0]).not.toBe(first);
    expect(retainedCatalogRoots(root)).toContain(String(first));
    expect(readFileSync(join(String(first), "shared.txt"), "utf8")).toBe(revision);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readFileSync(join(root, "catalog-lock.json"), "utf8")).toBe(lock);
    const selected = readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8");
    expect(() =>
      downloadConfiguredCatalog(root, undefined, {
        ...deps,
        resolveRef: () => {
          throw new Error("branch unavailable");
        },
      }),
    ).toThrow("branch unavailable");
    expect(() =>
      downloadConfiguredCatalog(root, undefined, {
        ...deps,
        fetcher: () => {
          throw new Error("fetch failed");
        },
      }),
    ).toThrow("fetch failed");
    expect(readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8")).toBe(
      selected,
    );
    expect(existsSync(join(root, ".tenkacloud/catalog-store/mutation.lock"))).toBe(false);
  }));

test("locked CI acquisition restores and verifies pinned bytes without resolving a branch", () =>
  fixture((root, fetcher) => {
    downloadCatalog(root, config(["locked"]), { fetcher });
    const lock = readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8");
    writeFileSync(join(root, "catalog-lock.json"), lock);
    rmSync(join(root, ".tenkacloud"), { recursive: true, force: true });
    downloadLockedCatalog(root, {
      fetcher,
      resolveRef: () => {
        throw new Error("must not resolve a moving branch");
      },
    });
    expect(() => verifyCatalogLock(root)).not.toThrow();
    rmSync(join(root, ".tenkacloud"), { recursive: true, force: true });
    expect(() =>
      downloadLockedCatalog(root, {
        fetcher: (request) => {
          fetcher(request);
          writeFileSync(join(request.destinationDir, "shared.txt"), "changed");
        },
      }),
    ).toThrow("does not match");
    expect(existsSync(join(root, ".tenkacloud/catalog-store/selected.json"))).toBe(false);
  }));
function fixture(run: (root: string, fetcher: GitArchiveFetcher) => void) {
  const root = mkdtempSync(join(tmpdir(), "downloaded-catalog-"));
  const fetcher: GitArchiveFetcher = (request) => {
    const id = new URL(request.repositoryUrl).pathname.slice(1, -4);
    const directory = join(request.destinationDir, "challenges", id);
    mkdirSync(join(request.destinationDir, "challenges"));
    cpSync(join(repository, "problems/challenges/sqli-demo"), directory, { recursive: true });
    const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
    writeFileSync(join(directory, "metadata.json"), JSON.stringify({ ...metadata, id, name: id }));
    writeFileSync(join(request.destinationDir, "shared.txt"), "shared build input");
    writeFileSync(join(directory, ".runtime-input"), "hidden but pinned input");
    writeFileSync(
      join(request.destinationDir, "package.json"),
      JSON.stringify({ scripts: { postinstall: "touch MUST-NOT-EXECUTE" } }),
    );
  };
  try {
    run(root, fetcher);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("A, B and A+B acquisition, selected runtime and browser views agree without core", () =>
  fixture((root, fetcher) => {
    for (const ids of [["sample-a"], ["sample-b"], ["sample-a", "sample-b"]]) {
      downloadCatalog(root, config(ids), { fetcher });
      expect(existsSync(join(root, "problems"))).toBe(ids[0] !== "sample-a" || ids.length !== 1);
      materializeCatalog(root);
      expect(loadDockerCatalog(root).map((entry) => entry.problemId)).toEqual(ids);
      expect(hostBrowserProblemPaths(root)).toEqual(ids.map((id) => `challenges/${id}`));
      expect(existsSync(join(root, "MUST-NOT-EXECUTE"))).toBe(false);
      expect(selectedCatalogRoots(root)).toHaveLength(ids.length);
    }
  }));

test("reselection and fresh catalog readers retain the saved old Docker definition and source files", () =>
  fixture((root, fetcher) => {
    downloadCatalog(root, config(["sample-a"]), { fetcher });
    const problem = loadDockerCatalog(root)[0];
    if (!problem) throw new Error("Expected A");
    const job: Job = {
      jobId: "old",
      eventId: "event",
      teamId: "team",
      problemId: problem.problemId,
      definition: problem.definition,
      offset: 1000,
      status: "PENDING",
      unit: null,
    };
    const old = dockerDefinitionOf(job, true);
    downloadCatalog(root, config(["sample-b"]), { fetcher });
    materializeCatalog(root);
    expect(loadDockerCatalog(root).map((entry) => entry.problemId)).toEqual(["sample-b"]);
    expect(dockerDefinitionOf(job, true).problem.problemDir).toBe(old.problem.problemDir);
    expect(readFileSync(join(old.problem.problemDir, ".runtime-input"), "utf8")).toBe(
      "hidden but pinned input",
    );
    if (!old.catalogSnapshot) throw new Error("Expected pinned snapshot");
    writeFileSync(join(old.catalogSnapshot.root, "shared.txt"), "tampered shared input");
    expect(() => dockerDefinitionOf(job, true)).toThrow("pinned catalog snapshot changed");
  }));

test("failed fetch, unsafe source, malformed metadata and duplicate IDs preserve the selected edition", () =>
  fixture((root, fetcher) => {
    downloadCatalog(root, config(["sample-a"]), { fetcher });
    materializeCatalog(root);
    const path = join(root, ".tenkacloud/catalog-store/selected.json");
    const original = readFileSync(path, "utf8");
    expect(() =>
      downloadCatalog(root, config(["sample-b"]), {
        fetcher: () => {
          throw new Error("offline");
        },
      }),
    ).toThrow("offline");
    expect(() => downloadCatalog(root, config(["sample-a", "sample-a"]), { fetcher })).toThrow(
      "Duplicate",
    );
    expect(() =>
      downloadCatalog(
        root,
        { schemaVersion: 1, sources: [{ url: "file:///tmp/pack", ref: revision }] },
        { fetcher },
      ),
    ).toThrow("HTTPS");
    expect(() =>
      downloadCatalog(root, config(["sample-b"]), {
        fetcher: (request) => {
          fetcher(request);
          writeFileSync(join(request.destinationDir, "challenges/sample-b/metadata.json"), "{}");
        },
      }),
    ).toThrow("metadata");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(retainedCatalogRoots(root)).toHaveLength(1);
    expect(loadDockerCatalog(root).map((entry) => entry.problemId)).toEqual(["sample-a"]);
  }));

test("missing selection, escaping lock paths, source tampering and symbolic links fail closed", () =>
  fixture((root, fetcher) => {
    expect(() => selectedCatalogRoots(root)).toThrow();
    expect(() =>
      downloadCatalog(root, config(["sample-a"]), {
        fetcher: (request) => {
          fetcher(request);
          symlinkSync("shared.txt", join(request.destinationDir, "link"));
        },
      }),
    ).toThrow("symbolic link");
    downloadCatalog(root, config(["sample-a"]), { fetcher });
    const path = join(root, ".tenkacloud/catalog-store/selected.json");
    const lock = JSON.parse(readFileSync(path, "utf8"));
    lock.sources[0].problemsRoot = "../../outside";
    writeFileSync(path, JSON.stringify(lock));
    expect(() => selectedCatalogRoots(root)).toThrow("Invalid problems root");
  }));

test("standard SDK packs retain safe dotted/relative roots and need no extra legacy README contract", () => {
  for (const problemsRoot of ["problem.catalog", "./problems"])
    fixture((root) => {
      const fetcher: GitArchiveFetcher = (request) => {
        cpSync(
          join(repository, "scripts/problem-pack/test/fixtures/sample-aws-flag"),
          request.destinationDir,
          {
            recursive: true,
          },
        );
        const manifestPath = join(request.destinationDir, "tenkacloud-pack.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (problemsRoot === "problem.catalog") {
          cpSync(
            join(request.destinationDir, "problems"),
            join(request.destinationDir, problemsRoot),
            { recursive: true },
          );
          rmSync(join(request.destinationDir, "problems"), { recursive: true });
        }
        manifest.problemsRoot = problemsRoot;
        writeFileSync(manifestPath, JSON.stringify(manifest));
      };
      downloadCatalog(root, config(["standard"]), { fetcher });
      expect(selectedCatalogRoots(root)).toHaveLength(1);
      materializeCatalog(root);
      expect(existsSync(join(root, "problems/challenges/sample-flag/metadata.json"))).toBe(true);
    });
});

test("private fetched sources become readable build inputs without executing scripts", () =>
  fixture((root, fetcher) => {
    downloadCatalog(root, config(["readable"]), {
      fetcher: (request) => {
        fetcher(request);
        chmodSync(join(request.destinationDir, "challenges/readable/local/app/server.mjs"), 0o600);
      },
    });
    const source = join(
      String(selectedCatalogRoots(root)[0]),
      "challenges/readable/local/app/server.mjs",
    );
    expect(statSync(source).mode & 0o777).toBe(0o644);
    expect(existsSync(join(root, "MUST-NOT-EXECUTE"))).toBe(false);
  }));

test("executable intent changes the immutable edition and survives filesystem mode resets", () =>
  fixture((root, fetcher) => {
    const download = (executable: boolean) =>
      downloadCatalog(root, config(["mode-bound"]), {
        fetcher: (request) => {
          fetcher(request);
          writeFileSync(join(request.destinationDir, "launch.sh"), "#!/bin/sh\nexit 0\n");
          chmodSync(join(request.destinationDir, "launch.sh"), executable ? 0o700 : 0o600);
        },
      });
    download(false);
    const first = selectedCatalogRoots(root)[0];
    download(true);
    const second = String(selectedCatalogRoots(root)[0]);
    expect(first).not.toBe(second);
    chmodSync(join(second, "launch.sh"), 0o600);
    selectedCatalogRoots(root);
    expect(statSync(join(second, "launch.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(String(first), "launch.sh")).mode & 0o777).toBe(0o644);
  }));

test("an empty repository cannot replace an accepted catalog", () =>
  fixture((root, fetcher) => {
    downloadCatalog(root, config(["accepted"]), { fetcher });
    const previous = selectedCatalogRoots(root);
    expect(() =>
      downloadCatalog(root, config(["empty"]), {
        fetcher: (request) =>
          writeFileSync(join(request.destinationDir, "README.md"), "no problem definitions"),
      }),
    ).toThrow(/no problem/u);
    expect(selectedCatalogRoots(root)).toEqual(previous);
  }));

test("a standard pack requiring another core version preserves the accepted selection", () =>
  fixture((root, fetcher) => {
    downloadCatalog(root, config(["accepted"]), { fetcher });
    const previous = selectedCatalogRoots(root);
    expect(() =>
      downloadCatalog(root, config(["incompatible"]), {
        fetcher: (request) => {
          cpSync(
            join(repository, "scripts/problem-pack/test/fixtures/sample-aws-flag"),
            request.destinationDir,
            {
              recursive: true,
            },
          );
          const file = join(request.destinationDir, "tenkacloud-pack.json");
          const manifest = JSON.parse(readFileSync(file, "utf8"));
          manifest.core = ">=99.0.0";
          writeFileSync(file, JSON.stringify(manifest));
        },
      }),
    ).toThrow("requires core");
    expect(selectedCatalogRoots(root)).toEqual(previous);
  }));

test("catalog lock roots match the dispatch-safe path grammar and normalize leading relative segments", () => {
  const lock = (problemsRoot: string) => ({
    schemaVersion: 1,
    sources: [
      {
        url: "https://example.invalid/pack.git",
        ref: revision,
        commit: revision,
        digest: "a".repeat(64),
        problemsRoot,
      },
    ],
  });
  for (const root of [".", "./problems", "././problem.catalog/nested-root", ".catalog/problems"])
    expect(CatalogLockSchema.safeParse(lock(root)).success).toBe(true);
  expect(CatalogLockSchema.parse(lock("./problems")).sources[0]?.problemsRoot).toBe("problems");
  for (const root of [
    "problem catalog",
    "catalog;v1",
    "catalog\\v1",
    "a/../b",
    "a/./b",
    "/problems",
    "a//b",
    "",
  ])
    expect(CatalogLockSchema.safeParse(lock(root)).success).toBe(false);
});

test("unsafe standard pack roots cannot replace an accepted catalog selection", () =>
  fixture((root, fetcher) => {
    downloadCatalog(root, config(["accepted"]), { fetcher });
    const previous = readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8");
    for (const problemsRoot of ["problem catalog", "catalog;v1"]) {
      expect(() =>
        downloadCatalog(root, config(["unsafe"]), {
          fetcher: ({ destinationDir }) => {
            cpSync(
              join(repository, "scripts/problem-pack/test/fixtures/sample-aws-flag"),
              destinationDir,
              { recursive: true },
            );
            cpSync(join(destinationDir, "problems"), join(destinationDir, problemsRoot), {
              recursive: true,
            });
            rmSync(join(destinationDir, "problems"), { recursive: true });
            const path = join(destinationDir, "tenkacloud-pack.json");
            const manifest = JSON.parse(readFileSync(path, "utf8"));
            writeFileSync(path, JSON.stringify({ ...manifest, problemsRoot }));
          },
        }),
      ).toThrow("Invalid problems root");
      expect(readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8")).toBe(
        previous,
      );
    }
  }));

test("a moved tag that no longer matches catalog-lock.json is refused", () =>
  fixture((root, fetcher) => {
    const tagged = {
      schemaVersion: 1,
      sources: [{ url: "https://example.invalid/sample-a.git", ref: "v1" }],
    };
    downloadCatalog(root, tagged, { fetcher, resolveRef: () => revision });
    const selected = CatalogLockSchema.parse(
      JSON.parse(readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8")),
    );
    writeFileSync(
      join(root, "catalog-lock.json"),
      JSON.stringify({ schemaVersion: 1, sources: selected.sources }),
    );
    expect(() => verifyCatalogLock(root)).not.toThrow();
    downloadCatalog(root, tagged, { fetcher, resolveRef: () => "b".repeat(40) });
    expect(() => verifyCatalogLock(root)).toThrow("differs from catalog-lock.json");
  }));

test("fresh acquisition restores pinned retained snapshots without offering old problems", () =>
  fixture((root, fetcher) => {
    downloadCatalog(root, config(["sample-a"]), { fetcher });
    const old = CatalogLockSchema.parse(
      JSON.parse(readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8")),
    ).sources[0];
    rmSync(join(root, ".tenkacloud"), { recursive: true, force: true });
    const selection = { ...config(["sample-b"]), retained: [old] };
    downloadCatalog(root, selection, { fetcher });
    materializeCatalog(root);
    expect(loadDockerCatalog(root).map((entry) => entry.problemId)).toEqual(["sample-b"]);
    expect(hostBrowserProblemPaths(root)).toEqual(["challenges/sample-b"]);
    expect(retainedCatalogRoots(root)).toHaveLength(2);
    const lock = join(root, ".tenkacloud/catalog-store/selected.json");
    const original = readFileSync(lock, "utf8");
    for (const patch of [
      { digest: "0".repeat(64) },
      { commit: "b".repeat(40) },
      { problemsRoot: "missing" },
    ]) {
      expect(() =>
        downloadCatalog(root, { ...selection, retained: [{ ...old, ...patch }] }, { fetcher }),
      ).toThrow("Retained catalog revision does not match");
      expect(readFileSync(lock, "utf8")).toBe(original);
    }
    writeFileSync(
      join(root, "catalog-lock.json"),
      JSON.stringify({ schemaVersion: 1, sources: JSON.parse(original).sources, retained: [old] }),
    );
    expect(() => verifyCatalogLock(root)).not.toThrow();
    writeFileSync(lock, JSON.stringify({ ...JSON.parse(original), retained: [] }));
    expect(() => verifyCatalogLock(root)).toThrow("differs from catalog-lock.json");
  }));
