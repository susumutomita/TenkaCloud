import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSummary } from "../../src/api/events-client";
import { SETUP_GUIDE_DISMISSED_KEY } from "../../src/lib/setup-guide";

/**
 * SetupGuide (Issue #1773): 初回 Tenant Admin 向け 4 ステップ checklist の render を pin する。
 * 完了 derive は lib/setup-guide.test.ts で個別に固定済なので、 ここは
 *   - 4 ステップ + 進捗表示の描画
 *   - 完了 / 未完了 StatusIndicator の出し分け
 *   - step link の navigate 先
 *   - 全完了 / dismiss 済での非表示と「非表示にする」の localStorage 永続化
 * を component 境界で検証する。 useNavigate / useT を mock、 interpolate は実物。
 */
const { mockNav } = vi.hoisted(() => ({ mockNav: vi.fn() }));
vi.mock("react-router", () => ({ useNavigate: () => mockNav }));

// 補間されるキーだけテンプレートを返し、他は key を echo する t。
const T: Record<string, string> = {
  "setup_guide.progress_info": "{completed} / {total} steps done",
};
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return { ...actual, useT: () => (k: string) => T[k] ?? k };
});

const { SetupGuide } = await import("../../src/components/SetupGuide");

const ev = (over: Partial<EventSummary> = {}): EventSummary => ({
  eventId: "e1",
  name: "Ev",
  status: "DRAFT",
  teamCount: 0,
  problemCount: 0,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
  expiresAt: 0,
  ...over,
});

beforeEach(() => {
  window.localStorage.removeItem(SETUP_GUIDE_DISMISSED_KEY);
  mockNav.mockClear();
});
afterEach(() => {
  window.localStorage.removeItem(SETUP_GUIDE_DISMISSED_KEY);
});

describe("SetupGuide", () => {
  it("should render all four steps as pending with 0/4 progress when the tenant has no events", () => {
    render(<SetupGuide events={[]} />);
    expect(screen.getByText("setup_guide.header")).toBeInTheDocument();
    expect(screen.getByText("0 / 4 steps done")).toBeInTheDocument();
    expect(screen.getAllByText("setup_guide.status_incomplete")).toHaveLength(4);
    // title は連番付き ("1. <title>") で render されるので連番込みの全文で確認する。
    for (const [idx, id] of [
      "create_event",
      "select_problems",
      "register_teams",
      "deploy",
    ].entries()) {
      expect(screen.getByText(`${idx + 1}. setup_guide.step_${id}_title`)).toBeInTheDocument();
      expect(screen.getByText(`setup_guide.step_${id}_link`)).toBeInTheDocument();
    }
  });

  it("should mark derived-complete steps with a success indicator and update the progress count", () => {
    render(<SetupGuide events={[ev({ problemCount: 2, teamCount: 3 })]} />);
    expect(screen.getByText("3 / 4 steps done")).toBeInTheDocument();
    expect(screen.getAllByText("setup_guide.status_complete")).toHaveLength(3);
    expect(screen.getAllByText("setup_guide.status_incomplete")).toHaveLength(1);
  });

  it("should navigate to the wizard from the create step and to the event detail from the deploy step", () => {
    render(<SetupGuide events={[ev({ eventId: "e1" })]} />);
    fireEvent.click(screen.getByText("setup_guide.step_create_event_link"));
    expect(mockNav).toHaveBeenCalledWith("/events/new");
    fireEvent.click(screen.getByText("setup_guide.step_deploy_link"));
    expect(mockNav).toHaveBeenCalledWith("/events/e1");
  });

  it("should point the deploy step at the event wizard when every event is archived", () => {
    render(<SetupGuide events={[ev({ status: "ARCHIVED" })]} />);
    fireEvent.click(screen.getByText("setup_guide.step_deploy_link"));
    expect(mockNav).toHaveBeenCalledWith("/events/new");
  });

  it("should render nothing when every step is complete", () => {
    render(<SetupGuide events={[ev({ status: "READY", problemCount: 1, teamCount: 1 })]} />);
    expect(screen.queryByText("setup_guide.header")).not.toBeInTheDocument();
  });

  it("should render nothing when the guide was previously dismissed", () => {
    window.localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY, "true");
    render(<SetupGuide events={[]} />);
    expect(screen.queryByText("setup_guide.header")).not.toBeInTheDocument();
  });

  it("should hide the guide and persist the dismissal when the dismiss button is clicked", () => {
    render(<SetupGuide events={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "setup_guide.dismiss" }));
    expect(screen.queryByText("setup_guide.header")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(SETUP_GUIDE_DISMISSED_KEY)).toBe("true");
  });
});
