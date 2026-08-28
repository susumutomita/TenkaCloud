import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalValidationError } from "../api/portal-client";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";
import { FlagSubmissionPanel } from "./ProblemPanelFlagSubmission";

/**
 * FlagSubmissionPanel + HintsPanel を実 provider (AppConfigProvider + I18nProvider) で
 * render し、 flag submit (mock / backend × ok / wrong±penalty / already_scored / error /
 * 空入力) と progressive hint reveal (順序制約 #1315 / confirm modal / 成功 / error /
 * hint_out_of_order / dismiss / cancel / penalty 有無) を pin する。
 *
 * submitFlag / revealHint だけ mock し、 mock flag evaluator・PortalValidationError・i18n は実物。
 */

const apiMocks = vi.hoisted(() => ({
  revealHint: vi.fn(),
  submitFlag: vi.fn(),
}));

vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return { ...actual, revealHint: apiMocks.revealHint, submitFlag: apiMocks.submitFlag };
});

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
      <I18nProvider>{node}</I18nProvider>
    </AppConfigProvider>
  );
}

const baseProps = {
  apiBaseUrl: "https://api.example.com",
  sessionToken: "team-key",
  problemId: "hello-world",
  flagSubmitted: false,
  points: 100,
  hints: [],
  onScored: async () => undefined,
} as const;

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof FlagSubmissionPanel>> = {},
  mode: "backend" | "dev-mock" = "backend",
) {
  return render(withProviders(<FlagSubmissionPanel {...baseProps} {...overrides} />, mode));
}

const SUBMIT = "Submit flag (+100 pt)";

