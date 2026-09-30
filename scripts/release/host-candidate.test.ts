import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureCandidate, HostCandidateSchema } from "./host-candidate";

const source = "a".repeat(40);
const catalog = "b".repeat(40);
const input = {
  tag: "tenkacloud-host:review",
  platformCommit: source,
  catalogCommit: catalog,
  inspection: [
    {
      Id: `sha256:${"c".repeat(64)}`,
      RepoTags: ["tenkacloud-host:review"],
      RepoDigests: [],
      Config: {
        Labels: {
          "org.opencontainers.image.revision": source,
          "io.tenkacloud.catalog.revision": catalog,
        },
      },
    },
  ],
};
test("a local candidate records the exact image and source pins without claiming publication", () => {
  const result = captureCandidate(input);
  expect(result.status).toBe("unpublished");
  expect(result.image).toEqual({
    tag: input.tag,
    imageId: `sha256:${"c".repeat(64)}`,
    registryDigests: [],
  });
  expect(result.sources).toEqual({ platformCommit: source, catalogCommit: catalog });
});
test("local RepoDigests metadata does not promote an image to a published release", () => {
  const repoDigest = `tenkacloud-host@sha256:${"c".repeat(64)}`;
  const result = captureCandidate({
    ...input,
    inspection: input.inspection.map((image) => ({ ...image, RepoDigests: [repoDigest] })),
  });
  expect(result.image?.registryDigests).toEqual([repoDigest]);
  expect(result.status).toBe("unpublished");
  expect(result.limitations).toContain(
    "imageId is Docker inspect Id; registryDigests copies Docker RepoDigests. Neither field proves registry publication.",
  );
});
test("candidate capture rejects a stale source, catalog or tag", () => {
  expect(() => captureCandidate({ ...input, platformCommit: "d".repeat(40) })).toThrow("labels");
  expect(() => captureCandidate({ ...input, catalogCommit: "e".repeat(40) })).toThrow("labels");
  expect(() => captureCandidate({ ...input, tag: "unrelated:latest" })).toThrow("tag");
});
test("pending and built candidate identities cannot be mixed or promoted by changing status", () => {
  const built = captureCandidate(input);
  expect(
    HostCandidateSchema.safeParse({ ...built, sources: { ...built.sources, platformCommit: null } })
      .success,
  ).toBe(false);
  expect(HostCandidateSchema.safeParse({ ...built, status: "published" }).success).toBe(false);
  expect(
    HostCandidateSchema.safeParse({ ...built, image: { ...built.image, imageId: "latest" } })
      .success,
  ).toBe(false);
});

test("scheduled catalog sync installs locked dependencies before running the candidate script", () => {
  const root = resolve(import.meta.dir, "../..");
  const workflow = readFileSync(join(root, ".github/workflows/submodule-sync.yml"), "utf8");
  const install = workflow.indexOf("uses: ./.github/actions/bun-install");
  const sync = workflow.indexOf("bun run scripts/release/host-candidate.ts --sync-catalog");
  expect(install).toBeGreaterThan(workflow.indexOf("id: bump"));
  expect(sync).toBeGreaterThan(install);
  expect(readFileSync(join(root, ".github/actions/bun-install/action.yml"), "utf8")).toContain(
    "run: make install_ci",
  );
  expect(readFileSync(join(root, "Makefile"), "utf8")).toMatch(
    /install_ci:[^\n]*\n\tbun install --frozen-lockfile --ignore-scripts/u,
  );
});

test("the real sync CLI uses the staged catalog pin with automatic package installation disabled", () => {
  const root = resolve(import.meta.dir, "../..");
  const fixture = mkdtempSync(join(tmpdir(), "host-candidate-sync-"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  try {
    mkdirSync(join(fixture, "scripts/release"), { recursive: true });
    mkdirSync(join(fixture, "release"));
    copyFileSync(
      join(root, "scripts/release/host-candidate.ts"),
      join(fixture, "scripts/release/host-candidate.ts"),
    );
    symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
    const candidate = {
      schemaVersion: 1,
      status: "unpublished",
      sources: { platformCommit: null, catalogCommit: source },
      image: null,
      limitations: ["Not published"],
    };
    const candidatePath = join(fixture, "release/host-candidate.json");
    writeFileSync(candidatePath, JSON.stringify(candidate));
    const history = "historical v1.11.0 release identity\n";
    writeFileSync(join(fixture, "release/tenkacloud-release.json"), history);
    const git = (...args: string[]) =>
      execFileSync("/usr/bin/git", args, { cwd: fixture, env: environment, stdio: "pipe" });
    git("init", "--quiet");
    git("update-index", "--add", "--cacheinfo", `160000,${catalog},problems`);
    execFileSync(
      process.execPath,
      ["--no-install", "run", "scripts/release/host-candidate.ts", "--sync-catalog"],
      { cwd: fixture, env: environment, stdio: "pipe" },
    );
    expect(JSON.parse(readFileSync(candidatePath, "utf8"))).toEqual({
      ...candidate,
      sources: { platformCommit: null, catalogCommit: catalog },
    });
    expect(readFileSync(join(fixture, "release/tenkacloud-release.json"), "utf8")).toBe(history);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
