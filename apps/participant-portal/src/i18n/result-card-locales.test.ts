import { describe, expect, it } from "vitest";
import { resultCardLocaleMessages } from "./result-card-locales";

describe("Result Card locale messages", () => {
  it("keeps Japanese and English keys in parity", () => {
    expect(Object.keys(resultCardLocaleMessages.ja).sort()).toEqual(
      Object.keys(resultCardLocaleMessages.en).sort(),
    );
  });

  it("states the privacy and LIVE-result contract in both locales", () => {
    expect(resultCardLocaleMessages.ja.description).toContain("認証情報");
    expect(resultCardLocaleMessages.en.description.toLowerCase()).toContain("credentials");
    expect(resultCardLocaleMessages.ja.live_note).toContain("最終順位ではありません");
    expect(resultCardLocaleMessages.en.live_note.toLowerCase()).toContain("not a final result");
  });
});
