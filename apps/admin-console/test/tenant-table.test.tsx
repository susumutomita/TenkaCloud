import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "../src/api/tenants";
import { inactiveCell, isDeprovisioned, type TFn, tenantStatusCell } from "../src/lib/tenant-table";

/**
 * Issue #1418 follow-up: TenantList から抽出した純 cell helper を 100% に。
 * Cloudscape 依存は実物のまま render し、 tenants API / tenant-progress を mock して
 * isDeprovisioned の全分岐、 tenantStatusCell の suspended / not-in-progress /
 * dash / danger / warning / normal を網羅する。
 */
const h = vi.hoisted(() => ({
  isTenantSuspended: vi.fn(),
  tenantStatusBadgeColor: vi.fn(),
  isInProgress: vi.fn(),
  computeTenantProgress: vi.fn(),
}));

vi.mock("../src/api/tenants", () => ({
  isTenantSuspended: (...args: unknown[]) => h.isTenantSuspended(...args),
  tenantStatusBadgeColor: (...args: unknown[]) => h.tenantStatusBadgeColor(...args),
}));
vi.mock("../src/lib/tenant-progress", () => ({
  isInProgress: (...args: unknown[]) => h.isInProgress(...args),
  computeTenantProgress: (...args: unknown[]) => h.computeTenantProgress(...args),
}));

const t: TFn = (key) => key;

const tenant = (over: Partial<Tenant> = {}): Tenant =>
  ({
    tenantId: "t-1",
    tenantName: "Tenant One",
    email: "one@x.test",
    tier: "basic",
    tenantStatus: "Active",
    createdAt: "2026-01-01",
    ...over,
  }) as Tenant;

beforeEach(() => {
  vi.clearAllMocks();
  h.isTenantSuspended.mockReturnValue(false);
  h.tenantStatusBadgeColor.mockReturnValue("green");
  h.isInProgress.mockReturnValue(false);
  h.computeTenantProgress.mockReturnValue({ elapsedMs: 0, label: "1m", severity: "ok" });
});

afterEach(() => vi.restoreAllMocks());

describe("isDeprovisioned", () => {
  it("should treat a Deleted status (any casing) as deprovisioned", () => {
    expect(isDeprovisioned(tenant({ tenantStatus: "DELETED" }))).toBe(true);
  });

  it("should treat a Deprovisioned status as deprovisioned", () => {
    expect(isDeprovisioned(tenant({ tenantStatus: "Deprovisioned" }))).toBe(true);
  });

  it("should treat isActive=false as deprovisioned regardless of status", () => {
    expect(isDeprovisioned(tenant({ tenantStatus: "Active", isActive: false }))).toBe(true);
  });

  it("should treat an active tenant with undefined status as not deprovisioned", () => {
    expect(isDeprovisioned(tenant({ tenantStatus: undefined }))).toBe(false);
  });

  it("should treat an active tenant as not deprovisioned", () => {
    expect(isDeprovisioned(tenant({ tenantStatus: "Active", isActive: true }))).toBe(false);
  });
});

describe("inactiveCell", () => {
  it("should render the label inside an inactive box", () => {
    render(inactiveCell("(deprovisioned)"));
    expect(screen.getByText("(deprovisioned)")).toBeInTheDocument();
  });
});

describe("tenantStatusCell", () => {
  it("should render only the status badge when the tenant is not in progress", () => {
    render(<div>{tenantStatusCell(tenant({ tenantStatus: "Complete" }), 0, t)}</div>);
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.queryByText("tenant_list.suspended_badge")).not.toBeInTheDocument();
  });

  it("should add a suspended badge when the tenant is suspended", () => {
    h.isTenantSuspended.mockReturnValue(true);
    render(<div>{tenantStatusCell(tenant(), 0, t)}</div>);
    expect(screen.getByText("tenant_list.suspended_badge")).toBeInTheDocument();
  });

  it("should render only the badge when the progress label is the em-dash", () => {
    h.isInProgress.mockReturnValue(true);
    h.computeTenantProgress.mockReturnValue({ elapsedMs: 0, label: "—", severity: "ok" });
    render(<div>{tenantStatusCell(tenant({ tenantStatus: "In progress" }), 0, t)}</div>);
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("should append the danger suffix when severity is danger", () => {
    h.isInProgress.mockReturnValue(true);
    h.computeTenantProgress.mockReturnValue({ elapsedMs: 1, label: "65m", severity: "danger" });
    render(<div>{tenantStatusCell(tenant({ tenantStatus: "In progress" }), 0, t)}</div>);
    expect(screen.getByText(/tenant_list\.progress_danger_suffix/)).toBeInTheDocument();
  });

  it("should append the warning suffix when severity is warning", () => {
    h.isInProgress.mockReturnValue(true);
    h.computeTenantProgress.mockReturnValue({ elapsedMs: 1, label: "35m", severity: "warning" });
    render(<div>{tenantStatusCell(tenant({ tenantStatus: "In progress" }), 0, t)}</div>);
    expect(screen.getByText(/tenant_list\.progress_warning_suffix/)).toBeInTheDocument();
  });

  it("should render the elapsed label without a suffix when severity is normal", () => {
    h.isInProgress.mockReturnValue(true);
    h.computeTenantProgress.mockReturnValue({ elapsedMs: 1, label: "5m", severity: "ok" });
    render(<div>{tenantStatusCell(tenant({ tenantStatus: "In progress" }), 0, t)}</div>);
    expect(screen.getByText("5m")).toBeInTheDocument();
    expect(screen.queryByText(/progress_danger_suffix/)).not.toBeInTheDocument();
    expect(screen.queryByText(/progress_warning_suffix/)).not.toBeInTheDocument();
  });
});
