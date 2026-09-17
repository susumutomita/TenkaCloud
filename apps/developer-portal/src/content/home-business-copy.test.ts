import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n";
import { BUSINESS_HOME_COPY } from "./home-business-copy";

function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { length: value.length, items: value.map(shapeOf) };
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]),
    );
  }
  return typeof value;
}

function assertNoEmptyStrings(value: unknown, path: string): void {
  if (typeof value === "string") {
    expect(value.trim().length, `empty string at ${path}`).toBeGreaterThan(0);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmptyStrings(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNoEmptyStrings(child, `${path}.${key}`);
    }
  }
}

describe("business-first marketing copy", () => {
  it("should expose exactly the supported locales", () => {
    expect(Object.keys(BUSINESS_HOME_COPY).sort()).toEqual([...LOCALES].sort());
  });

  it("should keep Japanese and English structurally identical", () => {
    expect(shapeOf(BUSINESS_HOME_COPY.ja)).toEqual(shapeOf(BUSINESS_HOME_COPY.en));
  });

  it("should pin the decision narrative card counts", () => {
    for (const locale of LOCALES) {
      const copy = BUSINESS_HOME_COPY[locale];
      expect(copy.problems.items).toHaveLength(3);
      expect(copy.economics.items).toHaveLength(4);
      expect(copy.stakeholders.items).toHaveLength(4);
      expect(copy.useCases.items).toHaveLength(4);
      expect(copy.operations.steps).toHaveLength(4);
    }
  });

  it("should never ship an empty copy field", () => {
    assertNoEmptyStrings(BUSINESS_HOME_COPY, "BUSINESS_HOME_COPY");
  });
});
