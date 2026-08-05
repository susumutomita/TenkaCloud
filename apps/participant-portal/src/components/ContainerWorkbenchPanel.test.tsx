import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";
import { ContainerWorkbenchPanel } from "./ContainerWorkbenchPanel";

const apiMocks = vi.hoisted(() => ({
  getWorkbenchConfig: vi.fn(),
  getWorkbenchStarter: vi.fn(),
  inspectWorkbench: vi.fn(),
  testWorkbench: vi.fn(),
  prepareWorkbench: vi.fn(),
  submitFlag: vi.fn(),
}));

vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return { ...actual, ...apiMocks };
});

const FLAGS = [
  { id: "implement", label: "Implement", points: 60, solved: false, input: "multiline" as const },
  { id: "explain", label: "Explain", points: 40, solved: false },
];

const CONFIG = {
  id: "course-problem",
  name: "Course problem",
  description: "Edit, inspect, and test.",
  submittedFiles: ["solution.py"],
  checkpoints: [
    { id: "implement", label: "Implement", kind: "code" as const },
    { id: "explain", label: "Explain", kind: "answer" as const },
  ],
};

function withProviders(node: React.ReactNode) {
  return (
    <AppConfigProvider
      config={{
        apiBaseUrl: "http://127.0.0.1:3000",
        eventTitle: "Test event",
        eventRegion: "ap-northeast-1",
        mode: "backend",
        cloudMode: "real",
      }}
    >
      <I18nProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </I18nProvider>
    </AppConfigProvider>
  );
}

function renderPanel() {
  return render(
    withProviders(
      <ContainerWorkbenchPanel
        apiBaseUrl="http://127.0.0.1:3000"
        sessionToken="team-key"
        problemId="course-problem"
        flags={FLAGS}
        onScored={async () => undefined}
      />,
    ),
  );
}

