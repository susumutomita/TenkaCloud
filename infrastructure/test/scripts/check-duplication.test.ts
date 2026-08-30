import { describe, expect, it } from "vitest";
import {
  aggregateDuplicatedLines,
  areaOf,
  type Clone,
  compareToBaseline,
  largestClonesTouching,
} from "../../../scripts/quality/check-duplication";

/**
 * jscpd ベースライン・ラチェットの純粋部分を pin する。 方針: 重複ゼロを強制しない
 * (責務分離のための意図的重複は baseline に焼き込む) が、 baseline を超える新しい
 * コピペはどの area で増えたかまで特定して落とす。
 */

function clone(first: string, second: string, lines: number): Clone {
  return {
    firstFile: { name: first, start: 1, end: lines },
    secondFile: { name: second, start: 10, end: 10 + lines },
    lines,
    format: "typescript",
  };
}

describe("areaOf", () => {
  it("should map apps and packages to their per-workspace area", () => {
    expect(areaOf("apps/participant-portal/src/config.ts")).toBe("apps/participant-portal");
    expect(areaOf("packages/web-kit/src/markdown.tsx")).toBe("packages/web-kit");
  });

  it("should map everything else to its top-level directory", () => {
    expect(areaOf("infrastructure/lib/app-config/resolve.ts")).toBe("infrastructure");
    expect(areaOf("scripts/local-play/api.ts")).toBe("scripts");
    expect(areaOf(".github/workflows/ci.yml")).toBe(".github");
  });
});

describe("aggregateDuplicatedLines", () => {
  it("should credit a clone's lines to both endpoint areas", () => {
    const totals = aggregateDuplicatedLines([
      clone("apps/admin-console/src/a.ts", "apps/participant-portal/src/b.ts", 12),
    ]);
    expect(totals).toEqual({ "apps/admin-console": 12, "apps/participant-portal": 12 });
  });

  it("should count a same-area clone twice within that area", () => {
    const totals = aggregateDuplicatedLines([
      clone("scripts/a.ts", "scripts/b.ts", 7),
      clone("scripts/c.ts", "infrastructure/lib/d.ts", 3),
    ]);
    expect(totals).toEqual({ scripts: 17, infrastructure: 3 });
  });
});

describe("compareToBaseline", () => {
  it("should flag only areas above the baseline and treat unknown areas as zero", () => {
    const { regressions, improvements } = compareToBaseline(
      { scripts: 20, infrastructure: 5, "apps/new-app": 4 },
      { scripts: 20, infrastructure: 8 },
    );
    expect(regressions).toEqual([{ area: "apps/new-app", baseline: 0, actual: 4 }]);
    expect(improvements).toEqual([{ area: "infrastructure", baseline: 8, actual: 5 }]);
  });

  it("should report nothing when every area matches the baseline exactly", () => {
    const { regressions, improvements } = compareToBaseline({ scripts: 9 }, { scripts: 9 });
    expect(regressions).toEqual([]);
    expect(improvements).toEqual([]);
  });
});

describe("largestClonesTouching", () => {
  it("should return the biggest clones touching the area, capped at the limit", () => {
    const clones = [
      clone("scripts/a.ts", "scripts/b.ts", 5),
      clone("scripts/c.ts", "apps/admin-console/src/d.ts", 30),
      clone("infrastructure/lib/e.ts", "infrastructure/lib/f.ts", 50),
      clone("scripts/g.ts", "scripts/h.ts", 12),
    ];
    const top = largestClonesTouching(clones, "scripts", 2);
    expect(top.map((c) => c.lines)).toEqual([30, 12]);
  });
});
