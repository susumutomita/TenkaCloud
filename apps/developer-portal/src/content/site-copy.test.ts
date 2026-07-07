import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n";
import { CATALOG_COPY, HOME_COPY } from "./site-copy";

// The marketing home and catalog render from one bilingual model. TypeScript already
// forces both locales to share a shape; these tests additionally pin the array
// lengths (which the type system does not) and forbid empty strings, so a JA/EN
// parity gap or a blank field fails here rather than shipping.

// Recursively collect the "shape" of an object: sorted keys at every level and array
// lengths, so two locales can be compared for structural parity.
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { length: value.length, items: value.map(shapeOf) };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, shapeOf((value as Record<string, unknown>)[key])] as const);
    return Object.fromEntries(entries);
  }
  return typeof value;
}

function assertNoEmptyStrings(value: unknown, path: string): void {
  if (typeof value === "string") {
    expect(value.trim().length, `empty string at ${path}`).toBeGreaterThan(0);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoEmptyStrings(item, `${path}[${index}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNoEmptyStrings(child, `${path}.${key}`);
    }
  }
}

describe("site copy parity", () => {
  it("should expose exactly the ja and en locales", () => {
    expect(Object.keys(HOME_COPY).sort()).toEqual([...LOCALES].sort());
    expect(Object.keys(CATALOG_COPY).sort()).toEqual([...LOCALES].sort());
  });

  it("should have structurally identical home copy across locales", () => {
    expect(shapeOf(HOME_COPY.ja)).toEqual(shapeOf(HOME_COPY.en));
  });

  it("should have structurally identical catalog copy across locales", () => {
    expect(shapeOf(CATALOG_COPY.ja)).toEqual(shapeOf(CATALOG_COPY.en));
  });

  it("should carry three offerings, three audiences, and three onboarding steps", () => {
    for (const locale of LOCALES) {
      expect(HOME_COPY[locale].offerings.tiers).toHaveLength(3);
      expect(HOME_COPY[locale].audiences.items).toHaveLength(3);
      expect(HOME_COPY[locale].onboarding.steps).toHaveLength(3);
    }
  });

  it("should keep the catalog-teaser substitution tokens in both locales", () => {
    for (const locale of LOCALES) {
      expect(HOME_COPY[locale].catalog.lead).toContain("{total}");
      expect(HOME_COPY[locale].catalog.lead).toContain("{battle}");
      expect(HOME_COPY[locale].catalog.lead).toContain("{challenge}");
      expect(CATALOG_COPY[locale].lead).toContain("{total}");
      expect(CATALOG_COPY[locale].lead).toContain("{ready}");
    }
  });

  it("should never leave a copy field blank", () => {
    assertNoEmptyStrings(HOME_COPY, "HOME_COPY");
    assertNoEmptyStrings(CATALOG_COPY, "CATALOG_COPY");
  });
});
