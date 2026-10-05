import { describe, expect, it } from "vitest";
import { parsePackManifest } from "../src/manifest.js";
import { VALID_MANIFEST } from "./fixtures.js";

describe("pack manifest diagnostics after schema migration", () => {
  it("preserves indexed paths for nested invalid and unknown runtime fields", () => {
    const result = parsePackManifest({
      ...VALID_MANIFEST,
      requiredRuntimes: [{ provider: "aws", engine: 123, unexpected: true }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual([
        "requiredRuntimes[0].engine",
        "requiredRuntimes[0].unexpected",
      ]);
      expect(result.issues[1].message).toBe("unknown field 'unexpected' is not allowed");
    }
  });

  it("rejects duplicate dependencies with the exact offending dependency path", () => {
    const result = parsePackManifest({
      ...VALID_MANIFEST,
      dependencies: [
        { id: "com.example.base", range: "^1.0.0" },
        { id: "com.example.base", range: "^2.0.0" },
      ],
    });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: "dependencies[1].id", message: "duplicate dependency id com.example.base" }],
    });
  });

  it("accepts distinct dependencies without altering their ranges", () => {
    const dependencies = [
      { id: "com.example.base", range: "^1.0.0" },
      { id: "com.example.extra", range: "^2.0.0" },
    ];
    const result = parsePackManifest({ ...VALID_MANIFEST, dependencies });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.dependencies).toEqual(dependencies);
  });
});