beforeEach(() => {
  window.localStorage.setItem("tenkacloud.portal.locale", "en");
  apiMocks.getWorkbenchConfig.mockResolvedValue(CONFIG);
  apiMocks.getWorkbenchStarter.mockResolvedValue({ "solution.py": "pass\n" });
  apiMocks.inspectWorkbench.mockResolvedValue({ output: "seeded evidence" });
  apiMocks.testWorkbench.mockResolvedValue({ passed: true, output: "2 passed" });
  apiMocks.prepareWorkbench.mockResolvedValue({
    ok: true,
    submissions: { implement: "sealed-source" },
  });
  apiMocks.submitFlag.mockResolvedValue({ kind: "ok", scoreDelta: 60, totalScore: 60 });
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("ContainerWorkbenchPanel", () => {
  it("should edit, inspect, test, prepare, and submit through the authenticated Portal API", async () => {
    const user = userEvent.setup();
    renderPanel();

    const editor = await screen.findByLabelText("solution.py");
    expect(
      screen.getByText("This checkpoint submits the current source from the editors above."),
    ).toBeInTheDocument();
    await user.clear(editor);
    await user.type(editor, "def solve(): return 42\n");
    await user.type(screen.getByLabelText("Explain"), "because constraints bind the witness");

    await user.click(screen.getByRole("button", { name: "Inspect evidence" }));
    expect(await screen.findByText("seeded evidence")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run public tests" }));
    expect(await screen.findByText("2 passed")).toBeInTheDocument();
    expect(apiMocks.testWorkbench).toHaveBeenCalledWith(
      "http://127.0.0.1:3000",
      "team-key",
      "course-problem",
      { "solution.py": "def solve(): return 42\n" },
    );

    await user.click(screen.getByRole("button", { name: "Submit (+60 pt)" }));
    await waitFor(() =>
      expect(apiMocks.prepareWorkbench).toHaveBeenCalledWith(
        "http://127.0.0.1:3000",
        "team-key",
        "course-problem",
        { "solution.py": "def solve(): return 42\n" },
        { explain: "because constraints bind the witness" },
      ),
    );
    expect(apiMocks.submitFlag).toHaveBeenCalledWith(
      "http://127.0.0.1:3000",
      "team-key",
      "course-problem",
      "sealed-source",
      "implement",
    );
  });

  it("should surface action failures, render a failing test, and restore the starter", async () => {
    const user = userEvent.setup();
    apiMocks.inspectWorkbench.mockRejectedValueOnce(new Error("inspect offline"));
    apiMocks.testWorkbench
      .mockRejectedValueOnce(new Error("test offline"))
      .mockResolvedValueOnce({ passed: false, output: "1 failed" });
    renderPanel();

    const editor = await screen.findByLabelText("solution.py");
    await user.clear(editor);
    await user.type(editor, "broken\n");
    await user.click(screen.getByRole("button", { name: "Inspect evidence" }));
    expect(await screen.findByText("Problem editor action failed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run public tests" }));
    await waitFor(() => expect(apiMocks.testWorkbench).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Problem editor action failed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run public tests" }));
    expect(await screen.findByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("Public tests have not passed yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore starter" }));
    expect(editor).toHaveValue("pass\n");
    expect(screen.queryByText("1 failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Problem editor action failed")).not.toBeInTheDocument();
  });

  it("should fall back to a legacy direct answer when prepare omits it", async () => {
    const user = userEvent.setup();
    apiMocks.prepareWorkbench.mockResolvedValueOnce({ ok: true, submissions: {} });
    renderPanel();

    await screen.findByLabelText("solution.py");
    await user.type(screen.getByLabelText("Explain"), "  direct answer  ");
    await user.click(screen.getByRole("button", { name: "Submit (+40 pt)" }));
    await waitFor(() =>
      expect(apiMocks.submitFlag).toHaveBeenCalledWith(
        "http://127.0.0.1:3000",
        "team-key",
        "course-problem",
        "direct answer",
        "explain",
      ),
    );
  });

  it("should fall back to one edited source file when prepare returns an empty value", async () => {
    const user = userEvent.setup();
    apiMocks.prepareWorkbench.mockResolvedValueOnce({
      ok: true,
      submissions: { implement: "" },
    });
    renderPanel();

    await screen.findByLabelText("solution.py");
    await user.click(screen.getByRole("button", { name: "Submit (+60 pt)" }));
    await waitFor(() =>
      expect(apiMocks.submitFlag).toHaveBeenCalledWith(
        "http://127.0.0.1:3000",
        "team-key",
        "course-problem",
        "pass\n",
        "implement",
      ),
    );
    expect(apiMocks.prepareWorkbench).toHaveBeenCalledWith(
      "http://127.0.0.1:3000",
      "team-key",
      "course-problem",
      { "solution.py": "pass\n" },
      { explain: "" },
    );
  });

  it("should serialize multiple edited files for a legacy code checkpoint", async () => {
    const user = userEvent.setup();
    apiMocks.getWorkbenchConfig.mockResolvedValue({
      ...CONFIG,
      submittedFiles: ["solution.py", "helper.py"],
    });
    apiMocks.getWorkbenchStarter.mockResolvedValue({
      "solution.py": "pass\n",
      "helper.py": "VALUE = 1\n",
    });
    apiMocks.prepareWorkbench.mockResolvedValueOnce({ ok: true, submissions: {} });
    renderPanel();

    await screen.findByLabelText("helper.py");
    await user.click(screen.getByRole("button", { name: "Submit (+60 pt)" }));
    await waitFor(() =>
      expect(apiMocks.submitFlag).toHaveBeenCalledWith(
        "http://127.0.0.1:3000",
        "team-key",
        "course-problem",
        JSON.stringify({ "solution.py": "pass\n", "helper.py": "VALUE = 1\n" }),
        "implement",
      ),
    );
  });

  it("should refuse prepare failures", async () => {
    const user = userEvent.setup();
    apiMocks.prepareWorkbench.mockResolvedValueOnce({
      ok: false,
      output: "public tests must pass",
    });
    renderPanel();

    await screen.findByLabelText("solution.py");
    await user.click(screen.getByRole("button", { name: "Submit (+60 pt)" }));
    expect(await screen.findByText("public tests must pass")).toBeInTheDocument();
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });

  it.each([
    ["problem id", { ...CONFIG, id: "wrong-problem" }],
    ["submitted file count", { ...CONFIG, submittedFiles: ["solution.py", "extra.py"] }],
    ["submitted file name", { ...CONFIG, submittedFiles: ["other.py"] }],
    ["checkpoint count", { ...CONFIG, checkpoints: [CONFIG.checkpoints[0]] }],
    [
      "duplicate checkpoint",
      { ...CONFIG, checkpoints: [CONFIG.checkpoints[0], CONFIG.checkpoints[0]] },
    ],
    [
      "unknown checkpoint",
      {
        ...CONFIG,
        checkpoints: [
          CONFIG.checkpoints[0],
          { id: "unknown", label: "Unknown", kind: "answer" as const },
        ],
      },
    ],
    [
      "checkpoint kind",
      {
        ...CONFIG,
        checkpoints: [{ ...CONFIG.checkpoints[0], kind: "answer" as const }, CONFIG.checkpoints[1]],
      },
    ],
  ])("should reject a config with a mismatched %s", async (_label, config) => {
    apiMocks.getWorkbenchConfig.mockResolvedValue(config);
    renderPanel();
    expect(await screen.findByText("Problem editor unavailable")).toBeInTheDocument();
  });

  it("should render a load error when capability discovery fails", async () => {
    apiMocks.getWorkbenchConfig.mockRejectedValueOnce(new Error("offline"));
    renderPanel();
    expect(await screen.findByText("Problem editor unavailable")).toBeInTheDocument();
  });

  it("should ignore a capability error after the panel unmounts", async () => {
    let rejectConfig!: (error: Error) => void;
    apiMocks.getWorkbenchConfig.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectConfig = reject;
      }),
    );
    const { unmount } = renderPanel();
    unmount();
    await act(async () => rejectConfig(new Error("late failure")));
  });

  it("should preserve the ordinary multi-checkpoint form when the config probe returns 404", async () => {
    apiMocks.getWorkbenchConfig.mockResolvedValue(undefined);
    renderPanel();
    expect(await screen.findByLabelText("Implement")).toBeInTheDocument();
    expect(screen.getByLabelText("Explain")).toBeInTheDocument();
    expect(apiMocks.getWorkbenchStarter).not.toHaveBeenCalled();
  });
});
