import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverProblemsCatalog,
  discoverProblemsScoring,
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
  it("metadata.json を持つ全 problem を id → problemDir map で返すべき", () => {
    writeProblem("challenges", "hello-world", { id: "hello-world" });
    writeProblem("battles", "security-battle-royale", { id: "security-battle-royale" });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({
      "hello-world": "problems/challenges/hello-world",
      "security-battle-royale": "problems/battles/security-battle-royale",
    });
  });

  it("ディレクトリ名と異なる id を metadata 側で名乗っているときは metadata の id を採用すべき", () => {
    writeProblem("challenges", "physical-dir-name", { id: "logical-id" });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({ "logical-id": "problems/challenges/physical-dir-name" });
  });

  it("problemsRoot 自体が存在しないときは空 map を返し warn すべき", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = path.join(workspace, "missing-root");

    const catalog = discoverProblemsCatalog(missing);

    expect(catalog).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("not found");
    warn.mockRestore();
  });

  it("metadata.json が無いディレクトリは silent skip するべき (warn しない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.mkdirSync(path.join(workspace, "challenges", "no-metadata"), { recursive: true });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("壊れた JSON を持つ metadata は warn して skip し他の problem は採集すべき", () => {
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

  it("id field が無い / 空文字の metadata は warn して skip するべき", () => {
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

  it("ファイル (= ディレクトリでない) が category 直下に紛れていても無視するべき", () => {
    writeProblem("challenges", "hello-world", { id: "hello-world" });
    fs.writeFileSync(path.join(workspace, "README.md"), "not a category");
    fs.writeFileSync(path.join(workspace, "challenges", "stray.txt"), "not a problem dir");

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({ "hello-world": "problems/challenges/hello-world" });
  });
});

describe("discoverProblemsScoring", () => {
  it("flag 形式の scoring を採集するべき", () => {
    writeProblem("challenges", "hello-world", {
      id: "hello-world",
      scoring: { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
    });
    expect(discoverProblemsScoring(workspace)).toEqual({
      "hello-world": { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
    });
  });

  it("uptime 形式の scoring を採集するべき", () => {
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

  it("scoring を持たない problem は map に含めないべき", () => {
    writeProblem("challenges", "hello-world", { id: "hello-world" });
    writeProblem("challenges", "with-scoring", {
      id: "with-scoring",
      scoring: { kind: "flag", flagOutputKey: "X", points: 1 },
    });
    expect(discoverProblemsScoring(workspace)).toEqual({
      "with-scoring": { kind: "flag", flagOutputKey: "X", points: 1 },
    });
  });

  it("scoring の shape が壊れているもの (= kind 不正 / 必須 field 欠損) は drop するべき", () => {
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