beforeEach(() => {
  // locale を en に固定して文言 assertion を deterministic にする。
  window.localStorage.setItem("tenkacloud.portal.locale", "en");
  apiMocks.revealHint.mockReset();
  apiMocks.submitFlag.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("FlagSubmissionPanel submit flow", () => {
  it("should show the celebrate alert when the flag is already submitted", () => {
    renderPanel({ flagSubmitted: true });
    expect(
      screen.getByText("You've already solved this problem. Move on to the next!"),
    ).toBeInTheDocument();
  });

  it("should not submit an empty flag", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: SUBMIT }));
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it("should celebrate locally in dev-mock mode on a correct flag", async () => {
    const user = userEvent.setup();
    renderPanel({}, "dev-mock");
    await user.type(screen.getByRole("textbox"), "tenkacloud");
    await user.click(screen.getByRole("button", { name: SUBMIT }));
    expect(await screen.findByText(/🎉 Correct!/)).toBeInTheDocument();
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it("should celebrate and refresh on a correct backend flag", async () => {
    const user = userEvent.setup();
    const onScored = vi.fn().mockResolvedValue(undefined);
    apiMocks.submitFlag.mockResolvedValue({ kind: "ok", scoreDelta: 50, totalScore: 150 });
    renderPanel({ onScored });
    await user.type(screen.getByRole("textbox"), "stack-output-abc123");
    await user.click(screen.getByRole("button", { name: SUBMIT }));
    expect(await screen.findByText(/🎉 Correct!\s+\+50 pt/)).toBeInTheDocument();
    expect(apiMocks.submitFlag).toHaveBeenCalledWith(
      "https://api.example.com",
      "team-key",
      "hello-world",
      "stack-output-abc123",
    );
    expect(onScored).toHaveBeenCalled();
  });

  it("should show a penalty warning on a wrong backend flag", async () => {
    const user = userEvent.setup();
    apiMocks.submitFlag.mockResolvedValue({
      kind: "wrong",
      scoreDelta: -10,
      totalScore: 40,
      wrongCount: 2,
    });
    renderPanel();
    await user.type(screen.getByRole("textbox"), "bad");
    await user.click(screen.getByRole("button", { name: SUBMIT }));
    expect(await screen.findByText("Wrong (-10 pt) — total 40 pt")).toBeInTheDocument();
  });

  it("should show a plain wrong warning when there is no penalty", async () => {
    const user = userEvent.setup();
    apiMocks.submitFlag.mockResolvedValue({
      kind: "wrong",
      scoreDelta: 0,
      totalScore: 0,
      wrongCount: 1,
    });
    renderPanel();
    await user.type(screen.getByRole("textbox"), "bad");
    await user.click(screen.getByRole("button", { name: SUBMIT }));
    expect(await screen.findByText("Check the value and try again.")).toBeInTheDocument();
  });

  it("should show the verifier's failure message when the wrong verdict carries one", async () => {
    const user = userEvent.setup();
    apiMocks.submitFlag.mockResolvedValue({
      kind: "wrong",
      scoreDelta: 0,
      totalScore: 0,
      wrongCount: 1,
      message: "the reason does not describe why this request was decided that way",
    });
    renderPanel();
    await user.type(screen.getByRole("textbox"), "bad");
    await user.click(screen.getByRole("button", { name: SUBMIT }));
    expect(
      await screen.findByText(
        "Reason from the verifier: the reason does not describe why this request was decided that way",
      ),
    ).toBeInTheDocument();
  });

  it("should show the already-scored info", async () => {
    const user = userEvent.setup();
    apiMocks.submitFlag.mockResolvedValue({ kind: "already_scored", totalScore: 100 });
    renderPanel();
    await user.type(screen.getByRole("textbox"), "late");
    await user.click(screen.getByRole("button", { name: SUBMIT }));
    expect(await screen.findByText("Already solved (total 100 pt).")).toBeInTheDocument();
  });

  it("should surface a submit error", async () => {
    const user = userEvent.setup();
    apiMocks.submitFlag.mockRejectedValue(new Error("server boom"));
    renderPanel();
    await user.type(screen.getByRole("textbox"), "x");
    await user.click(screen.getByRole("button", { name: SUBMIT }));
    expect(await screen.findByText("server boom")).toBeInTheDocument();
  });
});

const HINTS_3 = [
  { id: "hint-1", penalty: 10, revealed: false },
  { id: "hint-2", penalty: 20, revealed: false },
  { id: "hint-3", penalty: 30, revealed: false },
];

describe("HintsPanel order constraint (Issue #1315)", () => {
  function findRevealButtons(): HTMLButtonElement[] {
    // disabled な reveal button は aria-label に "Reveal Hint N first..." を持つ。
    // enabled な reveal button は inner text "Reveal hint" を持つ。 両方を拾うため
    // accessible name regex を union で書く。
    return screen.getAllByRole("button", {
      name: /Reveal hint|ヒントを公開する|Reveal Hint \d+ first|ヒント \d+ を先に公開/,
    }) as HTMLButtonElement[];
  }

  it("should enable only the first hint button when no hint is revealed", () => {
    renderPanel({ hints: HINTS_3 });
    const buttons = findRevealButtons();
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
    expect(buttons[2]).toBeDisabled();
  });

  it("should enable hint 2 and keep hint 3 disabled after hint 1 is revealed", () => {
    const hints = [
      { ...HINTS_3[0], revealed: true, content: "h1 content" },
      HINTS_3[1],
      HINTS_3[2],
    ];
    renderPanel({ hints });
    const buttons = findRevealButtons();
    // hint-1 は revealed なので reveal button は出ない (= 2 個)
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeEnabled(); // hint-2
    expect(buttons[1]).toBeDisabled(); // hint-3
  });

  it("should enable every hint button in flat mode regardless of order", () => {
    renderPanel({ hints: HINTS_3, revealOrder: "flat" });
    const buttons = findRevealButtons();
    expect(buttons).toHaveLength(3);
    // flat: 順序ゲート無し → 全 button enabled。 「先に公開してください」 の note も出ない。
    for (const button of buttons) expect(button).toBeEnabled();
    expect(screen.queryByText(/Reveal Hint \d+ first|ヒント \d+ を先に公開/)).toBeNull();
  });

  it("should render revealed hint content with a relative timestamp", () => {
    const { container } = renderPanel({
      hints: [
        {
          id: "hint-1",
          penalty: 10,
          revealed: true,
          content: "the secret answer",
          revealedAt: "2026-05-20T00:00:00Z",
        },
        HINTS_3[1],
      ],
    });
    expect(container.textContent).toContain("the secret answer");
  });
});

describe("HintsPanel reveal flow", () => {
  const oneHint = [{ id: "hint-1", penalty: 10, revealed: false }];

  async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Reveal hint" }));
    return screen.findByRole("button", { name: /^Reveal$/ });
  }

  it("should reveal a hint after confirmation and refresh", async () => {
    const user = userEvent.setup();
    apiMocks.revealHint.mockResolvedValue(undefined);
    const onScored = vi.fn().mockResolvedValue(undefined);
    renderPanel({ hints: oneHint, onScored });
    await user.click(await openConfirm(user));
    await waitFor(() =>
      expect(apiMocks.revealHint).toHaveBeenCalledWith(
        "https://api.example.com",
        "team-key",
        "hello-world",
        "hint-1",
      ),
    );
    expect(onScored).toHaveBeenCalled();
  });

  it("should display a friendly error when backend returns 409 hint_out_of_order", async () => {
    const user = userEvent.setup();
    apiMocks.revealHint.mockRejectedValueOnce(
      new PortalValidationError("hint_out_of_order", { missingHintId: "hint-1" }),
    );
    renderPanel({ hints: oneHint });
    await user.click(await openConfirm(user));
    expect(await screen.findByText("Reveal Hint 1 first before this one.")).toBeInTheDocument();
  });

  it("should default the ordered-hint index to 1 when missingHintId is absent", async () => {
    const user = userEvent.setup();
    apiMocks.revealHint.mockRejectedValueOnce(new PortalValidationError("hint_out_of_order"));
    renderPanel({ hints: oneHint });
    await user.click(await openConfirm(user));
    expect(await screen.findByText("Reveal Hint 1 first before this one.")).toBeInTheDocument();
  });

  it("should show the generic message for a non-validation reveal error", async () => {
    const user = userEvent.setup();
    apiMocks.revealHint.mockRejectedValueOnce(new Error("reveal boom"));
    renderPanel({ hints: oneHint });
    await user.click(await openConfirm(user));
    expect(await screen.findByText("reveal boom")).toBeInTheDocument();
  });

  it("should cancel the confirmation without calling the API", async () => {
    const user = userEvent.setup();
    renderPanel({ hints: oneHint });
    await openConfirm(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(apiMocks.revealHint).not.toHaveBeenCalled();
  });

  it("should dismiss the confirmation modal via the close button", async () => {
    const user = userEvent.setup();
    renderPanel({ hints: oneHint });
    await openConfirm(user);
    // Cloudscape Modal の閉じる (X) ボタンは portal 上に出るので document から引く → onDismiss 発火。
    const dismiss = document.querySelector<HTMLButtonElement>('button[class*="dismiss-control"]');
    expect(dismiss).not.toBeNull();
    await user.click(dismiss as HTMLButtonElement);
    expect(apiMocks.revealHint).not.toHaveBeenCalled();
  });

  it("should show the no-penalty confirmation copy for a free hint", async () => {
    const user = userEvent.setup();
    renderPanel({ hints: [{ id: "hint-1", penalty: 0, revealed: false }] });
    expect(screen.getByText("(penalty-free)")).toBeInTheDocument();
    expect(screen.queryByText("(-0 pt to reveal)")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal hint" }));
    expect(
      await screen.findByText("No penalty for this hint. Revealing will display the content."),
    ).toBeInTheDocument();
  });

  it("should reveal locally in dev-mock mode without calling the backend (#2707)", async () => {
    const user = userEvent.setup();
    // dev-mock は fixture が content を同梱し、 開封状態だけローカル state で持つ。
    renderPanel(
      { hints: [{ id: "hint-1", penalty: 0, revealed: false, content: "step-by-step here" }] },
      "dev-mock",
    );
    expect(screen.queryByText("step-by-step here")).not.toBeInTheDocument();
    const confirm = await openConfirm(user);
    await user.click(confirm);
    expect(await screen.findByText("step-by-step here")).toBeInTheDocument();
    expect(apiMocks.revealHint).not.toHaveBeenCalled();
  });
});

/**
 * [#2929] Solving a problem used to erase its hints: the panel early-returned on the
 * cleared state and never reached the hint list. What vanished was not only the study
 * record but the *explanation of the score* — hint penalties are deducted at reveal time,
 * so with the hints gone the screen showed "🎉 +100 pt" beside "total 80 pt" and nothing
 * accounting for the 20.
 *
 * Unopened hints stay shut afterwards on purpose: a penalty has no meaning once the
 * problem is solved, so revealing them for free would only punish the participant who
 * held out.
 */
describe("FlagSubmissionPanel hint review after solving (#2929)", () => {
  const HINTS = [
    { id: "h1", penalty: 20, revealed: true, content: "Look at the backup file" },
    { id: "h2", penalty: 30, revealed: false },
  ] as const;

  it("should still show a revealed hint's content after the flag is submitted", () => {
    renderPanel({ flagSubmitted: true, hints: HINTS });
    expect(screen.getByText(/Look at the backup file/)).toBeInTheDocument();
  });

  it("should account for the deduction so the total can be explained", () => {
    renderPanel({ flagSubmitted: true, hints: HINTS });
    // Only the opened hint counts — h2 was never revealed, so it never cost anything.
    expect(screen.getByText(/-20 pt/)).toBeInTheDocument();
  });

  it("should leave an unopened hint closed, with no way to reveal it for free", () => {
    renderPanel({ flagSubmitted: true, hints: HINTS });
    expect(screen.getByText(/Left unopened/)).toBeInTheDocument();
    // "Reveal hint" is the per-hint affordance; the modal's confirm button is just
    // "Reveal" and is always mounted, so the exact name matters here.
    expect(screen.queryByRole("button", { name: "Reveal hint" })).not.toBeInTheDocument();
  });

  it("should omit the deduction line when no hint was ever opened", () => {
    const untouched = [{ id: "h1", penalty: 20, revealed: false }] as const;
    renderPanel({ flagSubmitted: true, hints: untouched });
    expect(screen.queryByText(/-20 pt/)).not.toBeInTheDocument();
    expect(screen.getByText(/Left unopened/)).toBeInTheDocument();
  });

  it("should keep the celebration alert alongside the hints", () => {
    renderPanel({ flagSubmitted: true, hints: HINTS });
    expect(screen.getByText(/Look at the backup file/)).toBeInTheDocument();
    // The cleared state itself must not be replaced by the hint list.
    expect(screen.getByText(/100/)).toBeInTheDocument();
  });

  it("should show the hints immediately after a successful submit, not only on reload", () => {
    // The "+100 / total 80" screen is the one where the mismatch was visible.
    apiMocks.submitFlag.mockResolvedValue({ kind: "ok", scoreDelta: 100, totalScore: 80 });
    renderPanel({ hints: HINTS });
    return (async () => {
      await userEvent.type(screen.getByRole("textbox"), "FLAG{x}");
      await userEvent.click(screen.getByRole("button", { name: SUBMIT }));
      await waitFor(() => expect(screen.getByText(/Look at the backup file/)).toBeInTheDocument());
      expect(screen.getByText(/-20 pt/)).toBeInTheDocument();
    })();
  });

  it("should render nothing extra for a solved problem that has no hints at all", () => {
    renderPanel({ flagSubmitted: true, hints: [] });
    expect(screen.queryByText(/Left unopened/)).not.toBeInTheDocument();
    expect(screen.queryByText(/already deducted/)).not.toBeInTheDocument();
  });
});
