import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSummary } from "../../src/api/events-client";
import type { AppConfig } from "../../src/config";

/**
 * EventListPage × SetupGuide の wiring (Issue #1773) を pin する。
 * guide 本体の挙動は test/components/SetupGuide.test.tsx、 完了 derive は
 * src/lib/setup-guide.test.ts で固定済。 ここでは
 *   - 未完了 step が残る間は一覧の上に guide が出る
 *   - 全 step 完了で guide が消える
 *   - 一覧 fetch 失敗 (= items 未取得) では guide を出さない (誤った「未完了」表示の防止)
 * の 3 経路だけを見る。
 */
const { mockApiClient, mockNav, mockList } = vi.hoisted(() => ({
  mockApiClient: vi.fn(),
  mockNav: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mockApiClient };
});
vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return { ...actual, listEvents: mockList };
});
vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return { ...actual, useT: () => (k: string) => k };
});

const { EventListPage } = await import("../../src/pages/EventList");

const config = {} as AppConfig;
const ev = (over: Partial<EventSummary> = {}): EventSummary =>
  ({
    eventId: "e1",
    name: "Event One",
    status: "DRAFT",
    teamCount: 2,
    problemCount: 3,
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    expiresAt: 0,
    ...over,
  }) as EventSummary;

beforeEach(() => {
  mockApiClient.mockReturnValue({ post: vi.fn() });
  mockList.mockReset().mockResolvedValue({ items: [] });
});
afterEach(() => vi.clearAllMocks());

describe("EventListPage setup guide wiring", () => {
  it("should render the setup guide above the list while onboarding steps remain incomplete", async () => {
    mockList.mockResolvedValue({ items: [ev()] }); // DRAFT = deploy step 未完
    render(<EventListPage config={config} />);
    expect(await screen.findByText("Event One")).toBeInTheDocument();
    expect(screen.getByText("setup_guide.header")).toBeInTheDocument();
  });

  it("should not render the setup guide once every onboarding step is complete", async () => {
    mockList.mockResolvedValue({ items: [ev({ status: "READY" })] });
    render(<EventListPage config={config} />);
    expect(await screen.findByText("Event One")).toBeInTheDocument();
    expect(screen.queryByText("setup_guide.header")).not.toBeInTheDocument();
  });

  it("should not render the setup guide when the event list fails to load", async () => {
    mockList.mockRejectedValue(new Error("list boom"));
    render(<EventListPage config={config} />);
    expect(await screen.findByText("list boom")).toBeInTheDocument();
    expect(screen.queryByText("setup_guide.header")).not.toBeInTheDocument();
  });
});
