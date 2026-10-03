import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogProjection, catalogTemplatePath } from "../../catalog-projection";
import { buildEffectiveCatalog, composeCatalogDetails } from "../../src/data/effective-catalog";
import {
  buildCoreInputs,
  buildPackDetails,
  metadataToDetail,
  PROBLEM_CATALOG,
  type ProblemDetail,
  type ProblemMetadata,
} from "../../src/data/problems";

const rawMetadata = import.meta.glob<{ default: ProblemMetadata }>(
  "../../../../problems/*/*/metadata.json",
  { eager: true },
);
const rawTemplates = import.meta.glob<string>("../../../../problems/*/*/*.yaml", {
  eager: true,
  import: "default",
  query: "?raw",
});
const metadata: ProblemMetadata = {
  id: "sample",
  name: "Sample",
  category: "Challenge",
  status: "ready",
  difficulty: 2,
  estimatedDuration: "30m",
  shortDescription: "Summary",
  description: "Details",
  tags: ["aws"],
  exposedPorts: [],
  learningGoals: ["Learn"],
  cfnTemplate: "template.yaml",
};
const template = "Resources:\n  Cache:\n    Type: AWS::ElastiCache::CacheCluster\n";
const temporaryDirectories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "admin-catalog-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "template.yaml"), template);
  return join(directory, "metadata.json");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function project(plugin: Plugin, source: string, id: string, addWatchFile = vi.fn()) {
  const transform = plugin.transform;
  if (typeof transform !== "function") throw new Error("Expected a transform function");
  const context = { addWatchFile };
  return transform.call(context as never, source, id) as { code: string } | null;
}

function requiredProjection(plugin: Plugin, source: string, id: string, addWatchFile = vi.fn()) {
  const result = project(plugin, source, id, addWatchFile);
  if (!result) throw new Error(`Missing catalog projection for ${id}`);
  return result;
}

