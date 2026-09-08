#!/usr/bin/env bun
/**
 * Submodule pin 後退ガード (gitlink ping-pong 対策)。
 *
 * なぜ必要か: `problems/` は手動 PR (`make submodule-latest`) で前進するが、 古い pin から
 * 切られた並行 PR が gitlink を過去 commit に **後退** させると、 一度上げた pin が巻き戻る
 * ping-pong が起きる (実例: #1927 で 56cbd2f へ上げた pin が a848323 に戻された)。
 *
 * 判定: PR が submodule pin を **実際に変更したときだけ** enforce する (= merge-base と比べて
 * 動かしていない PR は、 stale base でも誤判定しない)。 変更している場合、 PR の pin が
 * origin/main の現 pin と同一か、 子孫またはsquash取り込みによって修正を保持していることを要求する。
 *   - PR の pin == main の pin                   → OK (unchanged)
 *   - PR の pin == merge-base の pin (= 触れてない) → OK (untouched、 merge は main の新 pin を保つ)
 *   - main の pin が PR の pin の祖先 (= 前進)      → OK (ahead)
 *   - 分岐でも通常マージが競合せず候補treeと一致  → OK (squash取り込み済み)
 *   - それ以外 (後退 / 修正欠落 / 競合)             → FAIL
 *
 * Usage: `bun run scripts/quality/check-submodule-not-behind.ts [baseRef]` (default baseRef=origin/main)。
 * git I/O は injectable なので unit test から純粋に判定ロジックを観測できる。
 */

import { execFileSync } from "node:child_process";

const SUBMODULE_PATH = "problems";
const DEFAULT_BASE_REF = "origin/main";

export type PinVerdict = "unchanged" | "untouched" | "ahead" | "integrated" | "behind-or-diverged";

/**
 * main pin / PR pin / merge-base pin の関係から verdict を出す純関数。 submodule の ancestry
 * 判定は injectable (`isAncestor(maybeAncestor, descendant)`) なので git なしでテストできる。
 */
export function classifyPinChange(
  mainPin: string,
  prPin: string,
  mergeBasePin: string | undefined,
  isAncestor: (maybeAncestor: string, descendant: string) => boolean,
  containsChanges: (existing: string, proposed: string) => boolean = () => false,
): PinVerdict {
  // 既に main と同じ pin (= 何も変えていない / main の最新に追従済み)。
  if (prPin === mainPin) return "unchanged";
  // PR が分岐点から submodule を触っていない → main が前進していても merge は main の新 pin を
  // 保つので rollback ではない。 stale base を理由に誤って fail させない。
  if (mergeBasePin !== undefined && prPin === mergeBasePin) return "untouched";
  // PR が pin を能動的に変えた → main の現 pin の子孫 (= 前進) であることを要求する。
  if (isAncestor(mainPin, prPin)) return "ahead";
  // Reverts can leave an older commit with the same tree; never move history backwards.
  if (isAncestor(prPin, mainPin)) return "behind-or-diverged";
  if (containsChanges(mainPin, prPin)) return "integrated";
  return "behind-or-diverged";
}

export interface GitIO {
  /** parent repo の `<ref>:problems` gitlink commit を返す。 解決不能なら undefined。 */
  readonly readGitlink: (ref: string) => string | undefined;
  /** parent repo の merge-base(refA, refB) commit を返す。 解決不能なら undefined。 */
  readonly mergeBase: (refA: string, refB: string) => string | undefined;
  /** submodule に main/PR/merge-base の commit と祖先を揃える (= ancestry 判定の前提)。 */
  readonly fetchSubmodule: (...pins: readonly string[]) => void;
  /** submodule 内で `git merge-base --is-ancestor a b` 相当。 */
  readonly isAncestor: (maybeAncestor: string, descendant: string) => boolean;
  readonly containsChanges: (existing: string, proposed: string) => boolean;
  readonly log: (message: string) => void;
}

/**
 * ガード本体。 verdict が "behind-or-diverged" のときだけ false (= CI 失敗) を返す。
 * base/PR どちらかの gitlink が読めない (= submodule 未使用 state) ときは安全側で pass。
 */
