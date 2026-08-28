import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProblemSummary } from "../../src/data/problems";

/**
 * Issue #834 / #835: ProblemsPage (Cards + search / category segment / difficulty &
 * tag multi-select / tag badge toggle / clear filter)。 検索 / category 切替 / tag badge
 * の active 切替 / card header navigate / counter / empty (filtered vs none) / difficulty
 * & tag multiselect onChange (Number/string parse + tagMatchMode toggle) を pin する。
 * useNavigate / listProblemSummaries / useT を mock、 problem-filter ロジックと interpolate
 * は実物。
 */
const { mockNav, mockList } = vi.hoisted(() => ({ mockNav: vi.fn(), mockList: vi.fn() }));

vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../src/data/problems", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/problems")>();
  // listProblemSummaries だけ差し替え、 PROVIDER_LABEL (badge 表示名) は実物。
  return { ...actual, listProblemSummaries: mockList };
});
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return { ...actual, useT: () => (key: string) => key };
});

const { ProblemsPage } = await import("../../src/pages/Problems");

const summary = (over: Partial<ProblemSummary> = {}): ProblemSummary =>
  ({
    id: "a",
    name: "Alpha",
    category: "Battle",
    status: "ready",
    shortDescription: "alpha desc",
    difficulty: 1,
    estimatedDuration: "30m",
    tags: ["web", "sqli"],
    runtime: { provider: "aws", engine: "cloudformation" },
    ...over,
  }) as ProblemSummary;
const costEstimate: ProblemSummary["costEstimate"] = {
  alwaysOnResources: [
    {
      logicalId: "Database",
      resourceType: "AWS::RDS::DBInstance",
      riskLevel: "high",
    },
  ],
  unclassifiedResourceTypes: [],
  resourceTypes: ["AWS::RDS::DBInstance"],
};
const CATALOG: ProblemSummary[] = [
  summary({
    id: "a",
    name: "Alpha",
    category: "Battle",
    difficulty: 1,
    tags: ["web", "sqli"],
    costEstimate,
  }),
  summary({
    id: "b",
    name: "Bravo",
    category: "Challenge",
    status: "draft",
    difficulty: 5,
    tags: ["web", "crypto"],
    shortDescription: "bravo desc",
  }),
];

const renderPage = () => render(<ProblemsPage />);
const searchBox = () => screen.getByPlaceholderText("problems.search_placeholder");

