import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfigProvider } from "../config-context";
import { I18nProvider, useI18n } from "../i18n";
import { ContainerWorkbenchPanel } from "./ContainerWorkbenchPanel";
import { workbenchDraftKey } from "./workbench-drafts";

const apiMocks = vi.hoisted(() => ({
  getWorkbenchConfig: vi.fn(),
  getWorkbenchStarter: vi.fn(),
  inspectWorkbench: vi.fn(),
  testWorkbench: vi.fn(),
  prepareWorkbench: vi.fn(),
  submitFlag: vi.fn(),
}));

vi.mock("../api/portal-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/portal-client")>()),
  ...apiMocks,
}));

const API = "http://127.0.0.1:3000";
const TOKEN = "synthetic-participant-key-never-save";
const FLAGS = [
  { id: "implement", label: "Implement", points: 60, solved: false, input: "multiline" as const },
];
const CONFIG = {
  id: "course-problem",
  name: "Course problem",
  description: "Edit, inspect, and test.",
  submittedFiles: ["solution.py"],
  checkpoints: [{ id: "implement", label: "Implement", kind: "code" as const }],
};
const STARTER = { "solution.py": "pass\n" };
const DRAFT_KEY = workbenchDraftKey(API, "job-team-a-event-a", CONFIG.id) as string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function LocaleToggle() {
  const { setLocale } = useI18n();
  return (
    <button type="button" onClick={() => setLocale("ja")}>
      Japanese
    </button>
  );
}

function panel({
  jobId = "job-team-a-event-a",
  apiBaseUrl = API,
  sessionToken = TOKEN,
  problemId = "course-problem",
} = {}) {
  return (
    <AppConfigProvider
      config={{
        apiBaseUrl,
        eventTitle: "Test event",
        eventRegion: "local",
        mode: "backend",
        cloudMode: "real",
      }}
    >
      <I18nProvider>
        <MemoryRouter>
          <LocaleToggle />
          <ContainerWorkbenchPanel
            apiBaseUrl={apiBaseUrl}
            sessionToken={sessionToken}
            problemId={problemId}
            jobId={jobId}
            flags={FLAGS}
            onScored={async () => undefined}
          />
        </MemoryRouter>
      </I18nProvider>
    </AppConfigProvider>
  );
}

async function editCode(code: string) {
  const editor = await screen.findByLabelText("solution.py");
  fireEvent.change(editor, { target: { value: code } });
  expect(editor).toHaveValue(code);
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("tenkacloud.portal.locale", "en");
  apiMocks.getWorkbenchConfig.mockResolvedValue(CONFIG);
  apiMocks.getWorkbenchStarter.mockResolvedValue(STARTER);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  window.localStorage.clear();
});

