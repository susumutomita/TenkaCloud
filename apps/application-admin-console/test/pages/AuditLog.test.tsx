import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantAuditApiError, type TenantAuditItem } from "../../src/api/audit-log-client";
import type { AppConfig } from "../../src/config";
import {
  AuditLogPage,
  buildListInput,
  describeError,
  describeTarget,
  mergeItems,
} from "../../src/pages/AuditLog";

/**
 * Tenant Admin Console の AuditLogPage (#1292)。 pure helper (buildListInput / mergeItems /
 * describeError) を直接 unit-test し、 component は createTenantAuditClient / useAuth を mock して
 * render 分岐 (not-wired / mount load + inline table / reload / load-more / error+dismiss / CSV
 * export / filter inputs / empty) を網羅する。 audit-log-client は #1448 と衝突しないよう mock。
 */
const { mockAuth, mockCreate, mockList, mockExport } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCreate: vi.fn(),
  mockList: vi.fn(),
  mockExport: vi.fn(),
}));

vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/api/audit-log-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/audit-log-client")>();
  return { ...actual, createTenantAuditClient: mockCreate };
});
vi.mock("../../src/i18n", () => ({ useLang: () => "en" }));

// ── pure helpers ─────────────────────────────────────────────────────────────
describe("AuditLog helpers", () => {
  it("should build the list input with trimmed filters and optional cursor", () => {
    expect(
      buildListInput({ from: " a ", to: " b ", principal: " p ", action: " act " }, "cur"),
    ).toEqual({ limit: 50, cursor: "cur", from: "a", to: "b", principal: "p", action: "act" });
    expect(buildListInput({ from: "", to: "", principal: "", action: "" }, undefined)).toEqual({
      limit: 50,
    });
  });

  it("should append items when a cursor is present and replace them otherwise", () => {
    const a = { id: "1" } as TenantAuditItem;
    const b = { id: "2" } as TenantAuditItem;
    expect(mergeItems([a], [b], "cur")).toEqual([a, b]);
    expect(mergeItems([a], [b], undefined)).toEqual([b]);
  });

  it("should map tenant audit errors / generic errors / unknown to display text", () => {
    expect(describeError(new TenantAuditApiError(StatusCodes.FORBIDDEN, undefined))).toBe(
      "TenantAdmin role が必要です",
    );
    expect(describeError(new Error("network down"))).toBe("network down");
    expect(describeError("weird")).toBe("audit log の取得に失敗しました");
  });

  it("should label the target by resource type inferred from the action", () => {
    expect(describeTarget("create_event", "EV1")).toBe("Event EV1");
    expect(describeTarget("fire_disruption", "EV1")).toBe("Event EV1");
    expect(describeTarget("lock_scoring", "EV1")).toBe("Event EV1");
    expect(describeTarget("bulk_deploy", "EV1")).toBe("Event EV1");
    expect(describeTarget("create_notification", "EV1")).toBe("Event EV1");
    expect(describeTarget("create_competitor_account", "672726205532")).toBe(
      "AWS account 672726205532",
    );
    expect(describeTarget("register_team_cloud_credential", "team-1")).toBe(
      "Team credential team-1",
    );
    expect(describeTarget("some_other_action", "raw-id")).toBe("raw-id");
    expect(describeTarget("create_event", undefined)).toBe("-");
  });
});

// ── component ────────────────────────────────────────────────────────────────
const config = {} as AppConfig;
const items: TenantAuditItem[] = [
  {
    id: "1",
    tenantId: "t-a",
    actor: "sys",
    actorUsername: "alice",
    action: "CreateEvent",
    outcome: "success",
    target: "ev-x",
    ipAddress: "1.2.3.4",
    occurredAt: "2026-05-20T10:00:00.000Z",
  },
  {
    id: "2",
    tenantId: "t-a",
    actor: "sys",
    action: "DeleteEvent",
    outcome: "forbidden",
    occurredAt: "2026-05-20T10:01:00.000Z",
  },
  {
    id: "3",
    tenantId: "t-a",
    actor: "sys",
    action: "A",
    outcome: "not_found",
    occurredAt: "2026-05-20T10:02:00.000Z",
  },
  {
    id: "4",
    tenantId: "t-a",
    actor: "sys",
    action: "B",
    outcome: "conflict",
    occurredAt: "2026-05-20T10:03:00.000Z",
  },
  {
    id: "5",
    tenantId: "t-a",
    actor: "sys",
    action: "C",
    outcome: "error",
    occurredAt: "2026-05-20T10:04:00.000Z",
  },
  {
    id: "6",
    tenantId: "t-a",
    actor: "sys",
    action: "D",
    outcome: "weird",
    occurredAt: "2026-05-20T10:05:00.000Z",
  },
];
const renderPage = () => render(<AuditLogPage config={config} />);

beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:x"),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  Object.defineProperty(HTMLAnchorElement.prototype, "click", {
    value: vi.fn(),
    configurable: true,
  });
});

beforeEach(() => {
  mockAuth.mockReturnValue({ tokens: { idToken: "id-token" } });
  mockList.mockReset().mockResolvedValue({ items, nextCursor: "next" });
  mockExport.mockReset().mockResolvedValue(new Blob(["csv"]));
  mockCreate.mockReset().mockReturnValue({ list: mockList, exportCsv: mockExport });
});

afterEach(() => vi.clearAllMocks());

describe("AuditLogPage", () => {
  it("should show the not-wired alert when there are no tokens", () => {
    mockAuth.mockReturnValue({ tokens: null });
    renderPage();
    expect(screen.getByText(/audit log API は配線されていません/)).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("should load on mount and render every outcome badge + cell fallbacks", async () => {
    renderPage();
    expect(await screen.findByText("CreateEvent")).toBeInTheDocument();
    for (const outcome of ["success", "forbidden", "not_found", "conflict", "error", "weird"]) {
      expect(screen.getByText(outcome)).toBeInTheDocument();
    }
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it("should reload from scratch when the reload button is clicked", async () => {
    renderPage();
    await screen.findByText("CreateEvent");
    mockList.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await waitFor(() =>
      expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 })),
    );
  });

  it("should append the next page on load-more", async () => {
    renderPage();
    await screen.findByText("CreateEvent");
    mockList.mockResolvedValueOnce({
      items: [{ ...items[0], id: "p2", action: "SecondPage" }],
      nextCursor: undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: "続きを読み込む" }));
    expect(await screen.findByText("SecondPage")).toBeInTheDocument();
    expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "next" }));
  });

  it("should surface a load error and allow dismissing it", async () => {
    mockList.mockRejectedValue(new Error("list boom"));
    renderPage();
    expect(await screen.findByText("list boom")).toBeInTheDocument();
    fireEvent.click(document.querySelector('button[class*="dismiss-button"]') as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByText("list boom")).not.toBeInTheDocument());
  });

  it("should export CSV with all trimmed filters applied", async () => {
    renderPage();
    await screen.findByText("CreateEvent");
    fireEvent.change(screen.getByPlaceholderText("from (ISO8601)"), {
      target: { value: " 2026 " },
    });
    fireEvent.change(screen.getByPlaceholderText("to (ISO8601)"), { target: { value: " 2027 " } });
    fireEvent.change(screen.getByPlaceholderText("principal (sub / username / m2m:*)"), {
      target: { value: " alice " },
    });
    fireEvent.change(screen.getByPlaceholderText("action"), { target: { value: " CreateEvent " } });
    fireEvent.click(screen.getByRole("button", { name: "CSV エクスポート" }));
    await waitFor(() =>
      expect(mockExport).toHaveBeenCalledWith({
        from: "2026",
        to: "2027",
        principal: "alice",
        action: "CreateEvent",
      }),
    );
  });

  it("should surface an export error", async () => {
    mockExport.mockRejectedValue(new Error("export boom"));
    renderPage();
    await screen.findByText("CreateEvent");
    fireEvent.click(screen.getByRole("button", { name: "CSV エクスポート" }));
    expect(await screen.findByText("export boom")).toBeInTheDocument();
  });

  it("should update all filter inputs", async () => {
    renderPage();
    await screen.findByText("CreateEvent");
    const set = (ph: string, v: string) =>
      fireEvent.change(screen.getByPlaceholderText(ph), { target: { value: v } });
    set("from (ISO8601)", "f1");
    set("to (ISO8601)", "t1");
    set("principal (sub / username / m2m:*)", "p1");
    set("action", "a1");
    expect(screen.getByPlaceholderText("action")).toHaveValue("a1");
  });

  it("should render the empty state when no items are returned", async () => {
    mockList.mockResolvedValue({ items: [], nextCursor: undefined });
    renderPage();
    expect(await screen.findByText(/該当する監査ログはありません/)).toBeInTheDocument();
  });
});
