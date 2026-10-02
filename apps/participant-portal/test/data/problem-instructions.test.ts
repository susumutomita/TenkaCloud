import { describe, expect, it, vi } from "vitest";

describe("bundled problem instructions", () => {
  it("keeps instructions out of eager cards, loads one existing problem, and leaves missing problems absent", async () => {
    vi.resetModules();
    const catalog = await import("../../src/data/problems");
    const entry = catalog.findProblemMetadata("hello-world");
    expect(entry).toBeDefined();
    expect(entry?.instructions).toBeUndefined();
    expect(entry?.i18n?.en?.instructions).toBeUndefined();
    const instructions = await catalog.loadProblemInstructions("hello-world");
    expect(instructions?.instructions?.length).toBeGreaterThan(0);
    expect(await catalog.loadProblemInstructions("not-in-catalog")).toBeUndefined();
  });

  it("discards a bundled response when runtime hydration changes the source while it is pending", async () => {
    vi.resetModules();
    const catalog = await import("../../src/data/problems");
    const entry = catalog.findProblemMetadata("hello-world");
    if (!entry) throw new Error("Fixture problem is absent");
    const pending = catalog.loadProblemInstructions("hello-world");
    catalog.hydrateProblemCatalog([{ ...entry, instructions: "New authorized runtime text" }]);
    expect(await pending).toBeUndefined();
    expect(catalog.findProblemMetadata("hello-world")?.instructions).toBe(
      "New authorized runtime text",
    );
  });

  it("never substitutes bundled instructions for an authenticated runtime catalog", async () => {
    vi.resetModules();
    const catalog = await import("../../src/data/problems");
    const entry = catalog.findProblemMetadata("hello-world");
    if (!entry) throw new Error("Fixture problem is absent");
    catalog.hydrateProblemCatalog([{ ...entry, instructions: "Authorized runtime text" }]);
    expect(await catalog.loadProblemInstructions("hello-world")).toBeUndefined();
    expect(catalog.findProblemMetadata("hello-world")?.instructions).toBe(
      "Authorized runtime text",
    );
  });
});