describe("build-time problem catalog", () => {
  it("preserves every checked-out core detail and cost summary byte for byte", () => {
    const expected = buildEffectiveCatalog({
      core: buildCoreInputs(rawMetadata, rawTemplates),
      packs: [],
    });
    // Installed packs are tested below without changing the checkout's pack store.
    expect(JSON.stringify(PROBLEM_CATALOG.filter((problem) => problem.source !== "pack"))).toBe(
      JSON.stringify(expected),
    );
  });

  it("emits only the detail projection and watches the cost template", () => {
    const path = fixture();
    const addWatchFile = vi.fn();
    const source = JSON.stringify({
      ...metadata,
      answers: "private-answer",
      cfnParameters: { Private: "private-value" },
    });
    const result = requiredProjection(
      catalogProjection(),
      source,
      `${path}?catalog-detail`,
      addWatchFile,
    );
    expect(JSON.parse(result.code)).toEqual(metadataToDetail(metadata, template));
    expect(result.code).not.toContain("private-");
    expect(result.code).not.toContain("Resources:");
    expect(addWatchFile).toHaveBeenCalledWith(join(path, "..", "template.yaml"));
  });

  it("does not alter ordinary metadata imports or parse non-AWS artifacts", () => {
    const path = fixture();
    const plugin = catalogProjection();
    expect(project(plugin, JSON.stringify(metadata), path)).toBeNull();
    const nonAws = {
      ...metadata,
      runtime: { provider: "gcp", engine: "infra-manager", entry: "template.yaml" },
    };
    writeFileSync(join(path, "..", "template.yaml"), "not: [valid yaml");
    expect(
      JSON.parse(requiredProjection(plugin, JSON.stringify(nonAws), `${path}?catalog-detail`).code)
        .costEstimate,
    ).toBeUndefined();
  });

  it("does not reintroduce private metadata or templates after host sanitization", () => {
    const path = "/repo/problems/challenges/hello-world/metadata.json?catalog-detail";
    // Shape supplied by publicMetadata: execution inputs and private fields are absent.
    // The host's boundary tests independently verify that allowlist.
    const sanitized = JSON.stringify({
      id: "hello-world",
      name: "Hello",
      category: "Challenge",
      status: "ready",
      difficulty: 2,
      estimatedDuration: "30m",
      shortDescription: "Summary",
      tags: [],
      learningGoals: [],
      runtime: {},
    });
    const addWatchFile = vi.fn();
    const detail = JSON.parse(
      requiredProjection(catalogProjection(), sanitized, path, addWatchFile).code,
    );
    expect(detail.description).toBeUndefined();
    expect(detail.learningGoals).toEqual([]);
    expect(detail.costEstimate).toBeUndefined();
    expect(addWatchFile).not.toHaveBeenCalled();
  });

  it("refreshes the metadata module and cost summary when its template changes", () => {
    const path = fixture();
    const id = `${path}?catalog-detail`;
    const plugin = catalogProjection();
    requiredProjection(plugin, JSON.stringify(metadata), id);
    const file = join(path, "..", "template.yaml");
    writeFileSync(file, "Resources:\n  Queue:\n    Type: AWS::SQS::Queue\n");
    const updated = JSON.parse(requiredProjection(plugin, JSON.stringify(metadata), id).code);
    expect(updated.costEstimate.resourceTypes).toEqual(["AWS::SQS::Queue"]);
    const module = { id };
    const update = {
      file,
      modules: [],
      server: { moduleGraph: { getModuleById: () => module } },
    };
    const hook = plugin.handleHotUpdate;
    const context = {};
    if (typeof hook !== "function") throw new Error("Expected a hot update hook");
    expect(hook.call(context as never, update as never)).toEqual([module]);
    update.file = "/unrelated.yaml";
    expect(hook.call(context as never, update as never)).toBeUndefined();
  });

  it("omits a missing template but fails a malformed executable template", () => {
    const path = fixture();
    const plugin = catalogProjection();
    const source = JSON.stringify(metadata);
    const file = join(path, "..", "template.yaml");
    writeFileSync(file, "not: [valid yaml");
    expect(() => requiredProjection(plugin, source, `${path}?catalog-detail`)).toThrow();
    rmSync(file);
    expect(
      JSON.parse(requiredProjection(plugin, source, `${path}?catalog-detail`).code).costEstimate,
    ).toBeUndefined();
  });

  it("matches the former core and recursive pack template glob boundaries", () => {
    const core = "/repo/problems/challenges/a/metadata.json";
    const pack = "/repo/.tenkacloud/pack-store/snapshots/p/r/challenges/a/metadata.json";
    const nested = {
      ...metadata,
      runtime: { provider: "aws", engine: "cloudformation", entry: "nested/template.yaml" },
    };
    expect(catalogTemplatePath(nested, core)).toBeUndefined();
    expect(catalogTemplatePath(nested, pack)).toBe(join(pack, "..", "nested/template.yaml"));
    expect(
      catalogTemplatePath({ ...metadata, cfnTemplate: "../template.yaml" }, pack),
    ).toBeUndefined();
    expect(catalogTemplatePath({ ...metadata, cfnTemplate: "template.yml" }, core)).toBeUndefined();
  });

  it("preserves installed-pack provenance, orphan exclusion, and duplicate rejection", () => {
    const base = "/repo/.tenkacloud/pack-store/snapshots/p/r/";
    const detail = metadataToDetail(metadata, template);
    const modules = { [`${base}challenges/sample/metadata.json`]: { default: detail } };
    const manifests = {
      [`${base}tenkacloud-pack.json`]: {
        default: { id: "org.pack", version: "1.0.0", license: "MIT" },
      },
    };
    const packs = buildPackDetails(modules, manifests);
    expect(packs[0]).toEqual({
      ...detail,
      source: "pack",
      packId: "org.pack",
      packVersion: "1.0.0",
      license: "MIT",
    });
    expect(buildPackDetails(modules, {})).toEqual([]);
    expect(() => composeCatalogDetails({ core: [detail], packs })).toThrow(
      "core and pack 'org.pack@1.0.0'",
    );
    expect(() => composeCatalogDetails({ core: [], packs: [...packs, ...packs] })).toThrow(
      "DUPLICATE_PROBLEM_ID",
    );
    const local: ProblemDetail = { ...detail, runtime: { provider: "docker", engine: "compose" } };
    expect(composeCatalogDetails({ core: [local], packs: [] })).toEqual([]);
    expect(composeCatalogDetails({ core: [local], packs: [], includeLocalOnly: true })).toEqual([
      local,
    ]);
  });
});
