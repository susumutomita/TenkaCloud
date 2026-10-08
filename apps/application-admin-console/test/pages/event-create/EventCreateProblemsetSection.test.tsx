import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProblemSummary } from "../../../src/data/problems";
import {
  EventCreateProblemsetSection,
  type EventCreateProblemsetSectionProps,
} from "../../../src/pages/event-create/EventCreateProblemsetSection";
import { type ProblemRow, REGION_OPTIONS } from "../../../src/pages/event-create/helpers";
import { problemPicker } from "../../utils/problem-picker";

/**
 * 「使う問題」 section: 検索 + filter (Issue #1776) + 常時表示の問題チェック一覧 + 選択問題ごとの
 * region Select。 検索 (id / name / タグ) / category / 難易度 / scoring kind / タグの
 * 各 filter がチェック一覧を絞ること、 0 件時の empty state + 「絞り込み解除」、
 * 問題選択の onProblemsChange、 region 変更の onUpdateProblemRow、 problemRows 有無の
 * table 表示、 defaultRegion fallback、 supportedRegions の絞り込みを pin。
 * useT は echo mock (interpolate は実物)、 problem-filter / helpers は実物。
 * Cloudscape は test-utils + data-testid selector で駆動。
 */
vi.mock("../../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/i18n")>();
  return { ...actual, useT: () => (k: string) => k };
});

const r0 = REGION_OPTIONS[0]?.value ?? "ap-northeast-1";
const r1 = REGION_OPTIONS[1]?.value ?? "us-east-1";

const problem = (over: Partial<ProblemSummary> & { id: string }): ProblemSummary => ({
  name: `Problem ${over.id}`,
  category: "Challenge",
  status: "ready",
  shortDescription: "short",
  difficulty: 1,
  estimatedDuration: "30m",
  tags: [],
  runtime: { provider: "aws", engine: "cloudformation" },
  ...over,
});
const costEstimate: ProblemSummary["costEstimate"] = {
  alwaysOnResources: [
    {
      logicalId: "Nat",
      resourceType: "AWS::EC2::NatGateway",
      riskLevel: "high",
    },
  ],
  unclassifiedResourceTypes: [],
  resourceTypes: ["AWS::EC2::NatGateway"],
};

const CATALOG: readonly ProblemSummary[] = [
  problem({
    id: "p1",
    name: "Redis Spike",
    category: "Battle",
    difficulty: 4,
    scoringKind: "uptime-flat",
    tags: ["redis", "ec2"],
    costEstimate,
  }),
  problem({
    id: "p2",
    name: "Hello World",
    category: "Challenge",
    difficulty: 1,
    scoringKind: "flag",
    shortDescription: "A greeting exercise",
    tags: ["ssm"],
  }),
];

const props = (
  over: Partial<EventCreateProblemsetSectionProps> = {},
): EventCreateProblemsetSectionProps => ({
  problems: CATALOG,
  selectedProblems: [],
  problemRows: [],
  nonAwsRuntimeEnabled: false,
  onProblemsChange: vi.fn(),
  onUpdateProblemRow: vi.fn(),
  ...over,
});

const RESERVED_CATALOG: readonly ProblemSummary[] = [
  problem({ id: "sk", name: "Sakura P", runtime: { provider: "sakura", engine: "apprun" } }),
];
const row = (over: Partial<ProblemRow> = {}): ProblemRow => ({
  problemId: "p1",
  problemName: "Problem 1",
  defaultRegion: r0,
  costEstimate,
  ...over,
});

afterEach(() => vi.clearAllMocks());

const renderSection = (p = props()) => {
  const utils = render(<EventCreateProblemsetSection {...p} />);
  const w = createWrapper(utils.container);
  return {
    ...utils,
    p,
    problemSelect: () => problemPicker(utils.container),
    searchInput: () => w.findInput('[data-testid="problem-filter-search"]'),
    categorySelect: () => w.findSelect('[data-testid="problem-filter-category"]'),
    difficultyFilter: () => w.findMultiselect('[data-testid="problem-filter-difficulty"]'),
    scoringKindFilter: () => w.findMultiselect('[data-testid="problem-filter-scoring-kind"]'),
    tagFilter: () => w.findMultiselect('[data-testid="problem-filter-tags"]'),
  };
};

/** 常時表示されている問題チェック項目のタイトル。 */
const visibleProblemLabels = (s: ReturnType<typeof renderSection>): string[] => {
  const ms = s.problemSelect();
  return (ms?.findOptions() ?? []).map((o) => o.findLabel()?.getElement().textContent ?? "");
};

