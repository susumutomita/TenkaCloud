import { LITE_DRILL_CHECKPOINTS, LITE_DRILL_PROBLEM_ID } from "@tenkacloud/portal-contracts";
import { render, screen, waitFor } from "@testing-library/react";
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
  MultiFlagSubmissionPanel,
  onboardingVariantFromSearch,
  resolveOnboardingVariant,
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
  const stableOverrides =
    overrides.problemId === WHAT_IS_DRILL_PROBLEM_ID && overrides.onboardingVariant === undefined
      ? { ...overrides, onboardingVariant: "list" as const }
      : overrides;
  return render(
    withProviders(<MultiFlagSubmissionPanel {...baseProps} {...stableOverrides} />, mode),
  );
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
  delete window.gtag;
  delete window.dataLayer;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
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

  it("should render zero progress when a problem has no flags", () => {
    renderPanel({ flags: [] });
    expect(screen.getByText("Flags solved: 0 / 0")).toBeInTheDocument();
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

  const TUTORIAL_FLAGS = [
    { id: "tenka-what", label: "1. Practice environment", points: 100, solved: false },
    { id: "battle-challenge", label: "2. Competition format", points: 100, solved: false },
    { id: "choose-mode", label: "3. Runtime mode", points: 100, solved: false },
    { id: "read-problem", label: "4. Reveal a hint", points: 100, solved: false },
    {
      id: "open-endpoint",
      label: "5. Submit the endpoint connection code",
      points: 100,
      solved: false,
    },
    { id: "first-flag", label: "6. Submit the flag", points: 100, solved: false },
  ].map((flag, index) => ({
    ...flag,
    hints: [
      {
        id: `tutorial-h${index + 1}`,
        penalty: 0,
        revealed: false,
        content:
          index === 3 ? "Read the problem statement before starting." : `Hint for ${flag.label}`,
      },
    ],
  }));

  const TUTORIAL_ANSWERS = [
    "real cloud",
    "battle",
    "local",
    "problem statement",
    "CONNECTED",
    "TC{HELLO-TENKACLOUD}",
  ];

  async function solveTutorial(user: ReturnType<typeof userEvent.setup>) {
    for (const [index, answer] of TUTORIAL_ANSWERS.entries()) {
      const input = screen.getAllByRole("textbox")[0];
      await user.click(input);
      await user.paste(answer);
      await user.click(screen.getAllByRole("button", { name: /^Submit/ })[0]);
      await screen.findByText(`Flags solved: ${index + 1} / 6`);
    }
  }

  it("should use the standard six-flag problem UI instead of a bespoke choice quiz", () => {
    renderPanel({ problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: TUTORIAL_FLAGS }, "dev-mock");

    expect(screen.getByText("Flags solved: 0 / 6")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(6);
    expect(screen.getAllByRole("button", { name: "Reveal hint" })).toHaveLength(6);
    expect(screen.queryByText("Next step")).not.toBeInTheDocument();
  });

  it("should offer a one-at-a-time variant without replacing real flag, hint, or scoring controls", async () => {
    const user = userEvent.setup();
    renderPanel(
      {
        problemId: WHAT_IS_DRILL_PROBLEM_ID,
        flags: TUTORIAL_FLAGS,
        onboardingVariant: "step",
      },
      "dev-mock",
    );

    expect(screen.getByText("Step 1 of 6")).toBeInTheDocument();
    expect(screen.getByText("0 cleared")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Reveal hint" })).toHaveLength(1);

    await user.type(screen.getByRole("textbox"), "real cloud");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));

    expect(await screen.findByText("Step 2 of 6")).toBeInTheDocument();
    expect(screen.getByText("1 cleared")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "2. Competition format" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Reveal hint" })).toHaveLength(1);
  });

  it("should resolve a forced preview variant when no variant prop is provided", () => {
    window.history.replaceState(null, "", "/?onboarding=step");
    render(
      withProviders(
        <MultiFlagSubmissionPanel
          {...baseProps}
          problemId={WHAT_IS_DRILL_PROBLEM_ID}
          flags={TUTORIAL_FLAGS}
        />,
        "dev-mock",
      ),
    );

    expect(screen.getByText("Step 1 of 6")).toBeInTheDocument();
    expect(document.querySelector("[data-onboarding-variant]")).toHaveAttribute(
      "data-onboarding-variant",
      "step",
    );
  });

  it("should provide the real hint confirmation and reveal experience", async () => {
    const user = userEvent.setup();
    renderPanel({ problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: TUTORIAL_FLAGS }, "dev-mock");

    await user.click(screen.getAllByRole("button", { name: "Reveal hint" })[3]);
    expect(screen.getAllByText("Reveal hint 1?").length).toBeGreaterThan(0);
    expect(
      screen.getByText("No penalty for this hint. Revealing will display the content."),
    ).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Reveal" })[3]);

    expect(
      await screen.findByText(/Read the problem statement before starting/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Hints (1 / 1 revealed)").length).toBeGreaterThan(0);
  });

  it("should measure the real hint and scoring flow without sending the submitted answer", async () => {
    const user = userEvent.setup();
    const gtag = vi.fn();
    window.gtag = gtag;
    renderPanel(
      {
        problemId: WHAT_IS_DRILL_PROBLEM_ID,
        flags: TUTORIAL_FLAGS,
        onboardingVariant: "step",
      },
      "dev-mock",
    );

    await user.click(screen.getByRole("button", { name: "Reveal hint" }));
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    await user.type(screen.getByRole("textbox"), "real cloud");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    await screen.findByText("Step 2 of 6");

    expect(gtag).toHaveBeenCalledWith(
      "event",
      "onboarding_hint_reveal",
      expect.objectContaining({
        onboarding_variant: "step",
        onboarding_step: "tenka-what",
        step_index: 1,
      }),
    );
    expect(gtag).toHaveBeenCalledWith(
      "event",
      "onboarding_step_complete",
      expect.objectContaining({
        onboarding_variant: "step",
        onboarding_step: "tenka-what",
        step_index: 1,
      }),
    );
    expect(JSON.stringify(gtag.mock.calls)).not.toContain("real cloud");
  });

  it("should suppress duplicate step views and track a wrong attempt", async () => {
    const user = userEvent.setup();
    const gtag = vi.fn();
    window.gtag = gtag;
    const props = {
      problemId: WHAT_IS_DRILL_PROBLEM_ID,
      flags: TUTORIAL_FLAGS,
      onboardingVariant: "step" as const,
    };
    const view = renderPanel(props, "dev-mock");

    view.rerender(
      withProviders(
        <MultiFlagSubmissionPanel {...baseProps} {...props} flags={[...TUTORIAL_FLAGS]} />,
        "dev-mock",
      ),
    );
    await waitFor(() => {
      const firstStepViews = gtag.mock.calls.filter(
        ([, eventName, parameters]) =>
          eventName === "onboarding_step_view" &&
          parameters.onboarding_step === TUTORIAL_FLAGS[0].id,
      );
      expect(firstStepViews).toHaveLength(1);
    });

    await user.type(screen.getByRole("textbox"), "not the answer");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(await screen.findByText(/Wrong \(-10 pt\)/)).toBeInTheDocument();
    expect(gtag).toHaveBeenCalledWith(
      "event",
      "onboarding_submit",
      expect.objectContaining({
        onboarding_variant: "step",
        onboarding_result: "wrong",
      }),
    );
  });

  it("should not emit onboarding analytics from an ordinary multi-flag problem", async () => {
    const user = userEvent.setup();
    const gtag = vi.fn();
    window.gtag = gtag;
    renderPanel(
      {
        flags: [
          {
            ...FLAGS[0],
            hints: [
              {
                id: "ordinary-hint",
                penalty: 0,
                revealed: false,
                content: "Ordinary hint",
              },
            ],
          },
        ],
      },
      "dev-mock",
    );

    await user.click(screen.getByRole("button", { name: "Reveal hint" }));
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    await user.type(screen.getByRole("textbox"), "wrong");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(await screen.findByText(/Wrong \(-10 pt\)/)).toBeInTheDocument();
    expect(gtag).not.toHaveBeenCalled();
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it("should score all six rows through the real multi-flag path and show the handoff", async () => {
    const user = userEvent.setup();
    renderPanel({ problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: TUTORIAL_FLAGS }, "dev-mock");

    await solveTutorial(user);

    expect(
      screen.getByText("All flags solved. This problem is fully cleared!"),
    ).toBeInTheDocument();
    expect(screen.getByText("🎉 You have the TenkaCloud basics")).toBeInTheDocument();
    expect(screen.getByText(/opened the practice endpoint/)).toBeInTheDocument();
    expect(screen.getByText("Next: try a real problem in local mode")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open participant manual (opens in a new tab)" }),
    ).toHaveAttribute("href", "https://tenkacloud.com/docs/manual/participant/");
    await user.click(screen.getByRole("button", { name: "Try local mode" }));
    expect(screen.getByTestId("router-path")).toHaveTextContent(`/problems/${LOCAL_DRILL_JOB_ID}`);
    await user.click(
      screen.getByRole("button", { name: "Go to “Deploy your own TenkaCloud Lite”" }),
    );
    expect(screen.getByTestId("router-path")).toHaveTextContent(`/problems/${LITE_DRILL_JOB_ID}`);
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it("should restore all mock-solved rows after reopening the problem", async () => {
    const user = userEvent.setup();
    const first = renderPanel(
      { problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: TUTORIAL_FLAGS },
      "dev-mock",
    );
    await solveTutorial(user);
    first.unmount();

    renderPanel({ problemId: WHAT_IS_DRILL_PROBLEM_ID, flags: TUTORIAL_FLAGS }, "dev-mock");
    expect(screen.getByText("Flags solved: 6 / 6")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("🎉 You have the TenkaCloud basics")).toBeInTheDocument();
  });
});

describe("onboarding variant assignment", () => {
  it("should accept only explicit list and step preview parameters", () => {
    expect(onboardingVariantFromSearch("?onboarding=list")).toBe("list");
    expect(onboardingVariantFromSearch("?onboarding=step")).toBe("step");
    expect(onboardingVariantFromSearch("?onboarding=unknown")).toBeUndefined();
    expect(onboardingVariantFromSearch("")).toBeUndefined();
  });

  it("should split new visitors, persist the assignment, and let preview URLs override it", () => {
    const storage = new Map<string, string>();
    const store = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    };

    expect(resolveOnboardingVariant({ search: "", storage: store, sample: () => 0.1 })).toBe(
      "list",
    );
    expect(resolveOnboardingVariant({ search: "", storage: store, sample: () => 0.9 })).toBe(
      "list",
    );
    expect(
      resolveOnboardingVariant({ search: "?onboarding=step", storage: store, sample: () => 0.1 }),
    ).toBe("step");

    storage.clear();
    expect(resolveOnboardingVariant({ search: "", storage: store, sample: () => 0.9 })).toBe(
      "step",
    );
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
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.paste(CHECKPOINT.code);
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
