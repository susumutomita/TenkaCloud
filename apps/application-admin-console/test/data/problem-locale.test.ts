import { describe, expect, it } from "vitest";
import { localizeOptionalProblem, localizeProblemText } from "../../src/data/problem-locale";

describe("authored problem translations", () => {
  const japanese = {
    id: "stable-id",
    name: "問題",
    shortDescription: "要約",
    description: "本文",
    estimatedDuration: "30 分",
    learningGoals: ["目標"],
  };
  it("keeps Japanese and missing English fields without changing identity", () => {
    expect(localizeProblemText(japanese, "en")).toBe(japanese);
    const partial = {
      ...japanese,
      i18n: { en: { name: "Problem", shortDescription: "", description: "  " } },
    };
    expect(localizeProblemText(partial, "ja")).toBe(partial);
    expect(localizeProblemText(partial, "en")).toMatchObject({
      id: "stable-id",
      name: "Problem",
      shortDescription: "要約",
      description: "本文",
      estimatedDuration: "30 分",
      learningGoals: ["目標"],
    });
    expect(partial.name).toBe("問題");
  });
  it("uses existing English narrative and duration fields", () => {
    const translated = {
      ...japanese,
      i18n: {
        en: {
          name: "Problem",
          shortDescription: "Summary",
          description: "Body",
          estimatedDuration: "30 minutes",
          learningGoals: ["Goal"],
        },
      },
    };
    expect(localizeProblemText(translated, "en")).toMatchObject({
      id: "stable-id",
      name: "Problem",
      shortDescription: "Summary",
      description: "Body",
      estimatedDuration: "30 minutes",
      learningGoals: ["Goal"],
    });
    expect(localizeOptionalProblem(translated, "en")?.name).toBe("Problem");
    expect(localizeOptionalProblem(undefined, "en")).toBeUndefined();
  });
});
