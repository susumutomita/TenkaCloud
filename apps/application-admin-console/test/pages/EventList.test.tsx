import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import type { EventSummary } from "../../src/api/events-client";
import type { AppConfig } from "../../src/config";

/**
 * EventListPage: event 一覧 polling + status badge + archive (modal 確認) + showArchived
 * checkbox + create button。 loading / fetch error (dismiss) / 行描画 (status badge・archive
 * 可否) / name link & create navigate / archive flow (確認→成功/失敗/cancel) / archived
 * フィルタ + empty 文言 (no-event vs all-archived) を pin する。 加えて export 済みの
 * describeArchiveError を 409(known/unknown) / 一般 Error / 非 Error で直接 unit-test。
 * useApiClient / useNavigate / listEvents / archiveEvent / useT を mock、 ApiError と
 * interpolate は実物。
 */
const { mockApiClient, mockNav, mockList, mockArchive } = vi.hoisted(() => ({
  mockApiClient: vi.fn(),
  mockNav: vi.fn(),
  mockList: vi.fn(),
  mockArchive: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mockApiClient };
});
vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return { ...actual, listEvents: mockList, archiveEvent: mockArchive };
});
vi.mock("react-router", () => ({ useNavigate: () => mockNav }));

// 補間されるキーだけテンプレートを返し、 他は key を echo する t。 これで row 単位の
// archive ボタンを aria-label (name 入り) で一意に掴める。
const T: Record<string, string> = {
  "event_list.archive_aria": "archive {name}",
  "event_list.show_archived": "show archived {count}",
  "event_list.archive_modal_body": "archive body {name}",
  "event_list.archive_conflict_known": "{name} cannot archive from {current}",
  "event_list.archive_conflict_unknown": "{name} archive conflict",
};
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return { ...actual, useT: () => (k: string) => T[k] ?? k };
});

const { EventListPage, describeArchiveError } = await import("../../src/pages/EventList");

const t = (k: string) => T[k] ?? k;
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
const renderPage = () => render(<EventListPage config={config} />);