describe("workbench code drafts", () => {
  it("restores unfinished code after reload or stop/resume remount", async () => {
    const view = render(panel());
    await editCode("unfinished = 42\n");
    view.unmount();
    render(panel());
    expect(await screen.findByLabelText("solution.py")).toHaveValue("unfinished = 42\n");
  });

  it("preserves code across a language change without reloading the starter", async () => {
    render(panel());
    await editCode("unfinished = 42\n");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Japanese" })));
    expect(await screen.findByLabelText("solution.py")).toHaveValue("unfinished = 42\n");
    expect(apiMocks.getWorkbenchStarter).toHaveBeenCalledTimes(1);
  });

  it("retains all files, including an intentionally empty file, under StrictMode remounts", async () => {
    apiMocks.getWorkbenchConfig.mockResolvedValue({
      ...CONFIG,
      submittedFiles: ["solution.py", "helper.py"],
    });
    apiMocks.getWorkbenchStarter.mockResolvedValue({ ...STARTER, "helper.py": "original helper" });
    const view = render(<StrictMode>{panel()}</StrictMode>);
    await editCode("incomplete multi-file solution\n");
    fireEvent.change(screen.getByLabelText("helper.py"), { target: { value: "" } });
    view.unmount();
    render(<StrictMode>{panel()}</StrictMode>);
    expect(await screen.findByLabelText("solution.py")).toHaveValue(
      "incomplete multi-file solution\n",
    );
    expect(screen.getByLabelText("helper.py")).toHaveValue("");
  });

  it.each([
    ["team", { jobId: "job-team-b-event-a" }],
    ["event", { jobId: "job-team-a-event-b" }],
    ["replacement job", { jobId: "replacement-job-team-a-event-a" }],
    ["API host", { apiBaseUrl: "https://other.example.test/api" }],
    ["API port", { apiBaseUrl: "http://127.0.0.1:3001" }],
    ["API path", { apiBaseUrl: `${API}/another-api` }],
    ["problem", { problemId: "other-problem" }],
  ])("does not reuse a draft for another %s", async (_name, other) => {
    const view = render(panel());
    await editCode("original job draft\n");
    apiMocks.getWorkbenchConfig.mockResolvedValue({
      ...CONFIG,
      id: "problemId" in other ? other.problemId : CONFIG.id,
    });
    view.rerender(panel(other));
    expect(await screen.findByLabelText("solution.py")).toHaveValue("pass\n");
    await editCode("different scope draft\n");
    apiMocks.getWorkbenchConfig.mockResolvedValue(CONFIG);
    view.rerender(panel());
    expect(await screen.findByLabelText("solution.py")).toHaveValue("original job draft\n");
  });

  it("uses no authentication values in saved keys or files, including after token rotation", async () => {
    const view = render(panel());
    await editCode("private unfinished code\n");
    view.rerender(panel({ sessionToken: "rotated-synthetic-key" }));
    expect(await screen.findByLabelText("solution.py")).toHaveValue("private unfinished code\n");
    const saved = Object.entries(window.localStorage);
    expect(saved.filter(([key]) => key.startsWith("tenkacloud.workbench-draft"))).toEqual([
      [
        DRAFT_KEY,
        JSON.stringify({ version: 1, files: { "solution.py": "private unfinished code\n" } }),
      ],
    ]);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(JSON.stringify(saved)).not.toContain("rotated-synthetic-key");
  });

  it("disables persistence without a server job ID while leaving editing available", async () => {
    const view = render(panel({ jobId: "" }));
    await editCode("cannot persist without a scope\n");
    expect(
      screen.getByText(/This environment has no draft storage identifier/),
    ).toBeInTheDocument();
    expect(Object.keys(window.localStorage)).toEqual(["tenkacloud.portal.locale"]);
    view.unmount();
    render(panel({ jobId: "" }));
    expect(await screen.findByLabelText("solution.py")).toHaveValue("pass\n");
  });

  it("persists an explicit Restore starter across remounts", async () => {
    const view = render(panel());
    await editCode("unfinished = 42\n");
    fireEvent.click(screen.getByRole("button", { name: "Restore starter" }));
    expect(screen.getByLabelText("solution.py")).toHaveValue("pass\n");
    view.unmount();
    render(panel());
    expect(await screen.findByLabelText("solution.py")).toHaveValue("pass\n");
  });

  it("warns about corruption without overwriting it until an explicit Restore starter", async () => {
    window.localStorage.setItem(DRAFT_KEY, "{damaged draft");
    const view = render(panel());
    expect(await screen.findByLabelText("solution.py")).toHaveValue("pass\n");
    expect(screen.getByText(/saved code draft could not be read/)).toBeInTheDocument();
    await editCode("still editable\n");
    expect(window.localStorage.getItem(DRAFT_KEY)).toBe("{damaged draft");
    view.unmount();
    render(panel());
    await screen.findByLabelText("solution.py");
    expect(screen.getByText(/saved code draft could not be read/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore starter" }));
    expect(screen.queryByText(/saved code draft could not be read/)).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY) as string)).toEqual({
      version: 1,
      files: STARTER,
    });
    await editCode("saving works again\n");
    expect(window.localStorage.getItem(DRAFT_KEY)).toContain("saving works again");
  });

  it("shows quota failures without losing the editor or falsely reporting a save, and retries on edit", async () => {
    const view = render(panel());
    await editCode("last saved code\n");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    await editCode("latest unsaved code\n");
    expect(screen.getByText(/Your latest code could not be saved/)).toBeInTheDocument();
    expect(screen.queryByText(/Code edits are saved only/)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(DRAFT_KEY)).toContain("last saved code");
    setItem.mockRestore();
    await editCode("retry saved code\n");
    expect(screen.queryByText(/Your latest code could not be saved/)).not.toBeInTheDocument();
    view.unmount();
    render(panel());
    expect(await screen.findByLabelText("solution.py")).toHaveValue("retry saved code\n");
  });

  it("leaves editing available when browser storage is inaccessible", async () => {
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      if (key === DRAFT_KEY) throw new DOMException("Denied", "SecurityError");
      return getItem.call(this, key);
    });
    render(panel());
    await editCode("editable with blocked storage\n");
    expect(screen.getByText(/saved code draft could not be read/)).toBeInTheDocument();
  });

  it("ignores a late config response after switching jobs", async () => {
    const oldConfig = deferred<typeof CONFIG | undefined>();
    apiMocks.getWorkbenchConfig.mockReturnValueOnce(oldConfig.promise);
    const view = render(panel());
    view.rerender(panel({ jobId: "new-job" }));
    await editCode("new job draft\n");
    await act(async () => oldConfig.resolve(undefined));
    expect(screen.getByLabelText("solution.py")).toHaveValue("new job draft\n");
    expect(apiMocks.getWorkbenchStarter).toHaveBeenCalledTimes(1);
  });

  it("ignores a late starter response after switching jobs and does not save it into either scope", async () => {
    const oldStarter = deferred<typeof STARTER>();
    apiMocks.getWorkbenchStarter.mockReturnValueOnce(oldStarter.promise);
    const view = render(panel());
    await waitFor(() => expect(apiMocks.getWorkbenchStarter).toHaveBeenCalledTimes(1));
    view.rerender(panel({ jobId: "new-job" }));
    await editCode("new job draft\n");
    await act(async () => oldStarter.resolve({ "solution.py": "OLD STARTER" }));
    expect(screen.getByLabelText("solution.py")).toHaveValue("new job draft\n");
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    view.unmount();
    render(panel({ jobId: "new-job" }));
    expect(await screen.findByLabelText("solution.py")).toHaveValue("new job draft\n");
  });

  it("ignores old action results after an authentication change in the same job", async () => {
    const inspect = deferred<{ output: string }>();
    const tests = deferred<{ passed: boolean; output: string }>();
    apiMocks.inspectWorkbench.mockReturnValueOnce(inspect.promise);
    apiMocks.testWorkbench.mockReturnValueOnce(tests.promise);
    const view = render(panel());
    await editCode("keep this code\n");
    fireEvent.click(screen.getByRole("button", { name: "Inspect evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Run public tests" }));
    view.rerender(panel({ sessionToken: "rotated-synthetic-key" }));
    expect(await screen.findByLabelText("solution.py")).toHaveValue("keep this code\n");
    await act(async () => {
      inspect.resolve({ output: "obsolete inspection" });
      tests.resolve({ passed: true, output: "obsolete test output" });
    });
    expect(screen.queryByText("obsolete inspection")).not.toBeInTheDocument();
    expect(screen.queryByText("obsolete test output")).not.toBeInTheDocument();
    expect(screen.getByLabelText("solution.py")).toHaveValue("keep this code\n");
  });

  it("ignores an obsolete starter after authentication changes without a scope remount", async () => {
    const oldStarter = deferred<typeof STARTER>();
    apiMocks.getWorkbenchStarter.mockReturnValueOnce(oldStarter.promise);
    const view = render(panel());
    await waitFor(() => expect(apiMocks.getWorkbenchStarter).toHaveBeenCalledTimes(1));
    view.rerender(panel({ sessionToken: "rotated-synthetic-key" }));
    await editCode("new authenticated draft\n");
    await act(async () => oldStarter.resolve({ "solution.py": "obsolete starter" }));
    expect(screen.getByLabelText("solution.py")).toHaveValue("new authenticated draft\n");
    expect(window.localStorage.getItem(DRAFT_KEY)).toContain("new authenticated draft");
  });

  it("does not submit code when prepare finishes after switching jobs", async () => {
    const prepare = deferred<{ ok: boolean; submissions: Record<string, string> }>();
    apiMocks.prepareWorkbench.mockReturnValueOnce(prepare.promise);
    const view = render(panel());
    await editCode("old job code\n");
    fireEvent.click(screen.getByRole("button", { name: "Submit (+60 pt)" }));
    await waitFor(() => expect(apiMocks.prepareWorkbench).toHaveBeenCalledTimes(1));
    view.rerender(panel({ jobId: "new-job" }));
    await screen.findByLabelText("solution.py");
    await act(async () =>
      prepare.resolve({ ok: true, submissions: { implement: "old submission" } }),
    );
    expect(apiMocks.submitFlag).not.toHaveBeenCalled();
  });
});
