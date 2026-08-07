import type { ProblemCatalogEntry } from "@tenkacloud/portal-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import { applyRuntimeProblemCatalog } from "./catalog-source";
import { findProblemMetadata, hydrateProblemCatalog, listProblemCatalog } from "./problems";

vi.mock("../api/portal-client", () => ({ getProblemCatalog: vi.fn() }));
const { getProblemCatalog } = await import("../api/portal-client");
const mockedGetProblemCatalog = vi.mocked(getProblemCatalog);

/**
 * [#2925 / #2926] The Docker local image cannot carry `problems/` — `.dockerignore`
 * excludes it on purpose so the container serves the participant's own bind-mounted clone,
 * which is what lets a participant add a problem without rebuilding the image. The portal's
 * build-time `import.meta.glob` is therefore empty in that image, and every catalog-derived
 * surface went blank with it: problem instructions, learning goals, the endpoint override
 * form, course tracks, and the whole portal plugin system.
 *
 * These tests pin the replacement path — a runtime catalog fetched from the control plane —
 * and, above all, that its failure cannot be mistaken for success. A portal that silently
 * kept an empty catalog would reproduce the exact reported bug while looking healthy.
 */

const ENTRY: ProblemCatalogEntry = {
  id: "wp-exposed-backup",
  name: "Exposed backup",
  category: "Challenge",
  status: "ready",
  visibility: "public",
  difficulty: 2,
  estimatedDuration: "30 min",
  shortDescription: "short",
  instructions: "▶ read the briefing",
  learningGoals: ["goal"],
  tags: [],
  endpoints: [],
  phases: [],
  disruptions: [],
  runtime: { provider: "docker", engine: "compose" },
  graphNodes: [],
  graphRelations: [],
};

const LOCAL_CONFIG: AppConfig = {
  apiBaseUrl: "http://127.0.0.1:5175",
  eventTitle: "TenkaCloud Local",
  eventRegion: "local",
  mode: "backend",
  cloudMode: "local",
  localTeamLoginKey: "k".repeat(43),
};

/** Restore the build-time catalog so hydration in one test cannot leak into another. */
const BUILD_TIME_CATALOG = listProblemCatalog();
afterEach(() => {
  hydrateProblemCatalog(BUILD_TIME_CATALOG);
  vi.clearAllMocks();
});

describe("hydrateProblemCatalog (#2925 / #2926)", () => {
  it("should make runtime entries visible to both the list and the by-id lookup", () => {
    hydrateProblemCatalog([ENTRY]);
    expect(listProblemCatalog().map((e) => e.id)).toEqual([ENTRY.id]);
    expect(findProblemMetadata(ENTRY.id)?.instructions).toBe("▶ read the briefing");
  });

  it("should sort by id so runtime order matches the build-time catalog's contract", () => {
    hydrateProblemCatalog([
      { ...ENTRY, id: "zzz" },
      { ...ENTRY, id: "aaa" },
    ]);
    expect(listProblemCatalog().map((e) => e.id)).toEqual(["aaa", "zzz"]);
  });

  it("should drop entries that are no longer in the catalog it was given", () => {
    hydrateProblemCatalog([ENTRY]);
    hydrateProblemCatalog([]);
    expect(findProblemMetadata(ENTRY.id)).toBeUndefined();
    expect(listProblemCatalog()).toEqual([]);
  });
});

describe("applyRuntimeProblemCatalog (#2925 / #2926)", () => {
  it("should fetch and install the catalog in local mode", async () => {
    mockedGetProblemCatalog.mockResolvedValue([ENTRY]);
    await applyRuntimeProblemCatalog(LOCAL_CONFIG);
    expect(mockedGetProblemCatalog).toHaveBeenCalledWith(
      LOCAL_CONFIG.apiBaseUrl,
      LOCAL_CONFIG.localTeamLoginKey,
    );
    expect(findProblemMetadata(ENTRY.id)).toBeDefined();
  });

  for (const cloudMode of ["real", "mock"] as const) {
    it(`should leave the build-time catalog alone in ${cloudMode} mode`, async () => {
      await applyRuntimeProblemCatalog({ ...LOCAL_CONFIG, cloudMode });
      expect(mockedGetProblemCatalog).not.toHaveBeenCalled();
      expect(listProblemCatalog().map((e) => e.id)).toEqual(BUILD_TIME_CATALOG.map((e) => e.id));
    });
  }

  it("should fail loudly when local runtime config carries no login key", async () => {
    const { localTeamLoginKey: _omitted, ...withoutKey } = LOCAL_CONFIG;
    await expect(applyRuntimeProblemCatalog(withoutKey)).rejects.toThrow(/localTeamLoginKey/);
    expect(mockedGetProblemCatalog).not.toHaveBeenCalled();
  });

  it("should propagate a fetch failure instead of booting with an empty catalog", async () => {
    // The silent-fallback version of this is indistinguishable from the reported bug:
    // a portal that loads, looks fine, and has no instructions on any problem.
    mockedGetProblemCatalog.mockRejectedValue(new Error("control plane unreachable"));
    await expect(applyRuntimeProblemCatalog(LOCAL_CONFIG)).rejects.toThrow(
      "control plane unreachable",
    );
  });
});
