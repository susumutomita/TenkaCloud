import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { StudySubmissionPanel } from "./StudySubmissionPanel";

const submit = vi.hoisted(() => vi.fn());
vi.mock("../api/portal-client", async (original) => ({
  ...(await original<typeof import("../api/portal-client")>()),
  submitFlag: submit,
}));
const base = {
  problemId: "study-repair",
  instructions: "Read the fixed **offline instructions**.",
  apiBaseUrl: "https://organizer.example",
  sessionToken: "fixture-team-key",
  onScored: vi.fn(async () => undefined),
};
const submission = {
  edition: "fixed-v1",
  artifact: '{"files":{}}',
  points: 100,
  solved: false,
  kind: "self-report" as const,
  assurance: "self-reported" as const,
  checks: ["normal-functionality", "security"],
};
beforeEach(() => {
  vi.clearAllMocks();
});

it("labels self-reports, sends pinned checks and retains a failed operation's retry key", async () => {
  submit
    .mockRejectedValueOnce(new Error("disconnected"))
    .mockResolvedValueOnce({ kind: "wrong", totalScore: 0, scoreDelta: 0, wrongCount: 1 });
  render(
    <I18nProvider>
      <StudySubmissionPanel {...base} submission={submission} />
    </I18nProvider>,
  );
  expect(screen.getByText(/modifiable self-reports|改ざん可能な自己申告/u)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("checkbox", { name: /security/u }));
  expect(screen.getByText("offline instructions")).toBeInTheDocument();
  const button = screen.getByRole("button", { name: /Submit|提出/u });
  await userEvent.click(button);
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const call = submit.mock.calls[0];
  expect(JSON.parse(call?.[3])).toEqual({
    edition: "fixed-v1",
    checks: { "normal-functionality": false, security: true },
  });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1]?.[6]).toBe(call?.[6]);
  expect(base.onScored).toHaveBeenCalledOnce();
});

it("keeps the low assurance label after acceptance and hides the submission form", () => {
  render(
    <I18nProvider>
      <StudySubmissionPanel {...base} submission={{ ...submission, solved: true }} />
    </I18nProvider>,
  );
  expect(screen.getByText(/modifiable self-reports|改ざん可能な自己申告/u)).toBeInTheDocument();
  expect(screen.getByText(/Accepted|受付済み/u)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Submit|提出/u })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Download problem data|問題データ/u })).toHaveAttribute(
    "download",
  );
});

it("renders nothing until the host releases the versioned submission problem", () => {
  const { container } = render(
    <I18nProvider>
      <StudySubmissionPanel {...base} submission={undefined} />
    </I18nProvider>,
  );
  expect(container).toBeEmptyDOMElement();
});

it.each(["ok", "already_scored"] as const)(
  "submits a versioned answer and renders the organizer's %s acknowledgement",
  async (kind) => {
    submit.mockResolvedValue({ kind, totalScore: 100, scoreDelta: kind === "ok" ? 100 : 0 });
    render(
      <I18nProvider>
        <StudySubmissionPanel
          {...base}
          submission={{
            ...submission,
            kind: "answer",
            assurance: "server-checked-answer",
            checks: undefined,
          }}
        />
      </I18nProvider>,
    );
    expect(
      screen.getByText(/checks the answer against the pinned edition|固定版の正解と照合/u),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: /Answer|解答/u }), "42");
    await userEvent.click(screen.getByRole("button", { name: /Submit|提出/u }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(JSON.parse(submit.mock.calls[0]?.[3])).toEqual({ edition: "fixed-v1", answer: "42" });
    expect(await screen.findByText(/Accepted|受付済み/u)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(base.onScored).toHaveBeenCalledOnce();
  },
);

it("keeps a report unaccepted when the host rejects missing check definitions", async () => {
  submit.mockRejectedValue(new Error("Incomplete check definitions"));
  render(
    <I18nProvider>
      <StudySubmissionPanel
        {...base}
        instructions={undefined}
        submission={{ ...submission, checks: undefined }}
      />
    </I18nProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: /Submit|提出/u }));
  expect(await screen.findByText(/Submission failed|提出に失敗/u)).toBeInTheDocument();
  expect(JSON.parse(submit.mock.calls[0]?.[3])).toEqual({ edition: "fixed-v1", checks: {} });
  expect(screen.queryByText(/Accepted|受付済み/u)).not.toBeInTheDocument();
  expect(base.onScored).not.toHaveBeenCalled();
});
