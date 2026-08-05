import type { ParticipantProblemView } from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import { renderSubmissionState } from "./Quests";

/**
 * [#2885] 一覧カードの採点状態バッジ。
 *
 * `renderSubmissionState` は `kind === "flag"` だけを見て分岐し、 それ以外は末尾の
 * 「挑戦中」に落ちていた。 container 問題は multi-flag で届くので、 **一度も起動していない
 * 問題まで「挑戦中」**と表示される。 local モードは deploy 済 (= `status: "COMPLETE"`) から
 * 始まるため、 参加者が何も触っていない初回起動時点で一覧のほぼ全部が「挑戦中」になっていた。
 *
 * バッジが答えるべき問いは「自分はこれをどこまでやったか」。 コンテナが今動いているかではない。
 */

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key;

function problem(scoring: unknown): ParticipantProblemView {
  return { problemId: "p", jobId: "j", status: "COMPLETE", scoring } as ParticipantProblemView;
}

const flag = (id: string, solved: boolean) => ({ id, label: id, points: 10, solved });

describe("renderSubmissionState for checkpoint problems (#2885)", () => {
  it("should say unsolved when no checkpoint has been submitted", () => {
    // 起動しただけ / 何もしていない状態。 ここが「挑戦中」だったのが元のバグ。
    const state = renderSubmissionState(
      problem({ kind: "multi-flag", flags: [flag("a", false), flag("b", false)] }),
      t,
    );
    expect(state.label).toBe("quests.submission_unsolved");
    expect(state.type).toBe("pending");
  });

  it("should show how far along a partially solved problem is", () => {
    const state = renderSubmissionState(
      problem({ kind: "multi-flag", flags: [flag("a", true), flag("b", false), flag("c", false)] }),
      t,
    );
    expect(state.label).toBe('quests.submission_partial:{"solved":1,"total":3}');
    expect(state.type).toBe("in-progress");
  });

  it("should say cleared once every checkpoint is submitted", () => {
    const state = renderSubmissionState(
      problem({ kind: "multi-flag", points: 30, flags: [flag("a", true), flag("b", true)] }),
      t,
    );
    expect(state.label).toBe('quests.submission_cleared_with_points:{"points":30}');
    expect(state.type).toBe("success");
  });

  it("should keep the single-flag behaviour unchanged", () => {
    expect(renderSubmissionState(problem({ kind: "flag", flagSubmitted: false }), t).label).toBe(
      "quests.submission_unsolved",
    );
    expect(
      renderSubmissionState(problem({ kind: "flag", flagSubmitted: true, points: 100 }), t).label,
    ).toBe('quests.submission_cleared_with_points:{"points":100}');
  });

  it("should still fall back to in-progress for a continuously scored problem with no flags", () => {
    // uptime 系は解答という概念が無く、 競技終了まで採点が続く。 従来どおり。
    const state = renderSubmissionState(problem({ kind: "uptime", points: 200 }), t);
    expect(state.label).toBe("quests.submission_in_progress");
  });

  it("should keep deploy status ahead of submission status", () => {
    // deploy が進行中なら、 提出状況より先にそちらを出す (= まだ解けない)。
    const view = {
      problemId: "p",
      jobId: "j",
      status: "IN_PROGRESS",
      scoring: { kind: "multi-flag", flags: [flag("a", false)] },
    } as ParticipantProblemView;
    expect(renderSubmissionState(view, t).type).toBe("in-progress");
    expect(renderSubmissionState(view, t).label).toBe("quests.status_label.IN_PROGRESS");
  });
});
