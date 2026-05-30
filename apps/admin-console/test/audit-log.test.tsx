import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditApiError, type AuditItem } from "../src/api/audit-client";
import type { AppConfig } from "../src/config";
import {
  AuditLogPage,
  buildAuditExportInput,
  buildAuditListInput,
  describeAuditLoadError,
  EMPTY_AUDIT_FILTERS,
  mergeAuditItems,
  validateAuditLoadInput,
} from "../src/pages/AuditLog";

/**
 * AuditLog: pure helper (validate / build list+export / merge / describe error) を直接 unit-test
 * し、 AuditLogPage component は createAuditClient / useAuth / i18n を mock して render 分岐
 * (not-wired / mount load / load-more / error+dismiss / CSV export / tenant-scope validation) を
 * 網羅する。 子 AuditLogTable は stub せず実物で render し outcome badge / cell fallback も pin。
 */
const { mockAuth, mockCreate, mockList, mockExport } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCreate: vi.fn(),
  mockList: vi.fn(),
  mockExport: vi.fn(),
}));

vi.mock("../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../src/api/audit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/audit-client")>();
  return { ...actual, createAuditClient: mockCreate };
});
vi.mock("../src/i18n", () => {
  // 安定参照の t を返す (毎 render で新関数を返すと load の useCallback dep が変わり無限 render)。
  const stableT = (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key;
  return { useT: () => stableT, useLang: () => "en" };
});

// ── pure helpers ─────────────────────────────────────────────────────────────
const t = (key: string) => `t:${key}`;
const firstItem = {
  id: "audit-1",
  tenantId: "tenant-a",
  actor: "admin",
  action: "CreateTenant",
  outcome: "success",
  occurredAt: "2026-05-20T10:00:00.000Z",
};
const secondItem = {
  id: "audit-2",
  tenantId: "tenant-a",
  actor: "admin",
  action: "DeleteTenant",
  outcome: "forbidden",
  occurredAt: "2026-05-20T10:01:00.000Z",
};

describe("AuditLog helpers", () => {
  it("should return a validation error when tenantId is empty under tenant scope", () => {
    expect(validateAuditLoadInput("tenant", "  ", t)).toBe("t:audit_log.tenant_id_required");
    expect(validateAuditLoadInput("system", "  ", t)).toBeNull();
  });

  it("should trim tenantId in the list input and only include cursor when needed", () => {
    expect(buildAuditListInput("tenant", " tenant-a ", "next")).toEqual({
      scope: "tenant",
      tenantId: "tenant-a",
      limit: 50,
      cursor: "next",
    });
    expect(buildAuditListInput("system", " tenant-a ", undefined)).toEqual({
      scope: "system",
      limit: 50,
    });
  });

  it("should attach trimmed filter params when provided (#1292)", () => {
    expect(
      buildAuditListInput("tenant", "tenant-a", undefined, {
        from: " 2026-05-20T00:00:00.000Z ",
        to: " 2026-05-21T00:00:00.000Z ",
        principal: " alice@example.com ",
        action: " create_event ",
      }),
    ).toEqual({
      scope: "tenant",
      tenantId: "tenant-a",
      limit: 50,
      from: "2026-05-20T00:00:00.000Z",
      to: "2026-05-21T00:00:00.000Z",
      principal: "alice@example.com",
      action: "create_event",
    });
  });

  it("should omit empty filters using EMPTY_AUDIT_FILTERS (#1292)", () => {
    expect(buildAuditListInput("system", "", undefined, EMPTY_AUDIT_FILTERS)).toEqual({
      scope: "system",
      limit: 50,
    });
  });

  it("should build the CSV export input (no limit/cursor) with trimmed tenant + filters", () => {
    expect(
      buildAuditExportInput("tenant", " tenant-a ", {
        from: " f ",
        to: " tt ",
        principal: " p ",
        action: " act ",
      }),
    ).toEqual({
      scope: "tenant",
      tenantId: "tenant-a",
      from: "f",
      to: "tt",
      principal: "p",
      action: "act",
    });
    expect(buildAuditExportInput("system", "", EMPTY_AUDIT_FILTERS)).toEqual({ scope: "system" });
  });

  it("should append items when a cursor is present and replace them otherwise", () => {
    expect(mergeAuditItems([firstItem], [secondItem], "next")).toEqual([firstItem, secondItem]);
    expect(mergeAuditItems([firstItem], [secondItem], undefined)).toEqual([secondItem]);
  });

  it("should convert Audit API errors and unknown errors to display text", () => {
    expect(describeAuditLoadError(new AuditApiError(StatusCodes.FORBIDDEN, undefined), t)).toBe(
      "SystemAdmin role が必要です",
    );
    expect(describeAuditLoadError(new Error("network failed"), t)).toBe("network failed");
    expect(describeAuditLoadError("bad", t)).toBe("t:audit_log.fetch_failed");
  });
});

// ── component ────────────────────────────────────────────────────────────────
const config = { adminInsightApiUrl: "https://insight.example.com" } as AppConfig;
const items: AuditItem[] = [
  {
    id: "1",
    tenantId: "t-a",
    actor: "sys",
    actorUsername: "alice",
    action: "CreateTenant",
    outcome: "success",
    target: "tenant-x",
    ipAddress: "1.2.3.4",
    occurredAt: "2026-05-20T10:00:00.000Z",
  },
  // 2nd item omits actorUsername / target / ipAddress → ?? fallbacks
  {
    id: "2",
    tenantId: "t-a",
    actor: "sys",
    action: "DeleteTenant",
    outcome: "forbidden",
    occurredAt: "2026-05-20T10:01:00.000Z",
  },
  {
    id: "3",
    tenantId: "t-b",
    actor: "sys",
    action: "A",
    outcome: "not_found",
    occurredAt: "2026-05-20T10:02:00.000Z",
  },
  {
    id: "4",
    tenantId: "t-b",
    actor: "sys",
    action: "B",
    outcome: "conflict",
    occurredAt: "2026-05-20T10:03:00.000Z",
  },
  {
    id: "5",
    tenantId: "t-c",
    actor: "sys",
    action: "C",
    outcome: "error",
    occurredAt: "2026-05-20T10:04:00.000Z",
  },
  {
    id: "6",
    tenantId: "t-c",
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
  // a.click() の jsdom navigation 未実装 warning を抑える。
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
    expect(screen.getByText("audit_log.not_wired_body")).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("should load on mount and render every outcome badge + cell fallbacks", async () => {
    renderPage();
    expect(await screen.findByText("CreateTenant")).toBeInTheDocument();
    for (const outcome of ["success", "forbidden", "not_found", "conflict", "error", "weird"]) {
      expect(screen.getByText(outcome)).toBeInTheDocument();
    }
    expect(screen.getByText("alice")).toBeInTheDocument(); // actorUsername present
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ scope: "system", limit: 50 }));
  });

  it("should append the next page when load-more is clicked", async () => {
    renderPage();
    await screen.findByText("CreateTenant");
    mockList.mockResolvedValueOnce({
      items: [{ ...items[0], id: "p2", action: "SecondPageAction" }],
      nextCursor: undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: "audit_log.load_more" }));
    expect(await screen.findByText("SecondPageAction")).toBeInTheDocument();
    expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "next" }));
  });

  it("should surface a load error and allow dismissing it", async () => {
    mockList.mockRejectedValue(new Error("list failed"));
    renderPage();
    expect(await screen.findByText("list failed")).toBeInTheDocument();
    fireEvent.click(document.querySelector('button[class*="dismiss-button"]') as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByText("list failed")).not.toBeInTheDocument());
  });

  it("should export CSV via the export button", async () => {
    renderPage();
    await screen.findByText("CreateTenant");
    fireEvent.click(screen.getByRole("button", { name: "audit_log.export_csv" }));
    await waitFor(() =>
      expect(mockExport).toHaveBeenCalledWith(expect.objectContaining({ scope: "system" })),
    );
  });

  it("should surface an export failure as an error", async () => {
    mockExport.mockRejectedValue(new Error("export failed"));
    renderPage();
    await screen.findByText("CreateTenant");
    fireEvent.click(screen.getByRole("button", { name: "audit_log.export_csv" }));
    expect(await screen.findByText("export failed")).toBeInTheDocument();
  });

  it("should update the filter inputs", async () => {
    renderPage();
    await screen.findByText("CreateTenant");
    const setFilter = (placeholder: string, value: string) =>
      fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
    setFilter("audit_log.filter_from", "f1");
    setFilter("audit_log.filter_to", "t1");
    setFilter("audit_log.filter_principal", "p1");
    setFilter("audit_log.filter_action", "a1");
    expect(screen.getByPlaceholderText("audit_log.filter_from")).toHaveValue("f1");
    expect(screen.getByPlaceholderText("audit_log.filter_action")).toHaveValue("a1");
  });

  it("should render the empty state when no items are returned", async () => {
    mockList.mockResolvedValue({ items: [], nextCursor: undefined });
    renderPage();
    expect(await screen.findByText("audit_log.empty_header")).toBeInTheDocument();
  });

  it("should validate the tenant scope on load and export before calling the API", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("CreateTenant");
    mockList.mockClear();
    // scope を tenant に切り替える (Select trigger → option)。
    await user.click(screen.getByRole("button", { name: /audit_log\.scope_system/ }));
    await user.click(await screen.findByText("audit_log.scope_tenant_action"));
    // tenantId 空のまま load → validation error。
    fireEvent.click(screen.getByRole("button", { name: "audit_log.load_button" }));
    expect(await screen.findByText("audit_log.tenant_id_required")).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
    // export も同じ validation を通る。
    fireEvent.click(screen.getByRole("button", { name: "audit_log.export_csv" }));
    expect(mockExport).not.toHaveBeenCalled();
    // tenantId を入力すれば tenant scope で load が通る (tenant Input onChange も踏む)。
    fireEvent.change(screen.getByPlaceholderText("audit_log.tenant_id_placeholder"), {
      target: { value: "tenant-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "audit_log.load_button" }));
    await waitFor(() =>
      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "tenant", tenantId: "tenant-a" }),
      ),
    );
  });
});
