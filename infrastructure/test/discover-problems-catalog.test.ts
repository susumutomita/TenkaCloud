import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverProblemsCatalog,
  discoverProblemsScoring,
  discoverProblemsVisibility,
} from "../lib/utils/discover-problems-catalog";

/**
 * discoverProblemsCatalog: `problems/<category>/<id>/metadata.json` を 2 階層 scan して
 * `{ [problemId]: problemDir }` map を返す。CDK synth 時に bin/infrastructure.ts から呼ぶ。
 *
 * 設計意図:
 *   - 不正な metadata は silent skip ではなく console.warn に出す (operator が気づける)
 *   - problemsRoot 自体が無い場合も throw せず空 map を返す (synth 時に problems/ を埋める前
 *     に typecheck が走るケースの防御)
 *   - id は metadata.json の `id` field から (ディレクトリ名と乖離した場合 metadata 優先)
 */

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "discover-catalog-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function writeProblem(category: string, dir: string, body: object): void {
  const target = path.join(workspace, category, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "metadata.json"), JSON.stringify(body));
}

describe("discoverProblemsCatalog", () => {
  it("should return all problems with metadata.json as an id → problemDir map", () => {
    writeProblem("challenges", "hello-world", { id: "hello-world" });
    writeProblem("battles", "security-battle-royale", { id: "security-battle-royale" });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({
      "hello-world": "problems/challenges/hello-world",
      "security-battle-royale": "problems/battles/security-battle-royale",
    });
  });

  it("should adopt the metadata id when it differs from the directory name", () => {
    writeProblem("challenges", "physical-dir-name", { id: "logical-id" });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({ "logical-id": "problems/challenges/physical-dir-name" });
  });

  it("should return an empty map and warn when problemsRoot itself does not exist", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = path.join(workspace, "missing-root");

    const catalog = discoverProblemsCatalog(missing);

    expect(catalog).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("not found");
    warn.mockRestore();
  });

  it("should silently skip directories without metadata.json (no warn)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.mkdirSync(path.join(workspace, "challenges", "no-metadata"), { recursive: true });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("should warn and skip metadata with broken JSON, collecting the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.mkdirSync(path.join(workspace, "challenges", "broken"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "challenges", "broken", "metadata.json"), "{not-json");
    writeProblem("challenges", "good", { id: "good" });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({ good: "problems/challenges/good" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("parse failed");
    warn.mockRestore();
  });

  it("should warn and skip metadata with missing / empty id field", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeProblem("challenges", "no-id", { name: "no id field" });
    writeProblem("challenges", "empty-id", { id: "" });
    writeProblem("challenges", "good", { id: "good" });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({ good: "problems/challenges/good" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("missing or invalid 'id' field");
    warn.mockRestore();
  });

  it("should ignore files (non-directories) mixed directly under category", () => {
    writeProblem("challenges", "hello-world", { id: "hello-world" });
    fs.writeFileSync(path.join(workspace, "README.md"), "not a category");
    fs.writeFileSync(path.join(workspace, "challenges", "stray.txt"), "not a problem dir");

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({ "hello-world": "problems/challenges/hello-world" });
  });
});

describe("discoverProblemsScoring", () => {
  it("should collect scoring of flag form", () => {
    writeProblem("challenges", "hello-world", {
      id: "hello-world",
      scoring: { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
    });
    expect(discoverProblemsScoring(workspace)).toEqual({
      "hello-world": { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
    });
  });

  it("should collect scoring of uptime form", () => {
    writeProblem("battles", "battle-1", {
      id: "battle-1",
      scoring: {
        kind: "uptime",
        endpoints: [{ outputKey: "FrontendUrl", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      },
    });
    expect(discoverProblemsScoring(workspace)).toEqual({
      "battle-1": {
        kind: "uptime",
        endpoints: [{ outputKey: "FrontendUrl", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      },
    });
  });

  it("should not include problems without scoring in the map", () => {
    writeProblem("challenges", "hello-world", { id: "hello-world" });
    writeProblem("challenges", "with-scoring", {
      id: "with-scoring",
      scoring: { kind: "flag", flagOutputKey: "X", points: 1 },
    });
    expect(discoverProblemsScoring(workspace)).toEqual({
      "with-scoring": { kind: "flag", flagOutputKey: "X", points: 1 },
    });
  });

  it("should drop entries with broken scoring shape (invalid kind / missing required field)", () => {
    writeProblem("challenges", "broken-1", {
      id: "broken-1",
      scoring: { kind: "wrong-kind" },
    });
    writeProblem("challenges", "broken-2", {
      id: "broken-2",
      scoring: { kind: "flag" }, // flagOutputKey / points 欠損
    });
    writeProblem("challenges", "good", {
      id: "good",
      scoring: { kind: "flag", flagOutputKey: "X", points: 1 },
    });
    expect(discoverProblemsScoring(workspace)).toEqual({
      good: { kind: "flag", flagOutputKey: "X", points: 1 },
    });
  });
});

// ADR-008 Phase 3 (Issue #642): visibility 抜き出し
describe("discoverProblemsVisibility (Issue #642)", () => {
  it("should map only visibility=private problems (omit public)", () => {
    writeProblem("challenges", "public-one", { id: "public-one", visibility: "public" });
    writeProblem("battles", "private-one", { id: "private-one", visibility: "private" });
    writeProblem("battles", "no-visibility", { id: "no-visibility" });
    expect(discoverProblemsVisibility(workspace)).toEqual({ "private-one": "private" });
  });

  it("空 workspace は空 map (= 全 public 扱い)", () => {
    expect(discoverProblemsVisibility(workspace)).toEqual({});
  });
});
