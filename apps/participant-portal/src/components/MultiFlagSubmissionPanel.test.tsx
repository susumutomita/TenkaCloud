import { LITE_DRILL_CHECKPOINTS, LITE_DRILL_PROBLEM_ID } from "@tenkacloud/portal-contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfigProvider } from "../config-context";
import {
  LITE_DRILL_JOB_ID,
  LOCAL_DRILL_JOB_ID,
  resetMockScoring,
  WHAT_IS_DRILL_PROBLEM_ID,
} from "../dev-mock/flag-submit";
import { I18nProvider } from "../i18n";
import {
  isWhatIsTutorialShape,
  MultiFlagSubmissionPanel,
  subFlagFieldPresentation,
} from "./MultiFlagSubmissionPanel";

/**
 * Issue #1796: MultiFlagSubmissionPanel を実 provider (AppConfigProvider + I18nProvider) で
 * render し、 N 個の提出欄 / solved 表示 / submit (= client が flagId 付きで呼ばれる) /
 * wrong alert / dev-mock 経路を pin する。 submitFlag だけ mock し、 evaluateMockFlag・i18n は実物。
 */

const apiMocks = vi.hoisted(() => ({ submitFlag: vi.fn() }));

vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return { ...actual, submitFlag: apiMocks.submitFlag };
});

function LocationProbe() {
  return <output data-testid="router-path">{useLocation().pathname}</output>;
}

function withProviders(node: React.ReactNode, mode: "backend" | "dev-mock" = "backend") {
  return (
    <AppConfigProvider
      config={{
        apiBaseUrl: "https://api.example.com",
        eventTitle: "Test event",
        eventRegion: "ap-northeast-1",
        mode,
        cloudMode: mode === "backend" ? "real" : "mock",
      }}
    >
      <I18nProvider>
        <MemoryRouter>
          {node}
          <LocationProbe />
        </MemoryRouter>
      </I18nProvider>
    </AppConfigProvider>
  );
}

const FLAGS = [
  { id: "ep01", label: "Ep01: Reachability", points: 300, solved: false },
  { id: "ep02", label: "Ep02: TCP/IP", points: 200, solved: false },
];

const baseProps = {
  apiBaseUrl: "https://api.example.com",
  sessionToken: "team-key",
  problemId: "net-evo",
  flags: FLAGS,
  onScored: async () => undefined,
} as const;

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof MultiFlagSubmissionPanel>> = {},
  mode: "backend" | "dev-mock" = "backend",
) {
  return render(withProviders(<MultiFlagSubmissionPanel {...baseProps} {...overrides} />, mode));
}

