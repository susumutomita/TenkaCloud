import type { MultiselectProps } from "@cloudscape-design/components/multiselect";
import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { ProblemSummary } from "../../../src/data/problems";
import { EventCreateProblemsetSection } from "../../../src/pages/event-create/EventCreateProblemsetSection";

vi.mock("../../../src/i18n", async (original) => ({
  ...(await original<typeof import("../../../src/i18n")>()),
  useT: () => (key: string) => key,
}));
vi.mock("../../../src/local-host-build", () => ({ LOCAL_HOST_BUILD: true }));
vi.mock("../../../src/pages/event-create/SemanticProblemSearch", () => ({
  SemanticProblemSearch: ({ onCandidates }: { onCandidates: (ids: string[] | null) => void }) => (
    <>
      <button type="button" onClick={() => onCandidates(problems.slice(0, 10).map((p) => p.id))}>
        Install candidates
      </button>
      <button type="button" onClick={() => onCandidates(null)}>
        Clear candidates
      </button>
    </>
  ),
}));
const problems: ProblemSummary[] = Array.from({ length: 15 }, (_, i) => ({
  id: `p${i}`,
  name: `Exercise ${i}`,
  category: "Challenge",
  status: "ready",
  shortDescription: `Learn topic ${i}`,
  difficulty: 2,
  estimatedDuration: i === 1 ? "" : "25m",
  tags:
    i === 0
      ? ["advanced-cryptography", "advanced-cryptography-2026", "cryptography", "arithmetic"]
      : [],
  runtime: { provider: "docker", engine: "compose" },
}));
function Harness() {
  const [selection, setSelection] = useState<readonly MultiselectProps.Option[]>([]);
  return (
    <EventCreateProblemsetSection
      problems={problems}
      selectedProblems={selection}
      problemRows={[]}
      nonAwsRuntimeEnabled={false}
      hostSupportedProblemIds={new Set(problems.map((p) => p.id))}
      maxProblems={2}
      hostCatalog={{
        supported: new Set(problems.map((p) => p.id)),
        cloud: new Set(),
        limits: { maxTeams: 40, maxEventJobs: 30 },
        loading: false,
        error: null,
      }}
      problemContent={() => ({
        description: "Full **authored description**\n\n<script>window.untrusted = true</script>",
        learningGoals: ["Understand team isolation"],
      })}
      onProblemsChange={setSelection}
      onUpdateProblemRow={vi.fn()}
    />
  );
}
it("compares authored metadata and opens details without selecting or inventing time", () => {
  const { container } = render(<Harness />);
  const card = screen.getByTestId("problem-checkbox-p0").closest("article");
  if (!card) throw new Error("Problem card is missing");
  expect(card).toHaveTextContent("Learn topic 0");
  expect(card).toHaveTextContent("25m");
  expect(card).toHaveTextContent("problems.difficulty_2");
  expect(card).toHaveTextContent("docker · compose");
  expect(screen.getByTestId("problem-checkbox-p1").closest("article")).not.toHaveTextContent("25m");
  const detail = createWrapper(card).findExpandableSection();
  expect(detail?.findExpandedContent()).toBeNull();
  detail?.findExpandButton().click();
  expect(detail?.findExpandedContent()?.getElement()).toHaveTextContent(
    "Understand team isolation",
  );
  expect(card.querySelector("strong")).toBeInTheDocument();
  expect(within(card).getByText("authored description").tagName).toBe("STRONG");
  expect(card.querySelector("script")).toBeNull();
  expect(screen.getByTestId("problem-checkbox-p0").querySelector("input")).not.toBeChecked();
  expect(createWrapper(container).findTokenGroup()).toBeNull();
});
it("shows authored tags on each card using the catalog's theme labels without selecting it", () => {
  render(<Harness />);
  const checkbox = screen.getByTestId("problem-checkbox-p0");
  const card = checkbox.closest("article");
  const untaggedCard = screen.getByTestId("problem-checkbox-p1").closest("article");
  if (!card || !untaggedCard) throw new Error("Problem cards are missing");
  const tags = within(card).getByLabelText("problems.tags_header");
  expect(within(tags).getAllByText("problems.theme_cryptography")).toHaveLength(1);
  expect(within(tags).getByText("arithmetic")).toBeVisible();
  expect(tags).not.toHaveTextContent("advanced-cryptography");
  expect(within(untaggedCard).queryByLabelText("problems.tags_header")).toBeNull();
  expect(checkbox.querySelector("input")).not.toBeChecked();
  expect(problems[0]?.tags).toEqual([
    "advanced-cryptography",
    "advanced-cryptography-2026",
    "cryptography",
    "arithmetic",
  ]);
});
it("retains selections across pages and empty search recovery while enforcing the selection limit", () => {
  const { container } = render(<Harness />);
  const wrapper = createWrapper(container);
  fireEvent.click(within(screen.getByTestId("problem-checkbox-p0")).getByRole("checkbox"));
  wrapper.findPagination()?.findNextPageButton().click();
  expect(screen.queryByTestId("problem-checkbox-p0")).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByTestId("problem-checkbox-p6")).getByRole("checkbox"));
  expect(screen.getByTestId("problem-checkbox-p7").querySelector("input")).toBeDisabled();
  wrapper.findInput('[data-testid="problem-filter-search"]')?.setInputValue("no matching exercise");
  expect(wrapper.findTokenGroup()?.findTokens()).toHaveLength(2);
  fireEvent.click(screen.getByTestId("problem-filter-empty-clear"));
  expect(screen.getByTestId("problem-checkbox-p0").querySelector("input")).toBeChecked();
  wrapper.findTokenGroup()?.findTokens()[0]?.findDismiss()?.click();
  expect(screen.getByTestId("problem-checkbox-p1").querySelector("input")).not.toBeDisabled();
  fireEvent.click(within(screen.getByTestId("problem-checkbox-p1")).getByRole("checkbox"));
  expect(wrapper.findTokenGroup()?.findTokens()).toHaveLength(2);
});

it("starts ranked candidates and cleared results on page one", async () => {
  const { container } = render(<Harness />);
  const pagination = () => createWrapper(container).findPagination();
  pagination()?.findNextPageButton().click();
  expect(screen.getByTestId("problem-checkbox-p6")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "問題選択のヘルプ" }));
  fireEvent.click(await screen.findByRole("button", { name: "Install candidates" }));
  expect(screen.getByTestId("problem-checkbox-p0")).toBeInTheDocument();
  pagination()?.findNextPageButton().click();
  fireEvent.click(screen.getByRole("button", { name: "Clear candidates" }));
  expect(screen.getByTestId("problem-checkbox-p0")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Install candidates" }));
  pagination()?.findNextPageButton().click();
  fireEvent.click(screen.getByRole("button", { name: "問題選択のヘルプ" }));
  expect(screen.getByTestId("problem-checkbox-p0")).toBeInTheDocument();
});
