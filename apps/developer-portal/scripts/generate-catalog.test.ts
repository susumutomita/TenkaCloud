import { describe, expect, it } from "vitest";
import type { CatalogData } from "../src/content/catalog-data";
import { renderCatalogModule } from "./generate-catalog";

// The catalog module renderer is pure: equal input yields byte-identical output, so
// `bun run check:catalog` never flaps on serialization. (The submodule-reading half,
// buildCatalogData, is exercised by the maintainer check, not by CI — see
// generate-catalog.ts for why a hard drift gate would surprise unrelated PRs.)
const FIXTURE: CatalogData = {
  problems: [
    {
      id: "sample-battle",
      category: "Battle",
      status: "ready",
      difficulty: 2,
      tags: ["uptime", "sample"],
      name: { ja: "サンプル対戦", en: "Sample Battle" },
    },
  ],
};

describe("renderCatalogModule", () => {
  it("should render a deterministic, Biome-formatted module from given data", () => {
    const a = renderCatalogModule(FIXTURE);
    const b = renderCatalogModule(FIXTURE);
    expect(a).toBe(b);
    expect(a).toContain("export const CATALOG_DATA: CatalogData =");
    expect(a).toContain('id: "sample-battle"');
    // Biome formats object keys unquoted.
    expect(a).toContain('category: "Battle"');
  });
});
