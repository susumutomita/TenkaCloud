import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `problems/` は `.dockerignore` で意図的に除外されている — image に焼かず、実行時に read-only
 * で bind-mount する設計 (docker-launcher.sh / catalog-loader.ts の rationale)。つまり image を
 * build している最中、`problems/` は存在しない。
 *
 * ここから 1 つ制約が出る: **image build が `problems/` の中身に依存してはならない。**
 *
 * これを破ると `make local` だけが落ちる。CI は submodule を checkout した状態で走るので緑のまま
 * になり、壊れたことに気づけるのは Docker で build した人だけになる。実際に #2914 で
 * `MultiFlagSubmissionPanel.test.tsx` が実カタログの metadata.json を静的 import し、build の
 * `tsc` が test まで型検査していたために participant-portal の image build が
 *
 *   error TS2307: Cannot find module '../../../../problems/challenges/wp-exposed-backup/metadata.json'
 *
 * で停止した (以降の TS7006 / TS2339 はこの解決失敗から派生した二次エラー)。
 *
 * test 側の import 自体は正しい — UI を実カタログ定義に対して pin する意図がある。分けるべきは
 * **型検査の対象**であって、test を消すことではない。build は src だけを見る。
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const PORTAL = join(REPO_ROOT, "apps", "participant-portal");

describe("participant-portal image build", () => {
  it("should keep problems/ out of the build context, since it is bind-mounted at runtime", () => {
    const dockerignore = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8");
    const entries = dockerignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(entries).toContain("problems/");
  });

  it("should type-check the build with a config that excludes tests", () => {
    // build が既定の tsconfig (= test 込み) を使うと、image に入れないと決めた problems/ を
    // 解決させることになる。
    const build = JSON.parse(readFileSync(join(PORTAL, "package.json"), "utf8")).scripts
      .build as string;

    expect(build).toContain("tsc -p tsconfig.build.json");
    expect(build).not.toMatch(/tsc\s+--noEmit/);
  });

  it("should still type-check tests somewhere, so the split does not lose coverage", () => {
    const scripts = JSON.parse(readFileSync(join(PORTAL, "package.json"), "utf8"))
      .scripts as Record<string, string>;
    const base = JSON.parse(readFileSync(join(PORTAL, "tsconfig.json"), "utf8")) as {
      include: string[];
    };

    // `typecheck` は既定 tsconfig を使い、その include は test を含む。
    expect(scripts.typecheck).toContain("tsc");
    expect(scripts.typecheck).not.toContain("tsconfig.build.json");
    expect(base.include).toContain("test/**/*");
  });

  it("should compile the app without problems/ present, the way the image build does", () => {
    const buildConfig = join(PORTAL, "tsconfig.build.json");
    expect(existsSync(buildConfig)).toBe(true);

    // problems/ を見えなくして build 用の型検査だけを回す。 `problems/` を静的 import している
    // src ファイルが増えたら、ここで落ちる。
    const result = execFileSync(
      "bun",
      ["run", "tsc", "-p", "tsconfig.build.json", "--excludeDirectories", "**/problems"],
      { cwd: PORTAL, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(result).not.toContain("error TS");
  }, 180_000);
});
