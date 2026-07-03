import { describe, expect, it } from "vitest";
import { parseWriteupsEnv } from "../lib/utils/writeup-metadata";

describe("parseWriteupsEnv (#2191)", () => {
  it("accepts only complete non-empty bilingual entries", () => {
    expect(
      parseWriteupsEnv(
        JSON.stringify({
          complete: { ja: "日本語", en: "English" },
          missing: { ja: "日本語" },
          blank: { ja: " ", en: "English" },
        }),
      ),
    ).toEqual({ complete: { ja: "日本語", en: "English" } });
  });

  it("fails closed for absent or malformed JSON", () => {
    expect(parseWriteupsEnv(undefined)).toEqual({});
    expect(parseWriteupsEnv("{broken")).toEqual({});
    expect(parseWriteupsEnv("[]")).toEqual({});
  });
});