beforeEach(() => {
  mockNav.mockClear();
  mockList.mockReturnValue(CATALOG);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ProblemsPage", () => {
  it("should render every problem card and a plain total counter when no filter is active", () => {
    renderPage();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(screen.getByText(/problem_cost.always_on_count/)).toBeInTheDocument();
    expect(screen.getByText(/problem_cost.resources/)).toBeInTheDocument();
    expect(screen.getByText("(2)")).toBeInTheDocument(); // counter no filter
    // category badge 両色: Alpha=Battle(red), Bravo=Challenge(blue)。
    expect(
      screen.getAllByText("Battle").some((e) => e.closest(".awsui_badge, [class*=badge]")),
    ).toBe(true);
  });

  it("should render the header action for adding your own problems", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "problems.pack_guidance_open" })).toBeInTheDocument();
  });

  it("should open the pack guidance modal from the header action and list CLI steps", () => {
    const { container } = renderPage();

    createWrapper(container)
      .findButton("[data-testid='problem-pack-guidance-open-header']")
      ?.click();

    const modal = createWrapper(document.body).findModal();
    expect(modal).not.toBeNull();
    expect(modal?.isVisible()).toBe(true);
    expect(screen.getByText("problems.pack_guidance_modal_title")).toBeInTheDocument();
    expect(screen.getByText("problems.pack_guidance_path_official_title")).toBeInTheDocument();
    expect(screen.getByText("problems.pack_guidance_path_private_title")).toBeInTheDocument();
    expect(screen.getByText("problems.pack_guidance_cli_heading")).toBeInTheDocument();
    for (const command of [
      'make pack-init ARGS="./my-first-pack"',
      'make pack-validate ARGS="./my-first-pack"',
      'make pack-install ARGS="./my-first-pack"',
      'make pack-activate ARGS="com.example.starter@0.1.0 --tenant <tenant-id>"',
    ]) {
      expect(screen.getByText(command)).toBeInTheDocument();
    }
    expect(screen.getByText("problems.pack_guidance_create_event_note")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "problems.pack_guidance_docs_link" }).getAttribute("href"),
    ).toBe(
      "https://github.com/susumutomita/TenkaCloud/tree/main/apps/developer-portal/src/app/developers/docs/tutorials/first-pack",
    );
  });

  it("should dismiss the pack guidance modal", async () => {
    const { container } = renderPage();

    createWrapper(container)
      .findButton("[data-testid='problem-pack-guidance-open-header']")
      ?.click();
    expect(createWrapper(document.body).findModal()).not.toBeNull();

    createWrapper(document.body).findModal()?.findDismissButton().click();
    await waitFor(() => expect(createWrapper(document.body).findModal()?.isVisible()).toBe(false));
  });

  it("should render the runtime provider badge per card (AWS / multi-cloud brand / raw fallback)", () => {
    mockList.mockReturnValue([
      summary({ id: "a", name: "Alpha" }), // aws 既定
      summary({ id: "s", name: "Sky", runtime: { provider: "sakura", engine: "apprun" } }),
      summary({ id: "f", name: "Fly", runtime: { provider: "fly", engine: "machines" } }),
    ]);
    renderPage();
    expect(screen.getByText("AWS")).toBeInTheDocument();
    expect(screen.getByText("Sakura Cloud")).toBeInTheDocument();
    expect(screen.getByText("fly")).toBeInTheDocument(); // 未知 provider は raw id
  });

  it("should render a pack badge only for problems that come from an installed pack", () => {
    // Issue #2093: a core problem (no `source`) shows no pack badge; a pack problem does.
    mockList.mockReturnValue([
      summary({ id: "core-x", name: "CoreX" }),
      summary({
        id: "pack-y",
        name: "PackY",
        source: "pack",
        packId: "com.example.pack",
        packVersion: "1.2.0",
        license: "Apache-2.0",
      }),
    ]);
    renderPage();
    // The pack badge appears exactly once (only on the pack-sourced card).
    expect(screen.getAllByText("problems.badge_pack")).toHaveLength(1);
  });

  it("should filter by search text and show a filtered counter + clear button", () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: "bravo" } });
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("(1 / 2)")).toBeInTheDocument();
    // clear filter (header action)
    fireEvent.click(screen.getAllByRole("button", { name: "problems.clear_filter" })[0]);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("(2)")).toBeInTheDocument();
  });

  it("should filter by category via the segmented control", () => {
    renderPage();
    const battleSeg = screen
      .getAllByText("Battle")
      .map((e) => e.closest("button"))
      .find((b): b is HTMLButtonElement => b !== null);
    fireEvent.click(battleSeg as HTMLButtonElement);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Bravo")).not.toBeInTheDocument();
    // back to "all"
    fireEvent.click(screen.getByText("problems.all"));
    expect(screen.getByText("Bravo")).toBeInTheDocument();
  });

  it("should toggle a tag filter on and off via a card tag badge", () => {
    renderPage();
    // "sqli" は Alpha だけが持つので、 click すると Bravo が消える。
    fireEvent.click(screen.getByText("sqli"));
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Bravo")).not.toBeInTheDocument();
    // active になった "sqli" card badge (= 一意な active aria) を再 click → toggle off。
    fireEvent.click(screen.getByRole("button", { name: "problems.tag_active_aria" }));
    expect(screen.getByText("Bravo")).toBeInTheDocument();
  });

  it("should navigate to the problem detail when a card header link is clicked", () => {
    renderPage();
    fireEvent.click(screen.getByText("Alpha"));
    expect(mockNav).toHaveBeenCalledWith("/problems/a");
  });

  it("should show the filtered-empty state with a clear button when nothing matches", () => {
    renderPage();
    fireEvent.change(searchBox(), { target: { value: "no-such-problem" } });
    expect(screen.getByText("problems.empty_filtered")).toBeInTheDocument();
    // clear button は header と empty-state の 2 つ。 ここでは empty-state 側 (= 末尾) を click。
    const clears = screen.getAllByRole("button", { name: "problems.clear_filter" });
    fireEvent.click(clears[clears.length - 1]);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("should show the plain empty state when the catalog itself is empty", () => {
    mockList.mockReturnValue([]);
    renderPage();
    expect(screen.getByText("problems.empty")).toBeInTheDocument();
    expect(screen.getByText("problems.pack_guidance_empty_hint")).toBeInTheDocument();
    const guidanceButtons = screen.getAllByRole("button", {
      name: "problems.pack_guidance_open",
    });
    fireEvent.click(guidanceButtons[guidanceButtons.length - 1]);
    expect(screen.getByText("problems.pack_guidance_modal_title")).toBeInTheDocument();
    expect(screen.getByText("(0)")).toBeInTheDocument();
  });

  // Cloudscape Multiselect は role="option" の素朴な click では onChange が発火しないため、
  // 公式 test-utils (createWrapper → openDropdown → selectOptionByValue) で駆動する。
  // findAllMultiselects() は DOM 順 = [difficulty, tag]。
  it("should filter by difficulty via the difficulty multiselect", () => {
    const { container } = renderPage();
    const difficultyMs = createWrapper(container).findAllMultiselects()[0];
    difficultyMs.openDropdown();
    difficultyMs.selectOptionByValue("1"); // difficulty 1 → Alpha のみ (Bravo は 5)
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Bravo")).not.toBeInTheDocument();
  });

  it("should select multiple tags, reveal the match-mode toggle, and switch or→and", () => {
    const { container } = renderPage();
    const tagMs = createWrapper(container).findAllMultiselects()[1];
    tagMs.openDropdown();
    tagMs.selectOptionByValue("web"); // tags=[web] (A,B 両方が持つ)
    // Multiselect は選択後も dropdown が開いたままなので再 open は不要 (= toggle で閉じてしまう)。
    tagMs.selectOptionByValue("crypto"); // tags=[web, crypto] → length 2
    // length>1 で match-mode toggle button が出現 (初期 mode "or")。
    fireEvent.click(screen.getByRole("button", { name: "problems.tag_match_or_button" })); // or→and
    expect(
      screen.getByRole("button", { name: "problems.tag_match_and_button" }),
    ).toBeInTheDocument();
    // mode "and" で web AND crypto を両方持つ問題 → Bravo のみ (Alpha は crypto を持たない)。
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();

    // and→or に戻す (ternary 反対分岐)。 OR では web|crypto を持つ → 両方表示。
    fireEvent.click(screen.getByRole("button", { name: "problems.tag_match_and_button" }));
    expect(
      screen.getByRole("button", { name: "problems.tag_match_or_button" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
  });
});
