import { describe, expect, it } from "vitest";
import { stripProblemWriteups } from "../../build/strip-problem-writeups";

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

  it("ignores non-catalog JSON and metadata without writeups", () => {
    expect(stripProblemWriteups('{"writeup":"keep"}', "/src/fixture.json")).toBeNull();
    expect(
      stripProblemWriteups('{"id":"safe"}', "/repo/problems/challenges/safe/metadata.json"),
    ).toBeNull();
  });
});
