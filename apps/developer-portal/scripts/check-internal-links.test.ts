import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allRoutes } from "../src/lib/routes";
import { findBrokenLinks } from "./check-internal-links";

function writeTemp(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "links-"));
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe("internal link checker", () => {
  const routes = allRoutes();

  it("should fail the build when an internal link points at a non-existent route", () => {
    const file = writeTemp("page.tsx", `<a href="/developers/does-not-exist/">dead</a>`);
    const problems = findBrokenLinks([file], routes);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.href).toBe("/developers/does-not-exist/");
  });

  it("should pass for links that resolve to known routes", () => {
    const file = writeTemp("page.tsx", `<a href="/developers/api/">api</a>`);
    expect(findBrokenLinks([file], routes)).toEqual([]);
  });

  it("should detect broken links in markdown link syntax", () => {
    const file = writeTemp("page.mdx", `See [missing](/developers/ghost/).`);
    expect(findBrokenLinks([file], routes)).toHaveLength(1);
  });

  it("should ignore external links and in-page anchors", () => {
    const file = writeTemp(
      "page.tsx",
      `<a href="https://bun.sh">ext</a><a href="#prerequisites">anchor</a>`,
    );
    expect(findBrokenLinks([file], routes)).toEqual([]);
  });

  it("should accept a hashed link to a known route", () => {
    const file = writeTemp("page.tsx", `<a href="/developers/api/#listPacks">op</a>`);
    expect(findBrokenLinks([file], routes)).toEqual([]);
  });
});