describe("EventCreateProblemsetSection", () => {
  it("should emit selected problems from the visible checkboxes", () => {
    const s = renderSection();
    const ms = s.problemSelect();

    ms?.toggleProblem("p1");
    expect(s.p.onProblemsChange).toHaveBeenCalled();
  });

  it("should not let a reserved-runtime problem be selected when multi-cloud is OFF (#2167)", () => {
    const onProblemsChange = vi.fn();
    const s = renderSection(
      props({ problems: RESERVED_CATALOG, nonAwsRuntimeEnabled: false, onProblemsChange }),
    );
    const ms = s.problemSelect();

    ms?.toggleProblem("sk");
    expect(onProblemsChange).not.toHaveBeenCalled();
  });

  it("should let a reserved-runtime problem be selected when multi-cloud is ON (#2167)", () => {
    const onProblemsChange = vi.fn();
    const s = renderSection(
      props({ problems: RESERVED_CATALOG, nonAwsRuntimeEnabled: true, onProblemsChange }),
    );
    const ms = s.problemSelect();

    ms?.toggleProblem("sk");
    expect(onProblemsChange).toHaveBeenCalled();
  });

  it("should list every catalog problem when no filter is active", () => {
    const s = renderSection();
    expect(visibleProblemLabels(s)).toEqual(["Redis Spike", "Hello World"]);
    // filter 非 active のときは match counter / clear button を出さない。
    expect(screen.queryByText("problem_search.match_count")).not.toBeInTheDocument();
    expect(screen.queryByTestId("problem-filter-clear")).not.toBeInTheDocument();
  });

  it("should narrow the options via free-text search on the problem id", () => {
    const s = renderSection();
    s.searchInput()?.setInputValue("p2");
    expect(visibleProblemLabels(s)).toEqual(["Hello World"]);
    // filter active: match counter (interpolate 済) + clear button が出る。
    expect(screen.getByText("problem_search.match_count")).toBeInTheDocument();
    expect(screen.getByTestId("problem-filter-clear")).toBeInTheDocument();
  });

  it.each(["World", "greeting", "ssm"])("filters visible checkboxes by text %s", (search) => {
    const section = renderSection();
    expect(screen.getByRole("checkbox", { name: /Hello World/ })).toBeInTheDocument();
    section.searchInput()?.setInputValue(search);
    expect(visibleProblemLabels(section)).toEqual(["Hello World"]);
    section.problemSelect().toggleProblem("p2");
    expect(section.p.onProblemsChange).toHaveBeenCalledWith([
      expect.objectContaining({ value: "p2" }),
    ]);
    expect(section.searchInput()?.findNativeInput().getElement()).toHaveValue(search);
  });

  it("should narrow the options via the category select and restore on 'all'", () => {
    const s = renderSection();
    const select = s.categorySelect();
    select?.openDropdown();
    select?.selectOptionByValue("Battle", { expandToViewport: true });
    expect(visibleProblemLabels(s)).toEqual(["Redis Spike"]);
    select?.openDropdown();
    select?.selectOptionByValue("all", { expandToViewport: true });
    expect(visibleProblemLabels(s)).toEqual(["Redis Spike", "Hello World"]);
  });

  it("should narrow the options via the difficulty multiselect", () => {
    const s = renderSection();
    const ms = s.difficultyFilter();
    ms?.openDropdown();
    ms?.selectOptionByValue("4", { expandToViewport: true });
    expect(visibleProblemLabels(s)).toEqual(["Redis Spike"]);
  });

  it("should narrow the options via the scoring kind multiselect", () => {
    const s = renderSection();
    const ms = s.scoringKindFilter();
    ms?.openDropdown();
    ms?.selectOptionByValue("flag", { expandToViewport: true });
    expect(visibleProblemLabels(s)).toEqual(["Hello World"]);
  });

  it("should narrow the options via the tag multiselect", () => {
    const s = renderSection();
    const ms = s.tagFilter();
    ms?.openDropdown();
    ms?.selectOptionByValue("redis", { expandToViewport: true });
    expect(visibleProblemLabels(s)).toEqual(["Redis Spike"]);
  });

  it("should clear every filter via the inline clear button", () => {
    const s = renderSection();
    s.searchInput()?.setInputValue("p2");
    fireEvent.click(screen.getByTestId("problem-filter-clear"));
    expect(visibleProblemLabels(s)).toEqual(["Redis Spike", "Hello World"]);
  });

  it("should show the empty state with a clear-filters action when nothing matches", () => {
    const s = renderSection();
    s.searchInput()?.setInputValue("no-such-problem");
    expect(screen.getByText("problem_search.empty_filtered")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("problem-filter-empty-clear"));
    expect(screen.queryByTestId("problem-filter-empty-clear")).not.toBeInTheDocument();
    expect(visibleProblemLabels(s)).toEqual(["Redis Spike", "Hello World"]);
  });

  it("should not render the region table when no problems are selected", () => {
    renderSection(props({ problemRows: [] }));
    expect(screen.queryByText("event_create.col_region")).not.toBeInTheDocument();
  });

  it("should render a region picker per selected problem and emit region changes", () => {
    // selectedProblems は空のまま (= Multiselect token を出さず "Problem 1" を table cell に一意化)。
    const p = props({ problemRows: [row()] });
    const { container } = render(<EventCreateProblemsetSection {...p} />);
    expect(screen.getByText("Problem 1")).toBeInTheDocument();
    expect(screen.getByText("event_create.col_estimated_cost")).toBeInTheDocument();
    expect(screen.getByText(/problem_cost.always_on_count/)).toBeInTheDocument();
    expect(screen.getAllByText("problem_cost.always_on_resources").length).toBeGreaterThan(0);
    // region Select は table 内 (= category filter Select の後)。 testid 無しなので位置で特定。
    const select = createWrapper(container).findAllSelects()[1];
    // region Select は expandToViewport なので dropdown は portal に出る → flag が必要。
    select?.openDropdown();
    select?.selectOptionByValue(r1, { expandToViewport: true });
    expect(p.onUpdateProblemRow).toHaveBeenCalledWith("p1", { defaultRegion: r1 });
  });

  it("should fall back to the first option when defaultRegion is not selectable", () => {
    // defaultRegion が options に無い → find が undefined → options[0] (?? 分岐)。 render で踏む。
    renderSection(props({ problemRows: [row({ defaultRegion: "zz-nowhere" })] }));
    expect(screen.getByText("Problem 1")).toBeInTheDocument();
  });

  it("should narrow region options to the problem's supportedRegions", () => {
    // resolveRegionOptions の非空 intersection 分岐を踏む。
    renderSection(props({ problemRows: [row({ supportedRegions: [r0] })] }));
    expect(screen.getByText("Problem 1")).toBeInTheDocument();
  });
});

