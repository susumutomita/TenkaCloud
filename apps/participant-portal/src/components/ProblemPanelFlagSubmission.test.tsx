import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalValidationError } from "../api/portal-client";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";
import { FlagSubmissionPanel } from "./ProblemPanelFlagSubmission";

/**
 * Issue #1315: progressive hint reveal の順序制約 (= Hint N は Hint 1..N-1 が
 * revealed のときのみ enable) と、 backend 409 hint_out_of_order を受け取ったときの
 * UI message 表示を pin する。
 */

const apiMocks = vi.hoisted(() => ({
  revealHint: vi.fn(),
  submitFlag: vi.fn(),
}));

vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return { ...actual, revealHint: apiMocks.revealHint, submitFlag: apiMocks.submitFlag };
});

function withProviders(node: React.ReactNode) {
  // mode="backend" (= isMock=false) で revealHint API を実際に叩く (= mock 経由) ルートを通す。
  return (
    <AppConfigProvider
      config={{
        apiBaseUrl: "https://api.example.com",
        eventTitle: "Test event",
        eventRegion: "ap-northeast-1",
        mode: "backend",
        cloudMode: "real",
      }}
    >
      <I18nProvider>{node}</I18nProvider>
    </AppConfigProvider>
  );
}

const HINTS_3 = [
  { id: "hint-1", penalty: 10, revealed: false },
  { id: "hint-2", penalty: 20, revealed: false },
  { id: "hint-3", penalty: 30, revealed: false },
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("HintsPanel order constraint (Issue #1315)", () => {
  beforeEach(() => {
    apiMocks.revealHint.mockReset();
  });

  function findRevealButtons(): HTMLButtonElement[] {
    // disabled な reveal button は aria-label に "Reveal Hint N first..." を持つ。
    // enabled な reveal button は inner text "Reveal hint" を持つ。 両方を拾うため
    // accessible name regex を union で書く。
    return screen.getAllByRole("button", {
      name: /Reveal hint|ヒントを公開する|Reveal Hint \d+ first|ヒント \d+ を先に公開/,
    }) as HTMLButtonElement[];
  }

  it("should enable only the first hint button when no hint is revealed", () => {
    render(
      withProviders(
        <FlagSubmissionPanel
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          problemId="hello-world"
          flagSubmitted={false}
          points={100}
          hints={HINTS_3}
          onScored={async () => undefined}
        />,
      ),
    );
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
    ] as typeof HINTS_3;
    render(
      withProviders(
        <FlagSubmissionPanel
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          problemId="hello-world"
          flagSubmitted={false}
          points={100}
          hints={hints}
          onScored={async () => undefined}
        />,
      ),
    );
    const buttons = findRevealButtons();
    // hint-1 は revealed なので reveal button は出ない (= 2 個)
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeEnabled(); // hint-2
    expect(buttons[1]).toBeDisabled(); // hint-3
  });

  it("should display a friendly error message when backend returns 409 hint_out_of_order", async () => {
    // ユーザーが hint 1 を即座に reveal しようとした瞬間 (= state はまだ revealed=false で
    // button enable) に race condition で hint-2 が backend に到達するケースを想定。
    // backend の 409 hint_out_of_order を受け取って 「ヒント N を先に公開してください」 を出す。
    apiMocks.revealHint.mockRejectedValueOnce(
      new PortalValidationError("hint_out_of_order", { missingHintId: "hint-1" }),
    );
    const user = userEvent.setup();
    render(
      withProviders(
        <FlagSubmissionPanel
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          problemId="hello-world"
          flagSubmitted={false}
          points={100}
          // hint-1 を artificially enable して click → reject される動線
          hints={[{ ...HINTS_3[0], revealed: false }]}
          onScored={async () => undefined}
        />,
      ),
    );
    const revealButton = screen.getByRole("button", { name: /Reveal hint|ヒントを公開する/ });
    await user.click(revealButton);
    // confirm modal の submit を押す
    const confirmButton = await screen.findByRole("button", { name: /^Reveal$|^公開する$/ });
    await user.click(confirmButton);

    await waitFor(() => {
      // 「ヒント 1 を先に公開してください」 / 「Reveal Hint 1 first before this one.」 を期待
      const errorEl = screen.queryByText(/Hint 1 first|ヒント 1 を先に公開/);
      expect(errorEl).not.toBeNull();
    });
  });
});