beforeEach(() => {
  mockApiClient.mockReturnValue({ post: vi.fn() });
  mockNav.mockClear();
  mockList.mockReset().mockResolvedValue({ items: [ev()] });
  mockArchive.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => vi.clearAllMocks());

describe("describeArchiveError", () => {
  it("should describe a 409 with a known currentStatus", () => {
    const err = new ApiError(409, 'conflict {"currentStatus":"READY"}');
    expect(describeArchiveError(err, "Ev", t)).toBe("Ev cannot archive from READY");
  });

  it("should describe a 409 without a parseable currentStatus", () => {
    const err = new ApiError(409, "conflict but no status field");
    expect(describeArchiveError(err, "Ev", t)).toBe("Ev archive conflict");
  });

  it("should pass through a non-409 ApiError message", () => {
    expect(describeArchiveError(new ApiError(500, "boom"), "Ev", t)).toBe("API 500: boom");
  });

  it("should pass through a plain Error message and stringify non-errors", () => {
    expect(describeArchiveError(new Error("plain"), "Ev", t)).toBe("plain");
    expect(describeArchiveError("weird", "Ev", t)).toBe("weird");
  });
});

describe("EventListPage", () => {
  it("should show the loading spinner and skip fetch with no API client", () => {
    mockApiClient.mockReturnValue(null);
    renderPage();
    expect(screen.getByText("event_list.loading")).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
  });

  it("should render rows and navigate from the name link and create button", async () => {
    mockList.mockResolvedValue({
      items: [
        ev({ eventId: "e1", name: "Event One", status: "DRAFT" }),
        ev({ eventId: "e2", name: "Ready Ev", status: "READY" }),
      ],
    });
    renderPage();
    expect(await screen.findByText("Event One")).toBeInTheDocument();
    expect(screen.getByText("event_list.status_label.DRAFT")).toBeInTheDocument();
    expect(screen.getByText("event_list.status_label.READY")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Event One"));
    expect(mockNav).toHaveBeenCalledWith("/events/e1");
    fireEvent.click(screen.getByRole("button", { name: "event_list.create_button" }));
    expect(mockNav).toHaveBeenCalledWith("/events/new");
  });

  it("should show an empty-state create action that navigates when there are no events", async () => {
    mockList.mockResolvedValue({ items: [] });
    renderPage();
    expect(await screen.findByText("event_list.empty_no_event")).toBeInTheDocument();
    // header + empty-state both expose a create button; clicking the empty-state one navigates too
    const createButtons = screen.getAllByRole("button", { name: "event_list.create_button" });
    expect(createButtons.length).toBeGreaterThan(1);
    mockNav.mockClear();
    fireEvent.click(createButtons[createButtons.length - 1] as HTMLElement);
    expect(mockNav).toHaveBeenCalledWith("/events/new");
  });

  it("should disable archive for non-archivable statuses and enable it for DRAFT", async () => {
    mockList.mockResolvedValue({
      items: [
        ev({ eventId: "e1", name: "Draft Ev", status: "DRAFT" }),
        ev({ eventId: "e2", name: "Ready Ev", status: "READY" }),
      ],
    });
    renderPage();
    await screen.findByText("Draft Ev");
    expect(screen.getByRole("button", { name: "archive Draft Ev" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "archive Ready Ev" })).toBeDisabled();
  });

  it("should surface a fetch error and dismiss it", async () => {
    mockList.mockRejectedValue(new Error("list boom"));
    renderPage();
    expect(await screen.findByText("list boom")).toBeInTheDocument();
    fireEvent.click(document.querySelector('button[class*="dismiss-button"]') as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByText("list boom")).not.toBeInTheDocument());
  });

  it("should stringify a non-Error fetch rejection", async () => {
    mockList.mockRejectedValue("string fail");
    renderPage();
    expect(await screen.findByText("string fail")).toBeInTheDocument();
  });

  it("should archive after confirmation and refetch", async () => {
    mockList.mockResolvedValue({
      items: [ev({ eventId: "e1", name: "Draft Ev", status: "DRAFT" })],
    });
    renderPage();
    await screen.findByText("Draft Ev");
    fireEvent.click(screen.getByRole("button", { name: "archive Draft Ev" }));
    fireEvent.click(screen.getByRole("button", { name: "event_list.archive_modal_confirm" }));
    await waitFor(() => expect(mockArchive).toHaveBeenCalledWith(expect.anything(), "e1"));
    expect(mockList).toHaveBeenCalledTimes(2); // initial + post-archive refetch
  });

  it("should surface an archive error via describeArchiveError", async () => {
    mockList.mockResolvedValue({
      items: [ev({ eventId: "e1", name: "Draft Ev", status: "DRAFT" })],
    });
    mockArchive.mockRejectedValue(new ApiError(409, 'busy {"currentStatus":"READY"}'));
    renderPage();
    await screen.findByText("Draft Ev");
    fireEvent.click(screen.getByRole("button", { name: "archive Draft Ev" }));
    fireEvent.click(screen.getByRole("button", { name: "event_list.archive_modal_confirm" }));
    expect(await screen.findByText("Draft Ev cannot archive from READY")).toBeInTheDocument();
  });

  it("should close the archive modal on cancel without archiving", async () => {
    mockList.mockResolvedValue({
      items: [ev({ eventId: "e1", name: "Draft Ev", status: "DRAFT" })],
    });
    renderPage();
    await screen.findByText("Draft Ev");
    fireEvent.click(screen.getByRole("button", { name: "archive Draft Ev" }));
    fireEvent.click(screen.getByRole("button", { name: "event_list.archive_modal_cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "event_list.create_button" })); // 別操作 OK
    expect(mockArchive).not.toHaveBeenCalled();
  });

  it("should keep archivingId set while the archive request is in flight", async () => {
    mockList.mockResolvedValue({
      items: [ev({ eventId: "e1", name: "Draft Ev", status: "DRAFT" })],
    });
    mockArchive.mockReturnValue(new Promise(() => {})); // never resolves
    renderPage();
    await screen.findByText("Draft Ev");
    fireEvent.click(screen.getByRole("button", { name: "archive Draft Ev" }));
    fireEvent.click(screen.getByRole("button", { name: "event_list.archive_modal_confirm" }));
    // confirm で archive 呼出 + archivingId が set されたまま re-render → cell の
    // `loading={archivingId===eventId}` true 分岐を踏む (archive は never-resolve)。
    await waitFor(() => expect(mockArchive).toHaveBeenCalledWith(expect.anything(), "e1"));
    expect(screen.getByRole("button", { name: "archive Draft Ev" })).toBeInTheDocument();
  });

  it("should close the archive modal via the dismiss (X) control", async () => {
    mockList.mockResolvedValue({
      items: [ev({ eventId: "e1", name: "Draft Ev", status: "DRAFT" })],
    });
    renderPage();
    await screen.findByText("Draft Ev");
    fireEvent.click(screen.getByRole("button", { name: "archive Draft Ev" }));
    // Cloudscape Modal の X (dismiss-control) → onDismiss。
    fireEvent.click(
      document.querySelector('button[class*="dismiss-control"]') as HTMLButtonElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "event_list.create_button" }));
    expect(mockArchive).not.toHaveBeenCalled();
  });

  it("should show the archived filter checkbox and toggle archived visibility", async () => {
    mockList.mockResolvedValue({
      items: [
        ev({ eventId: "e1", name: "Active Ev", status: "DRAFT" }),
        ev({ eventId: "e2", name: "Old Ev", status: "ARCHIVED" }),
      ],
    });
    renderPage();
    await screen.findByText("Active Ev");
    // archived は default 非表示。
    expect(screen.queryByText("Old Ev")).not.toBeInTheDocument();
    expect(screen.getByText("show archived 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(await screen.findByText("Old Ev")).toBeInTheDocument();
  });

  it("should show the no-event empty state when there are no events", async () => {
    mockList.mockResolvedValue({ items: [] });
    renderPage();
    expect(await screen.findByText("event_list.empty_no_event")).toBeInTheDocument();
  });

  it("should show the all-archived empty state when every event is archived and hidden", async () => {
    mockList.mockResolvedValue({
      items: [ev({ eventId: "e1", name: "Old Ev", status: "ARCHIVED" })],
    });
    renderPage();
    expect(await screen.findByText("event_list.empty_all_archived")).toBeInTheDocument();
  });
});
