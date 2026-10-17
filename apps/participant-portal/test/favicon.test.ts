import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bundled brand favicon", () => {
  for (const entry of ["index.html", "host.html"]) {
    it(`links the Summit icon from ${entry}`, () => {
      const html = readFileSync(`${process.cwd()}/${entry}`, "utf8");
      expect(html).toContain(
        '<link rel="icon" type="image/svg+xml" href="/src/assets/favicon.svg?no-inline" />',
      );
      const icon = readFileSync(`${process.cwd()}/src/assets/favicon.svg`, "utf8");
      expect(icon).toContain("<title>TenkaCloud</title>");
      expect(icon).toContain('d="M26 90 L60 48 L94 90"');
    });
  }
});
