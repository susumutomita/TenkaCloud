import { describe, expect, it } from "vitest";
import {
  checkSubmoduleNotBehind,
  type GitIO,
} from "../../../scripts/quality/check-submodule-not-behind";

describe("checkSubmoduleNotBehind", () => {
  it("should give the fetcher every pin needed to restore shallow submodule ancestry", () => {
    const fetchedPins: string[][] = [];
    const io: GitIO = {
      readGitlink: (ref) =>
        new Map([
          ["origin/main", "main-pin"],
          ["HEAD", "pr-pin"],
          ["merge-base", "merge-base-pin"],
        ]).get(ref),
      mergeBase: () => "merge-base",
      fetchSubmodule: (...pins) => fetchedPins.push(pins),
      isAncestor: () => true,
      log: () => undefined,
    };

    expect(checkSubmoduleNotBehind("origin/main", io)).toBe(true);
    expect(fetchedPins).toEqual([["main-pin", "pr-pin", "merge-base-pin"]]);
  });
});
