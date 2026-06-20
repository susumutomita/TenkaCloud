import { describe, expect, it } from "vitest";
import {
  checkSubmoduleNotBehind,
  classifyPinChange,
  type GitIO,
} from "../../../scripts/check-submodule-not-behind";

/**
 * Submodule pin 後退ガードのテスト。 gitlink ping-pong (= 古い pin から切られた並行 PR が
 * 一度上げた pin を巻き戻す事故、 実例 #1927) を弾きつつ、 submodule を触っていない PR を
 * stale base だけを理由に誤って fail させないことを pin する。
 */

// OLD は NEW の祖先 (= OLD -> NEW が前進)。 ancestry stub をこの前提で組む。
const OLD = "0000000000000000000000000000000000000000";
const NEW = "1111111111111111111111111111111111111111";
const SIDE = "2222222222222222222222222222222222222222"; // どちらの祖先でもない分岐
const ancestorOldNew = (anc: string, desc: string) => anc === OLD && desc === NEW;

describe("classifyPinChange", () => {
  it("should return unchanged when the PR pin already equals main's pin", () => {
    expect(classifyPinChange(NEW, NEW, OLD, ancestorOldNew)).toBe("unchanged");
  });

  it("should return untouched when the PR did not move the pin from its merge-base", () => {
    // main は NEW に前進済み、 PR は分岐点 (OLD) のまま submodule を触っていない → rollback ではない。
    expect(classifyPinChange(NEW, OLD, OLD, ancestorOldNew)).toBe("untouched");
  });

  it("should return ahead when the PR bumps the pin forward past main", () => {
    // main=OLD、 PR=NEW、 OLD は NEW の祖先 → 前進。
    expect(classifyPinChange(OLD, NEW, OLD, ancestorOldNew)).toBe("ahead");
  });

  it("should return behind-or-diverged when the PR actively rolls the pin back", () => {
    // main=NEW、 PR=OLD だが PR は merge-base(NEW) から能動的に OLD へ下げた → ping-pong。
    expect(classifyPinChange(NEW, OLD, NEW, ancestorOldNew)).toBe("behind-or-diverged");
  });

  it("should return behind-or-diverged when the PR pins a divergent commit", () => {
    expect(classifyPinChange(NEW, SIDE, OLD, ancestorOldNew)).toBe("behind-or-diverged");
  });

  it("should fall back to the ancestor check when the merge-base pin is unknown", () => {
    // merge-base が取れない (= shallow 等) ときは「main の子孫か」だけで判定する。
    expect(classifyPinChange(OLD, NEW, undefined, ancestorOldNew)).toBe("ahead");
    expect(classifyPinChange(NEW, OLD, undefined, ancestorOldNew)).toBe("behind-or-diverged");
  });
});

function buildIO(overrides: Partial<GitIO>): { io: GitIO; logs: string[]; fetched: () => number } {
  const logs: string[] = [];
  let fetchCount = 0;
  const io: GitIO = {
    readGitlink: () => undefined,
    mergeBase: () => undefined,
    fetchSubmodule: () => {
      fetchCount += 1;
    },
    isAncestor: () => false,
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { io, logs, fetched: () => fetchCount };
}

describe("checkSubmoduleNotBehind", () => {
  it("should pass (skip) when the gitlink is absent on base or HEAD", () => {
    const { io, logs } = buildIO({ readGitlink: () => undefined });
    expect(checkSubmoduleNotBehind("origin/main", io)).toBe(true);
    expect(logs.join("")).toContain("not found");
  });

  it("should pass without fetching when the pin already matches main", () => {
    const { io, fetched } = buildIO({ readGitlink: () => NEW });
    expect(checkSubmoduleNotBehind("origin/main", io)).toBe(true);
    expect(fetched()).toBe(0); // main==HEAD は early OK、 fetch 不要。
  });

  it("should pass a PR that did not touch the submodule even when main moved forward", () => {
    // main=NEW、 PR HEAD=OLD (= 分岐後 main が bump したが PR は触っていない)。 誤検知しない。
    const mb = "mergebasecommit";
    const { io, logs } = buildIO({
      readGitlink: (ref) => (ref === "origin/main" ? NEW : OLD), // HEAD と merge-base は OLD
      mergeBase: () => mb,
      isAncestor: ancestorOldNew,
    });
    expect(checkSubmoduleNotBehind("origin/main", io)).toBe(true);
    expect(logs.join("")).toContain("not changed by this PR");
  });

  it("should pass a PR that bumps the pin forward", () => {
    const mb = "mergebasecommit";
    const { io, logs } = buildIO({
      // main=OLD (動いていない)、 merge-base=OLD、 PR HEAD=NEW (= PR が前進 bump した)。
      readGitlink: (ref) => (ref === "HEAD" ? NEW : OLD),
      mergeBase: () => mb,
      isAncestor: ancestorOldNew,
    });
    expect(checkSubmoduleNotBehind("origin/main", io)).toBe(true);
    expect(logs.join("")).toContain("moves forward");
  });

  it("should fail a PR that actively rolls the pin back (the #1927 ping-pong)", () => {
    const mb = "mergebasecommit";
    const { io, logs } = buildIO({
      // main=NEW、 PR HEAD=OLD、 merge-base=NEW (= PR が NEW から OLD へ下げた)。
      readGitlink: (ref) => {
        if (ref === "origin/main") return NEW;
        if (ref === "HEAD") return OLD;
        return NEW; // merge-base commit -> NEW
      },
      mergeBase: () => mb,
      isAncestor: ancestorOldNew,
    });
    expect(checkSubmoduleNotBehind("origin/main", io)).toBe(false);
    expect(logs.join("")).toContain("roll back");
  });

  it("should fetch the submodule before deciding when the pin differs from main", () => {
    const { io, fetched } = buildIO({
      readGitlink: (ref) => (ref === "origin/main" ? OLD : NEW),
      mergeBase: () => "mb",
      isAncestor: ancestorOldNew,
    });
    checkSubmoduleNotBehind("origin/main", io);
    expect(fetched()).toBe(1);
  });
});
