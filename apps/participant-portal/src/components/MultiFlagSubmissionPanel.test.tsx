import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";
import { MultiFlagSubmissionPanel } from "./MultiFlagSubmissionPanel";

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
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("MultiFlagSubmissionPanel", () => {
  it("should render one input per unsolved flag", () => {
    renderPanel();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.getByText("Flags solved: 0 / 2")).toBeInTheDocument();
  });

  it("should show a solved alert and no input for an already-solved flag", () => {
    renderPanel({
      flags: [
        { ...FLAGS[0], solved: true },
        FLAGS[1],
      ],
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
    expect(screen.getByText("All flags solved. This problem is fully cleared!")).toBeInTheDocument();
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
});