describe("selection across filters", () => {
  it("keeps selected IDs when filtering, adding another problem, clearing and removing", () => {
    const changed = vi.fn();
    function ControlledSelection() {
      const [selected, setSelected] = useState<
        EventCreateProblemsetSectionProps["selectedProblems"]
      >([]);
      return (
        <EventCreateProblemsetSection
          {...props({
            selectedProblems: selected,
            onProblemsChange: (next) => {
              changed(next.map((option) => option.value));
              setSelected(next);
            },
          })}
        />
      );
    }
    const { container } = render(<ControlledSelection />);
    const wrapper = createWrapper(container);
    const picker = () => problemPicker(container);
    const search = wrapper.findInput('[data-testid="problem-filter-search"]');

    expect(picker().findTokens()).toHaveLength(0);
    picker().toggleProblem("p1");

    search?.setInputValue("p2");
    expect(picker()?.findTokens()).toHaveLength(1);

    picker()?.toggleProblem("p2");

    expect(changed.mock.calls.at(-1)?.[0]).toEqual(["p1", "p2"]);
    search?.setInputValue("no matching problem");
    expect(picker()?.findTokens()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("problem-filter-clear"));
    expect(picker()?.findTokens()).toHaveLength(2);
    picker().toggleProblem("p2");
    expect(changed.mock.calls.at(-1)?.[0]).toEqual(["p1"]);
    expect(picker().findTokens()).toHaveLength(1);
    picker().toggleProblem("p2");
    expect(changed.mock.calls.at(-1)?.[0]).toEqual(["p1", "p2"]);
    picker()?.findTokens()[0]?.findDismiss()?.click();
    expect(changed.mock.calls.at(-1)?.[0]).toEqual(["p2"]);
  });
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        /* jsdom has no layout; scroll evidence is covered by the real browser harness. */
      }
      disconnect() {
        /* no observers allocated by this test stub. */
      }
    },
  );
});

it("limits only host-classified coordination Battles and allows changing the selection", () => {
  const onChange = vi.fn();
  const catalog = {
    supported: new Set(["p1", "p2", "p3"]),
    cloud: new Set<string>(),
    coordination: new Set(["p1", "p2"]),
    limits: { maxTeams: 40, maxEventJobs: 400 },
    loading: false,
    error: null,
  };
  const all = [
    problem({ id: "p1", category: "Battle" }),
    problem({ id: "p2", category: "Battle" }),
    problem({ id: "p3", category: "Battle" }),
  ];
  const base = props({
    problems: all,
    hostCatalog: catalog,
    hostSupportedProblemIds: catalog.supported,
    onProblemsChange: onChange,
  });
  const { rerender } = render(
    <EventCreateProblemsetSection
      {...base}
      selectedProblems={[{ value: "p1", label: "Problem p1" }]}
    />,
  );
  expect(screen.getByTestId("coordination-selection-help").textContent).toContain(
    "problem_search.coordination_limit",
  );
  expect(screen.getByTestId("problem-checkbox-p2").querySelector("input")?.disabled).toBe(true);
  expect(screen.getByTestId("problem-checkbox-p3").querySelector("input")?.disabled).toBe(false);
  fireEvent.click(
    screen.getByTestId("problem-checkbox-p1").querySelector("input") as HTMLInputElement,
  );
  expect(onChange).toHaveBeenLastCalledWith([]);
  rerender(<EventCreateProblemsetSection {...base} selectedProblems={[]} />);
  expect(screen.getByTestId("problem-checkbox-p2").querySelector("input")?.disabled).toBe(false);
  fireEvent.click(
    screen.getByTestId("problem-checkbox-p2").querySelector("input") as HTMLInputElement,
  );
  expect(onChange.mock.lastCall?.[0][0].value).toBe("p2");
});
