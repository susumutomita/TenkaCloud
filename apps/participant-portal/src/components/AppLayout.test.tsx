import { describe, expect, it } from "vitest";
import type { CloudMode } from "../config";
import { buildSideNavItems } from "./AppLayout";

/**
 * どの導線がどの `cloudMode` に出るか。
 *
 * 講座トラックは週・章順に並べた自習経路で、`make local` の単独ドリルのための画面。
 * それを常時表示にしていたため、LP から辿れる公開デモ (`cloudMode === "mock"`) にも
 * 出ていた。デモは AC26 の講座を受講していない人が触る導線なので、そこに講座前提の
 * 学習経路が並ぶと、デモが何の画面なのか読めなくなる。
 *
 * `mock` だけを外すのではなく `local` のときだけ出す形にしている。実イベント
 * (`real`) は主催者が問題を選んで出すもので、受講者ごとの自習経路とは別物のため。
 */

const t = (key: string) => key;
const MODES: readonly CloudMode[] = ["real", "mock", "local"];

/** section を辿って link の href を平坦に集める。 */
function hrefsOf(items: ReturnType<typeof buildSideNavItems>): string[] {
  const found: string[] = [];
  for (const item of items) {
    if (item.type === "link") found.push(item.href);
    if (item.type === "section") {
      for (const child of item.items) {
        if (child.type === "link") found.push(child.href);
      }
    }
  }
  return found;
}

describe("buildSideNavItems", () => {
  it.each(MODES)("should build a non-empty nav for %s, so an empty list cannot pass", (mode) => {
    // 以下の not.toContain 群は、nav が丸ごと空でも通ってしまう。
    expect(hrefsOf(buildSideNavItems(0, t, mode, "ja")).length).toBeGreaterThan(0);
  });

  it("should offer the course tracks in local mode", () => {
    expect(hrefsOf(buildSideNavItems(0, t, "local", "ja"))).toContain("/course-tracks");
  });

  it.each(["real", "mock"] as const)("should not offer the course tracks in %s mode", (mode) => {
    expect(hrefsOf(buildSideNavItems(0, t, mode, "ja"))).not.toContain("/course-tracks");
  });

  it.each(MODES)("should keep the flat problem list in %s mode", (mode) => {
    // 講座トラックを外しても問題一覧は残る = デモから問題に行けなくなってはいない。
    expect(hrefsOf(buildSideNavItems(0, t, mode, "ja"))).toContain("/problems");
  });

  it("should drop the AWS-only links in local mode", () => {
    // Issue #2474 の既存挙動。講座トラックの変更で壊れていないことを併せて見る。
    const hrefs = hrefsOf(buildSideNavItems(3, t, "local", "ja"));
    expect(hrefs).not.toContain("/notifications");
    expect(hrefs).not.toContain("/tools/sso");
  });

  it.each(["real", "mock"] as const)("should keep the AWS-only links in %s mode", (mode) => {
    const hrefs = hrefsOf(buildSideNavItems(3, t, mode, "ja"));
    expect(hrefs).toContain("/notifications");
    expect(hrefs).toContain("/tools/sso");
  });
});