beforeEach(() => {
  window.localStorage.setItem("tenkacloud.portal.locale", "en");
  apiMocks.submitFlag.mockReset();
  // dev-mock の累積スコアと sessionStorage 進捗をテスト間で持ち越さない。
  resetMockScoring();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("MultiFlagSubmissionPanel", () => {
  it("should render one input per unsolved flag", () => {
    renderPanel();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.getByText("Flags solved: 0 / 2")).toBeInTheDocument();
  });

  it("should show a solved alert and no input for an already-solved flag", () => {
    renderPanel({
      flags: [{ ...FLAGS[0], solved: true }, FLAGS[1]],
    });
    // solved な ep01 は提出欄を出さず success Alert を表示、 未 solved な ep02 だけ input 1 個。
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByText("🎉 Ep01: Reachability — solved")).toBeInTheDocument();
  });

  it("should announce full clear when every flag is solved", () => {
    renderPanel({
      flags: FLAGS.map((f) => ({ ...f, solved: true })),
    });
    expect(screen.getByText("Flags solved: 2 / 2")).toBeInTheDocument();
    expect(
      screen.getByText("All flags solved. This problem is fully cleared!"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("should call submitFlag with the flag id of the row being submitted", async () => {
    const user = userEvent.setup();
    const onScored = vi.fn().mockResolvedValue(undefined);
    apiMocks.submitFlag.mockResolvedValue({
      kind: "ok",
      scoreDelta: 200,
      totalScore: 200,
      flagId: "ep02",
    });
    renderPanel({ onScored });
    // 2 番目の行 (ep02) に入力して提出する。
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[1], "answer-ep02");
    const buttons = screen.getAllByRole("button", { name: /^Submit/ });
    await user.click(buttons[1]);
    await waitFor(() =>
      expect(apiMocks.submitFlag).toHaveBeenCalledWith(
        "https://api.example.com",
        "team-key",
        "net-evo",
        "answer-ep02",
        "ep02",
      ),
    );
    expect(onScored).toHaveBeenCalled();
    expect(await screen.findByText("🎉 Ep02: TCP/IP — solved")).toBeInTheDocument();
  });

  it("should not submit an empty flag", async () => {
    const user = userEvent.setup();
    renderPanel();
    const buttons = screen.getAllByRole("button", { name: /^Submit/ });
    await user.click(buttons[0]);
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it("should show a penalty warning on a wrong backend submission", async () => {
    const user = userEvent.setup();
    apiMocks.submitFlag.mockResolvedValue({
      kind: "wrong",
      scoreDelta: -10,
      totalScore: 40,
      wrongCount: 2,
    });
    renderPanel();
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[0], "bad");
    const buttons = screen.getAllByRole("button", { name: /^Submit/ });
    await user.click(buttons[0]);
    expect(await screen.findByText("Wrong (-10 pt) — total 40 pt")).toBeInTheDocument();
  });

  it("should show a plain wrong warning when the flag carries no penalty", async () => {
    const user = userEvent.setup();
    apiMocks.submitFlag.mockResolvedValue({
      kind: "wrong",
      scoreDelta: 0,
      totalScore: 50,
      wrongCount: 1,
    });
    renderPanel();
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[0], "bad");
    const buttons = screen.getAllByRole("button", { name: /^Submit/ });
    await user.click(buttons[0]);
    expect(await screen.findByText("Wrong")).toBeInTheDocument();
    expect(screen.getByText("Check the value and try again.")).toBeInTheDocument();
  });

  it("should show the already-scored info when a flag was scored elsewhere", async () => {
    const user = userEvent.setup();
    apiMocks.submitFlag.mockResolvedValue({ kind: "already_scored", totalScore: 300 });
    renderPanel();
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[0], "late");
    const buttons = screen.getAllByRole("button", { name: /^Submit/ });
    await user.click(buttons[0]);
    expect(await screen.findByText("Already solved (total 300 pt).")).toBeInTheDocument();
  });

  it("should surface a submit error", async () => {
    const user = userEvent.setup();
    apiMocks.submitFlag.mockRejectedValue(new Error("server boom"));
    renderPanel();
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[0], "x");
    const buttons = screen.getAllByRole("button", { name: /^Submit/ });
    await user.click(buttons[0]);
    expect(await screen.findByText("server boom")).toBeInTheDocument();
  });

  it("should evaluate locally in dev-mock mode without calling the backend", async () => {
    const user = userEvent.setup();
    renderPanel({}, "dev-mock");
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[0], "tenkacloudsample");
    const buttons = screen.getAllByRole("button", { name: /^Submit/ });
    await user.click(buttons[0]);
    expect(await screen.findByText("🎉 Ep01: Reachability — solved")).toBeInTheDocument();
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it("should show one tutorial page at a time and reach 4/4 through choice buttons", async () => {
    const user = userEvent.setup();
    const tutorialFlags = [
      { id: "tenka-what", label: "Step 1", points: 100, solved: false },
      { id: "battle-challenge", label: "Step 2", points: 100, solved: false },
      { id: "choose-mode", label: "Step 3", points: 100, solved: false },
      { id: "first-flag", label: "Step 4", points: 100, solved: false },
    ];
    renderPanel({ problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: tutorialFlags }, "dev-mock");

    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
    expect(screen.getByText("Your site breaks when real users arrive")).toBeInTheDocument();
    expect(screen.queryByText("Every team competes at the same time")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /The real cloud/ }));
    expect(await screen.findByText("Correct. +100 pt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next mission" }));

    expect(screen.getByText("Step 2 of 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Battle/ }));
    await user.click(await screen.findByRole("button", { name: "Next mission" }));

    expect(screen.getByText("Step 3 of 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Play first, with no AWS account/ }));
    await user.click(await screen.findByRole("button", { name: "Next mission" }));

    expect(screen.getByText("Step 4 of 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Submit the practice flag/ }));

    expect(await screen.findByText("4 cleared")).toBeInTheDocument();
    expect(screen.getByText("🎉 You have the TenkaCloud basics")).toBeInTheDocument();
    expect(screen.getByText("Next: run it for real")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go to “Play local mode”" }));
    expect(screen.getByTestId("router-path")).toHaveTextContent(`/problems/${LOCAL_DRILL_JOB_ID}`);
    await user.click(
      screen.getByRole("button", { name: "Go to “Deploy your own TenkaCloud Lite”" }),
    );
    expect(screen.getByTestId("router-path")).toHaveTextContent(`/problems/${LITE_DRILL_JOB_ID}`);
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it("should keep the learner on the current page after a wrong choice without a penalty", async () => {
    const user = userEvent.setup();
    const tutorialFlags = [
      { id: "tenka-what", label: "Step 1", points: 100, solved: false },
      { id: "battle-challenge", label: "Step 2", points: 100, solved: false },
      { id: "choose-mode", label: "Step 3", points: 100, solved: false },
      { id: "first-flag", label: "Step 4", points: 100, solved: false },
    ];
    renderPanel({ problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: tutorialFlags });

    await user.click(screen.getByRole("button", { name: /A paper quiz/ }));
    expect(await screen.findByText("Close. Pick again")).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
    expect(screen.getByText("0 cleared")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next mission" })).not.toBeInTheDocument();
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it("should submit a correct tutorial choice to the backend and refresh the score", async () => {
    const user = userEvent.setup();
    const onScored = vi.fn().mockResolvedValue(undefined);
    apiMocks.submitFlag.mockResolvedValueOnce({
      kind: "ok",
      scoreDelta: 100,
      totalScore: 100,
    });
    renderPanel({
      problemId: WHAT_IS_DRILL_PROBLEM_ID,
      flags: [
        { id: "tenka-what", label: "Step 1", points: 100, solved: false },
        { id: "battle-challenge", label: "Step 2", points: 100, solved: false },
        { id: "choose-mode", label: "Step 3", points: 100, solved: false },
        { id: "first-flag", label: "Step 4", points: 100, solved: false },
      ],
      onScored,
    });

    await user.click(screen.getByRole("button", { name: /The real cloud/ }));

    expect(await screen.findByText("Correct. +100 pt")).toBeInTheDocument();
    expect(apiMocks.submitFlag).toHaveBeenCalledWith(
      "https://api.example.com",
      "team-key",
      WHAT_IS_DRILL_PROBLEM_ID,
      "real cloud",
      "tenka-what",
    );
    expect(onScored).toHaveBeenCalledOnce();
  });

  it("should show already-scored, wrong, and backend-error outcomes inside the tutorial", async () => {
    const user = userEvent.setup();
    const tutorialFlags = [
      { id: "tenka-what", label: "Step 1", points: 100, solved: false },
      { id: "battle-challenge", label: "Step 2", points: 100, solved: false },
      { id: "choose-mode", label: "Step 3", points: 100, solved: false },
      { id: "first-flag", label: "Step 4", points: 100, solved: false },
    ];
    const onScored = vi.fn().mockResolvedValue(undefined);
    apiMocks.submitFlag.mockResolvedValueOnce({ kind: "already_scored", totalScore: 100 });
    const alreadyScored = renderPanel({
      problemId: WHAT_IS_DRILL_PROBLEM_ID,
      flags: tutorialFlags,
      onScored,
    });

    await user.click(screen.getByRole("button", { name: /The real cloud/ }));
    expect(await screen.findByText("Already submitted")).toBeInTheDocument();
    expect(onScored).toHaveBeenCalledOnce();
    alreadyScored.unmount();

    apiMocks.submitFlag.mockResolvedValueOnce({
      kind: "wrong",
      scoreDelta: 0,
      totalScore: 0,
      wrongCount: 1,
    });
    const rejectedAnswer = renderPanel({
      problemId: WHAT_IS_DRILL_PROBLEM_ID,
      flags: tutorialFlags,
    });
    await user.click(screen.getByRole("button", { name: /The real cloud/ }));
    expect(await screen.findByText("Close. Pick again")).toBeInTheDocument();
    rejectedAnswer.unmount();

    apiMocks.submitFlag.mockRejectedValueOnce(new Error("offline"));
    renderPanel({ problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: tutorialFlags });
    await user.click(screen.getByRole("button", { name: /The real cloud/ }));
    expect(await screen.findByText("Submission failed")).toBeInTheDocument();
  });

  it("should ignore a second choice while the first backend submission is pending", async () => {
    let resolveSubmission:
      | ((outcome: { kind: "ok"; scoreDelta: number; totalScore: number }) => void)
      | undefined;
    apiMocks.submitFlag.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSubmission = resolve;
      }),
    );
    renderPanel({
      problemId: WHAT_IS_DRILL_PROBLEM_ID,
      flags: [
        { id: "tenka-what", label: "Step 1", points: 100, solved: false },
        { id: "battle-challenge", label: "Step 2", points: 100, solved: false },
        { id: "choose-mode", label: "Step 3", points: 100, solved: false },
        { id: "first-flag", label: "Step 4", points: 100, solved: false },
      ],
    });
    const choice = screen.getByRole("button", { name: /The real cloud/ });

    act(() => {
      choice.click();
      choice.click();
    });
    expect(apiMocks.submitFlag).toHaveBeenCalledOnce();

    await act(async () => {
      resolveSubmission?.({ kind: "ok", scoreDelta: 100, totalScore: 100 });
    });
    expect(await screen.findByText("Correct. +100 pt")).toBeInTheDocument();
  });

  it("should explain the last solved step when restored progress is already complete", () => {
    const tutorialFlags = [
      { id: "tenka-what", label: "Step 1", points: 100, solved: true },
      { id: "battle-challenge", label: "Step 2", points: 100, solved: true },
      { id: "choose-mode", label: "Step 3", points: 100, solved: true },
      { id: "first-flag", label: "Step 4", points: 100, solved: true },
    ];
    renderPanel({ problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: tutorialFlags });

    expect(screen.getByText("4 cleared")).toBeInTheDocument();
    expect(
      screen.getByText(
        "That is the TenkaCloud loop: read the situation, operate the system, submit the flag, and see the score update immediately.",
      ),
    ).toBeInTheDocument();
  });

  it("should restore mock-solved flags after unmount so the demo does not look reset", async () => {
    // 2026-07-21 デモ報告: 解いた後に問題を開き直すと進捗が消えて見えた。
    // sessionStorage の進捗 store から solved を復元することを pin する。
    const user = userEvent.setup();
    const tutorialFlags = [{ id: "tenka-what", label: "Step 1", points: 100, solved: false }];
    const first = renderPanel(
      { problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: tutorialFlags },
      "dev-mock",
    );
    await user.type(screen.getByRole("textbox"), "real cloud");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(await screen.findByText("🎉 Step 1 — solved")).toBeInTheDocument();
    first.unmount();

    renderPanel({ problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: tutorialFlags }, "dev-mock");
    expect(screen.getByText("🎉 Step 1 — solved")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("isWhatIsTutorialShape", () => {
  it("should require the four supported steps in journey order", () => {
    const tutorialFlags = [
      { id: "tenka-what", label: "Step 1", points: 100, solved: false },
      { id: "battle-challenge", label: "Step 2", points: 100, solved: false },
      { id: "choose-mode", label: "Step 3", points: 100, solved: false },
      { id: "first-flag", label: "Step 4", points: 100, solved: false },
    ];
    expect(isWhatIsTutorialShape(tutorialFlags)).toBe(true);
    expect(isWhatIsTutorialShape([...tutorialFlags].reverse())).toBe(false);
    expect(isWhatIsTutorialShape(tutorialFlags.slice(0, 3))).toBe(false);
  });
});

describe("Lite deploy drill (issue #2696)", () => {
  const CHECKPOINT = LITE_DRILL_CHECKPOINTS.launcherCreated;
  const DRILL_FLAGS = [
    { id: CHECKPOINT.flagId, label: "1. Launcher スタック作成", points: 100, solved: false },
  ];

  it("should solve a drill step in dev-mock mode only with its checkpoint code", async () => {
    const user = userEvent.setup();
    renderPanel({ problemId: LITE_DRILL_PROBLEM_ID, flags: DRILL_FLAGS }, "dev-mock");
    // userEvent.type は `{` を修飾記法として解釈するため、 literal brace は `{{` に escape する。
    await user.type(screen.getByRole("textbox"), CHECKPOINT.code.replaceAll("{", "{{"));
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(await screen.findByText("🎉 1. Launcher スタック作成 — solved")).toBeInTheDocument();
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it("should reject the generic mock flag on a drill step in dev-mock mode", async () => {
    const user = userEvent.setup();
    renderPanel({ problemId: LITE_DRILL_PROBLEM_ID, flags: DRILL_FLAGS }, "dev-mock");
    // 累計は 0 pt を下回らない (実採点の floor と同じ)。
    await user.type(screen.getByRole("textbox"), "tenkacloudsample");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(await screen.findByText("Wrong (-10 pt) — total 0 pt")).toBeInTheDocument();
    expect(screen.getByText(/1 wrong/)).toBeInTheDocument();
    // 2 回目の不正解で回数表示が進む (= 「反応が無い」ように見えない)。
    await user.type(screen.getByRole("textbox"), "tenkacloudsample");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(await screen.findByText(/2 wrong/)).toBeInTheDocument();
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it("should show honest drill copy instead of the demo Easter-egg helper (#2711 follow-up)", () => {
    renderPanel({ problemId: LITE_DRILL_PROBLEM_ID, flags: DRILL_FLAGS }, "dev-mock");
    // 誤案内だった 「partial matches / Easter eggs もOK」 の demo helper を出さない。
    expect(screen.queryByText(/Easter eggs like/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Only the exact value from the text or the steps counts here/),
    ).toBeInTheDocument();
    // クイズ回答欄なので 「(deployment output value)」 接尾辞なしの素 label + 素 placeholder。
    expect(screen.getByText("1. Launcher スタック作成")).toBeInTheDocument();
    expect(screen.queryByText(/deployment output value/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type your answer")).toBeInTheDocument();
  });

  it("should keep the demo helper and labeled field for non-drill problems in dev-mock", () => {
    renderPanel({}, "dev-mock");
    expect(screen.getAllByText(/Easter eggs like/).length).toBeGreaterThan(0);
    expect(screen.getByText("Ep01: Reachability (deployment output value)")).toBeInTheDocument();
    expect(screen.queryByText(/Only the exact value from the text/)).not.toBeInTheDocument();
  });

  it("should drop the drill description outside dev-mock (backend keeps the field silent)", () => {
    // 将来ドリルを backend 評価に載せた場合も demo/drill helper は mock 専用のまま。
    const t = (key: string) => key;
    expect(subFlagFieldPresentation(true, false, "Step 1", t)).toEqual({
      label: "Step 1",
      description: undefined,
      placeholder: "problem_panel.flag_drill_placeholder",
    });
  });
});

describe("multi-verify extensions (issue #2252)", () => {
  const HINTED_FLAGS = [
    {
      id: "public-backup",
      label: "公開バックアップ",
      points: 50,
      solved: false,
      i18n: { en: { label: "Public backup" } },
      hints: [{ id: "h-backup", penalty: 2, revealed: false }],
    },
    { id: "weak-admin-pw", label: "弱い管理者パスワード", points: 70, solved: false },
  ];

  afterEach(() => {
    window.localStorage.removeItem("tenkacloud.portal.locale");
  });

  it("should render a per-check HintsPanel only for entries that carry hints", () => {
    renderPanel({ flags: HINTED_FLAGS });
    // HintsPanel の reveal ボタンが hint 付き check にだけ 1 つ出る
    expect(screen.getAllByRole("button", { name: /ヒント|hint/i })).toHaveLength(1);
  });

  it("should keep entries without hints unchanged (no HintsPanel)", () => {
    renderPanel({ flags: [HINTED_FLAGS[1]] });
    expect(screen.queryByRole("button", { name: /ヒント|hint/i })).not.toBeInTheDocument();
  });

  it("should show the i18n.en label when the locale is en and fall back to ja otherwise", () => {
    window.localStorage.setItem("tenkacloud.portal.locale", "en");
    const first = renderPanel({ flags: HINTED_FLAGS });
    expect(screen.getByText(/Public backup/)).toBeInTheDocument();
    first.unmount();

    window.localStorage.setItem("tenkacloud.portal.locale", "ja");
    renderPanel({ flags: HINTED_FLAGS });
    expect(screen.getByText(/公開バックアップ/)).toBeInTheDocument();
  });
});