export function checkSubmoduleNotBehind(baseRef: string, io: GitIO): boolean {
  const mainPin = io.readGitlink(baseRef);
  const prPin = io.readGitlink("HEAD");
  if (!mainPin || !prPin) {
    io.log(`[submodule-guard] ${SUBMODULE_PATH} gitlink not found on base or HEAD — skipping.`);
    return true;
  }

  // 大多数の PR (= main と同 pin) はここで抜ける。 fetch / ancestry 判定も不要。
  if (prPin === mainPin) {
    io.log(`[submodule-guard] OK ${SUBMODULE_PATH} pin unchanged (${prPin.slice(0, 7)}).`);
    return true;
  }

  const mergeBaseCommit = io.mergeBase(baseRef, "HEAD");
  const mergeBasePin = mergeBaseCommit ? io.readGitlink(mergeBaseCommit) : undefined;

  // pin が main と違い、 かつ merge-base から動かしている可能性があるときだけ history を揃える。
  io.fetchSubmodule(mainPin, prPin, ...(mergeBasePin ? [mergeBasePin] : []));
  const verdict = classifyPinChange(
    mainPin,
    prPin,
    mergeBasePin,
    io.isAncestor,
    io.containsChanges,
  );

  if (verdict === "untouched") {
    io.log(
      `[submodule-guard] OK ${SUBMODULE_PATH} pin not changed by this PR ` +
        `(${prPin.slice(0, 7)}); merge keeps main's ${mainPin.slice(0, 7)}.`,
    );
    return true;
  }
  if (verdict === "ahead") {
    io.log(
      `[submodule-guard] OK ${SUBMODULE_PATH} pin moves forward ${mainPin.slice(0, 7)} -> ${prPin.slice(0, 7)}.`,
    );
    return true;
  }
  if (verdict === "integrated") {
    io.log(
      `[submodule-guard] OK ${SUBMODULE_PATH} contains all pinned changes after squash integration ${mainPin.slice(0, 7)} -> ${prPin.slice(0, 7)}.`,
    );
    return true;
  }
  io.log(
    `[submodule-guard] FAIL ${SUBMODULE_PATH} pin would roll back / diverge: ` +
      `origin/main is at ${mainPin.slice(0, 7)} but this PR pins ${prPin.slice(0, 7)} ` +
      `(not at or ahead of the current pin).\n` +
      `[submodule-guard] This is the gitlink ping-pong: rebase on origin/main and re-pin to a ` +
      `commit at or ahead of the current pin (run \`make submodule-latest\`).`,
  );
  return false;
}

/** A clean default merge must leave the proposed tree unchanged; conflicts fail closed. */
export function containsPinnedChanges(
  repository: string,
  existing: string,
  proposed: string,
): boolean {
  try {
    const merged = execFileSync(
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- git supplies the guard's tree evidence
      "git",
      ["-C", repository, "merge-tree", "--write-tree", proposed, existing],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git supplies the guard's tree evidence
    const tree = execFileSync("git", ["-C", repository, "rev-parse", `${proposed}^{tree}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return merged === tree;
  } catch {
    return false;
  }
}

/** 実 git を叩く GitIO 実装。 */
function realGitIO(): GitIO {
  const tryGit = (args: readonly string[]): string | undefined => {
    try {
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is this gate's input source
      const out = execFileSync("git", [...args], { encoding: "utf8" }).trim();
      return out.length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    // `git rev-parse <ref>:problems` は gitlink (= submodule commit) を返す。
    readGitlink: (ref) => tryGit(["rev-parse", `${ref}:${SUBMODULE_PATH}`]),
    mergeBase: (refA, refB) => tryGit(["merge-base", refA, refB]),
    fetchSubmodule: (...pins) => {
      const uniquePins = [...new Set(pins)];
      const isShallow =
        tryGit(["-C", SUBMODULE_PATH, "rev-parse", "--is-shallow-repository"]) === "true";
      try {
        execFileSync(
          // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is this gate's input source
          "git",
          [
            "-C",
            SUBMODULE_PATH,
            "fetch",
            "--quiet",
            "--no-tags",
            ...(isShallow ? ["--unshallow"] : []),
            "origin",
            ...uniquePins,
          ],
          { stdio: "ignore" },
        );
      } catch {
        // fetch 失敗は致命ではない (= 既に必要 commit を持つ可能性)。 ancestry 判定に委ねる。
      }
    },
    isAncestor: (maybeAncestor, descendant) => {
      try {
        execFileSync(
          // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is this gate's input source
          "git",
          ["-C", SUBMODULE_PATH, "merge-base", "--is-ancestor", maybeAncestor, descendant],
          { stdio: "ignore" },
        );
        return true; // exit 0 = ancestor
      } catch {
        return false; // exit 1 = not ancestor (= 後退 / 分岐)
      }
    },
    containsChanges: (existing, proposed) =>
      containsPinnedChanges(SUBMODULE_PATH, existing, proposed),
    log: (message) => console.log(message),
  };
}

function main(): void {
  const baseRef = process.argv[2] ?? DEFAULT_BASE_REF;
  const ok = checkSubmoduleNotBehind(baseRef, realGitIO());
  if (!ok) process.exit(1);
}

if (import.meta.main) main();
