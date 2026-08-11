import { describe, expect, it } from "vitest";
import { noConflictMarkers } from "./no-conflict-markers.ts";

function ctx(files: Record<string, string>) {
  return {
    files: Object.keys(files),
    readFile: (p: string) => files[p] ?? "",
  };
}

describe("noConflictMarkers", () => {
  it("should pass when no conflict markers exist", () => {
    const findings = noConflictMarkers.check(
      ctx({
        "apps/foo/src/bar.ts": "const x = 1;\nconst y = 2;\n",
        "docs/architecture/example.html": "<html><body>ok</body></html>",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should flag a file with <<<<<<< marker", () => {
    const findings = noConflictMarkers.check(
      ctx({
        "apps/foo/src/bar.ts":
          "const x = 1;\n<<<<<<< HEAD\nconst y = 2;\n=======\nconst y = 3;\n>>>>>>> origin/main\n",
      }),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.ruleId).toBe("no-conflict-markers");
    expect(findings[0]?.line).toBe(2);
    expect(findings[0]?.match).toBe("<<<<<<< HEAD");
    expect(findings[0]?.severity).toBe("error");
  });

  it("should flag a file with bare ======= marker", () => {
    const findings = noConflictMarkers.check(
      ctx({
        "docs/foo.md": "intro\n=======\nrest\n",
      }),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.line).toBe(2);
  });

  it("should not confuse markdown setext h1 ====== (= must equal exactly =======) with conflict", () => {
    // markdown の setext heading は通常 5 = or more の連続。 git conflict は厳密に 7 =。
    const findings = noConflictMarkers.check(
      ctx({
        "docs/foo.md": "title\n=====\n\nbody\n",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should skip binary-like extensions (no scan)", () => {
    const findings = noConflictMarkers.check(
      ctx({
        "assets/foo.png": "<<<<<<< not actually conflict\n",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should skip its own test file (= allows literal markers in fixture)", () => {
    const findings = noConflictMarkers.check(
      ctx({
        ".claude/harness/src/rules/no-conflict-markers.test.ts": "<<<<<<< literal in test\n",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should report only the first marker line per file (= 1 finding / file)", () => {
    const findings = noConflictMarkers.check(
      ctx({
        "apps/x.ts": "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> origin/main\n<<<<<<< HEAD\nc\n",
      }),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.line).toBe(1);
  });
});
