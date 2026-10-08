import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { ProblemSummary } from "../../../src/data/problems";
import { EventCreateProblemsetSection } from "../../../src/pages/event-create/EventCreateProblemsetSection";

vi.mock("../../../src/local-host-build", () => ({ LOCAL_HOST_BUILD: true }));
vi.mock("../../../src/i18n", async (original) => ({
  ...(await original<typeof import("../../../src/i18n")>()),
  useT: () => (key: string) => key,
}));
vi.mock("../../../src/pages/event-create/SemanticProblemSearch", () => ({
  SemanticProblemSearch: ({
    problems,
    onCandidates,
  }: {
    problems: readonly ProblemSummary[];
    onCandidates: (ids: readonly string[] | null) => void;
  }) => (
    <div>
      <output data-testid="search-scope">{problems.map((p) => p.id).join(",")}</output>
      <button type="button" onClick={() => onCandidates(["two"])}>
        Test results
      </button>
      <button type="button" onClick={() => onCandidates(null)}>
        Clear results
      </button>
    </div>
  ),
}));
const problems: ProblemSummary[] = ["one", "two"].map((id) => ({
  id,
  name: id,
  category: "Challenge",
  status: "ready",
  shortDescription: id,
  difficulty: 1,
  estimatedDuration: "10m",
  tags: [],
  runtime: { provider: "docker", engine: "compose" },
}));
const catalog = {
  supported: new Set(["one", "two"]),
  cloud: new Set<string>(),
  limits: { maxTeams: 40, maxEventJobs: 4 },
  loading: false,
  error: null,
};
function Harness() {
  const [selected, setSelected] = useState<readonly { value: string; label: string }[]>([
    { value: "one", label: "one" },
  ]);
  return (
    <EventCreateProblemsetSection
      problems={problems}
      selectedProblems={selected}
      problemRows={[]}
      nonAwsRuntimeEnabled={false}
      hostSupportedProblemIds={catalog.supported}
      hostCatalog={catalog}
      onProblemsChange={(next) =>
        setSelected(
          next.map((option) => ({ value: option.value ?? "", label: option.label ?? "" })),
        )
      }
      onUpdateProblemRow={vi.fn()}
    />
  );
}
it("loads optional help only after opening, narrows without selecting, and restores manual selection", async () => {
  render(<Harness />);
  expect(screen.queryByRole("button", { name: "Test results" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "目的から問題を探す" }));
  fireEvent.click(await screen.findByRole("button", { name: "Test results" }));
  expect(screen.queryByTestId("problem-checkbox-one")).not.toBeInTheDocument();
  expect(screen.getByTestId("problem-checkbox-two").querySelector("input")).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Clear results" }));
  expect(screen.getByTestId("problem-checkbox-one").querySelector("input")).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Test results" }));
  fireEvent.click(screen.getByRole("button", { name: "目的から問題を探す" }));
  expect(screen.getByTestId("problem-checkbox-one").querySelector("input")).toBeChecked();
});
it("passes the current filter scope and restores selection when search clears stale results", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "目的から問題を探す" }));
  fireEvent.click(await screen.findByRole("button", { name: "Test results" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "problems.search_label" }), {
    target: { value: "one" },
  });
  await waitFor(() => expect(screen.getByTestId("search-scope")).toHaveTextContent("one"));
  fireEvent.click(screen.getByRole("button", { name: "Clear results" }));
  expect(screen.getByTestId("problem-checkbox-one").querySelector("input")).toBeChecked();
  expect(screen.queryByTestId("problem-checkbox-two")).not.toBeInTheDocument();
});
