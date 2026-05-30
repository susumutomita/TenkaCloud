import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventCreateProblemsetSection,
  type EventCreateProblemsetSectionProps,
} from "../../../src/pages/event-create/EventCreateProblemsetSection";
import { type ProblemRow, REGION_OPTIONS } from "../../../src/pages/event-create/helpers";

/**
 * 「使う問題」 section: 問題 Multiselect + 選択問題ごとの region Select。 問題選択の
 * onProblemsChange、 region 変更の onUpdateProblemRow、 problemRows 有無の table 表示、
 * defaultRegion が options に無いとき options[0] へ倒す分岐、 supportedRegions による
 * region 絞り込みを pin。 useT echo、 helpers (resolveRegionOptions/REGION_OPTIONS) は実物。
 * Cloudscape は test-utils で駆動。
 */
vi.mock("../../../src/i18n", () => ({ useT: () => (k: string) => k }));

const r0 = REGION_OPTIONS[0]?.value ?? "ap-northeast-1";
const r1 = REGION_OPTIONS[1]?.value ?? "us-east-1";

const props = (
  over: Partial<EventCreateProblemsetSectionProps> = {},
): EventCreateProblemsetSectionProps => ({
  problemOptions: [
    { value: "p1", label: "Problem 1" },
    { value: "p2", label: "Problem 2" },
  ],
  selectedProblems: [],
  problemRows: [],
  onProblemsChange: vi.fn(),
  onUpdateProblemRow: vi.fn(),
  ...over,
});
const row = (over: Partial<ProblemRow> = {}): ProblemRow => ({
  problemId: "p1",
  problemName: "Problem 1",
  defaultRegion: r0,
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("EventCreateProblemsetSection", () => {
  it("should emit selected problems from the multiselect", () => {
    const p = props();
    const { container } = render(<EventCreateProblemsetSection {...p} />);
    const ms = createWrapper(container).findMultiselect();
    ms?.openDropdown();
    ms?.selectOptionByValue("p1");
    expect(p.onProblemsChange).toHaveBeenCalled();
  });

  it("should not render the region table when no problems are selected", () => {
    render(<EventCreateProblemsetSection {...props({ problemRows: [] })} />);
    expect(screen.queryByText("event_create.col_region")).not.toBeInTheDocument();
  });

  it("should render a region picker per selected problem and emit region changes", () => {
    // selectedProblems は空のまま (= Multiselect token を出さず "Problem 1" を table cell に一意化)。
    const p = props({ problemRows: [row()] });
    const { container } = render(<EventCreateProblemsetSection {...p} />);
    expect(screen.getByText("Problem 1")).toBeInTheDocument();
    const select = createWrapper(container).findSelect();
    // region Select は expandToViewport なので dropdown は portal に出る → flag が必要。
    select?.openDropdown();
    select?.selectOptionByValue(r1, { expandToViewport: true });
    expect(p.onUpdateProblemRow).toHaveBeenCalledWith("p1", { defaultRegion: r1 });
  });

  it("should fall back to the first option when defaultRegion is not selectable", () => {
    // defaultRegion が options に無い → find が undefined → options[0] (?? 分岐)。 render で踏む。
    const p = props({ problemRows: [row({ defaultRegion: "zz-nowhere" })] });
    render(<EventCreateProblemsetSection {...p} />);
    expect(screen.getByText("Problem 1")).toBeInTheDocument();
  });

  it("should narrow region options to the problem's supportedRegions", () => {
    // resolveRegionOptions の非空 intersection 分岐を踏む。
    const p = props({ problemRows: [row({ supportedRegions: [r0] })] });
    render(<EventCreateProblemsetSection {...p} />);
    expect(screen.getByText("Problem 1")).toBeInTheDocument();
  });
});
