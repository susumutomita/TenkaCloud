import { describe, expect, it } from "vitest";
import {
  stripProblemWriteups,
  collectProblemWriteups,
  containsProblemWriteup,
  stripProblemWriteupsPlugin,
} from "../../build/strip-problem-writeups";

describe("stripProblemWriteups (#2191 spoiler boundary)", () => {
  it("removes JA and EN writeups while preserving safe metadata", () => {
    const transformed = stripProblemWriteups(
      JSON.stringify({
        id: "sqli-demo",
        name: "Safe title",
        writeup: "JA spoiler",
        i18n: { en: { name: "Safe title EN", writeup: "EN spoiler" } },
      }),
      "/repo/problems/challenges/sqli-demo/metadata.json",
    );

    expect(transformed).not.toContain("JA spoiler");
    expect(transformed).not.toContain("EN spoiler");
    expect(JSON.parse(transformed ?? "{}")).toEqual({
      id: "sqli-demo",
      name: "Safe title",
      i18n: { en: { name: "Safe title EN" } },
    });
  });

  it("removes nested checkpoint JA/EN prose before bundling while retaining safe labels", () => {
    const metadata = {
      scoring: { kind: "multi-verify", checks: [{ id: "one", label: "One", writeup: "JA checkpoint secret" }] },
      i18n: { en: { checks: [{ id: "one", label: "One EN", writeup: "EN checkpoint secret" }] } },
    };
    expect(collectProblemWriteups(metadata)).toEqual(["JA checkpoint secret", "EN checkpoint secret"]);
    const transformed = stripProblemWriteups(JSON.stringify(metadata), "/repo/problems/challenges/one/metadata.json");
    expect(transformed).not.toContain("checkpoint secret");
    expect(transformed).toContain("One EN");
    expect(collectProblemWriteups(JSON.parse(transformed ?? "{}"))).toEqual([]);
  });

  it("detects both raw prose and escaped JavaScript literals in built assets", () => {
    const prose = '## Checkpoint\n\nRead the "message" field.';
    expect(containsProblemWriteup(prose, prose)).toBe(true);
    expect(containsProblemWriteup(`const hidden = ${JSON.stringify(prose)}`, prose)).toBe(true);
    expect(containsProblemWriteup("const safe = 1;", prose)).toBe(false);
  });

  it("ignores non-catalog JSON and metadata without writeups", () => {
    expect(stripProblemWriteups('{"writeup":"keep"}', "/src/fixture.json")).toBeNull();
    expect(
      stripProblemWriteups('{"id":"safe"}', "/repo/problems/challenges/safe/metadata.json"),
    ).toBeNull();
  });

  it("registers the spoiler stripping transform before Vite's JSON plugin", () => {
    expect(stripProblemWriteupsPlugin()).toEqual({
      name: "tenkacloud-strip-problem-writeups",
      enforce: "pre",
      transform: stripProblemWriteups,
    });
  });
});
