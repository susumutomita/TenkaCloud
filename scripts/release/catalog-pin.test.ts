import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { readCatalogGitlink, stampCatalogPin } from "./catalog-pin";
import { RELEASE_MANIFEST_PATH } from "./manifest";

const COMMITTED_MANIFEST = readFileSync(RELEASE_MANIFEST_PATH, "utf8");
const NEW_GITLINK = "a".repeat(40);

function catalogCommitOf(manifestJson: string): string {
  return (JSON.parse(manifestJson) as { sources: { catalog: { commit: string } } }).sources.catalog
    .commit;
}

describe("release manifest catalog pin", () => {
  it("stamps the catalog commit from the gitlink and leaves everything else byte-identical", () => {
    const stamped = stampCatalogPin(COMMITTED_MANIFEST, NEW_GITLINK);
    expect(catalogCommitOf(stamped)).toBe(NEW_GITLINK);
    expect(stamped.replace(NEW_GITLINK, catalogCommitOf(COMMITTED_MANIFEST))).toBe(
      COMMITTED_MANIFEST,
    );
  });

  it("is idempotent", () => {
    const once = stampCatalogPin(COMMITTED_MANIFEST, NEW_GITLINK);
    expect(stampCatalogPin(once, NEW_GITLINK)).toBe(once);
  });

  it("leaves the platform repository and every other source field untouched", () => {
    const stamped = JSON.parse(stampCatalogPin(COMMITTED_MANIFEST, NEW_GITLINK)) as {
      sources: { platform: unknown; catalog: { repository: string } };
    };
    const committed = JSON.parse(COMMITTED_MANIFEST) as {
      sources: { platform: unknown; catalog: { repository: string } };
    };
    expect(stamped.sources.platform).toEqual(committed.sources.platform);
    expect(stamped.sources.catalog.repository).toBe(committed.sources.catalog.repository);
  });

  it.each([
    "a".repeat(39),
    "A".repeat(40),
    "main",
    "",
  ])("rejects gitlink %s that is not a full lowercase SHA", (gitlink) => {
    expect(() => stampCatalogPin(COMMITTED_MANIFEST, gitlink)).toThrow(
      "not a lowercase full 40-hex commit",
    );
  });

  it("refuses to stamp a manifest whose catalog site was reshaped away", () => {
    const reshaped = COMMITTED_MANIFEST.replace('"catalog": {', '"catalogue": {');
    expect(() => stampCatalogPin(reshaped, NEW_GITLINK)).toThrow(
      "catalog commit site matched 0 times",
    );
  });

  it("rejects a stamped result that is not a valid release manifest", () => {
    const wrongSchema = COMMITTED_MANIFEST.replace('"schemaVersion": 2', '"schemaVersion": 1');
    expect(() => stampCatalogPin(wrongSchema, NEW_GITLINK)).toThrow("$.schemaVersion");
  });

  it("reads the gitlink this repository would commit for problems/", () => {
    expect(readCatalogGitlink()).toMatch(/^[a-f0-9]{40}$/);
  });
});
