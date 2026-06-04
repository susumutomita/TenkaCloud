import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";

/**
 * Issue #1697: 自テナントデータ export。 events / deployments の cursor を最後まで辿って
 * 全件集約し (silent truncation 無し)、 competitor accounts を 1 回取得し、 メタ付き JSON に
 * まとめる。 downloadJson は Blob → anchor click → revoke の機構を pin。
 */
const { mockListEvents, mockListAllDeployments, mockListCompetitorAccounts } = vi.hoisted(() => ({
  mockListEvents: vi.fn(),
  mockListAllDeployments: vi.fn(),
  mockListCompetitorAccounts: vi.fn(),
}));

vi.mock("../../src/api/events-client", () => ({ listEvents: mockListEvents }));
vi.mock("../../src/api/deploy-client", () => ({ listAllDeployments: mockListAllDeployments }));
vi.mock("../../src/api/competitor-accounts-client", () => ({
  listCompetitorAccounts: mockListCompetitorAccounts,
}));

const {
  collectTenantDataExport,
  downloadJson,
  buildTenantExportFilename,
  TENANT_EXPORT_SCHEMA_VERSION,
} = await import("../../src/data/tenant-data-export");

const api = {} as ApiClient;

afterEach(() => vi.clearAllMocks());

describe("collectTenantDataExport (Issue #1697)", () => {
  it("should follow cursors across pages and aggregate all events + deployments", async () => {
    mockListEvents
      .mockResolvedValueOnce({ items: [{ id: "e1" }], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "e2" }] }); // no cursor → stop
    mockListAllDeployments.mockResolvedValueOnce({ items: [{ jobId: "j1" }] });
    mockListCompetitorAccounts.mockResolvedValue({ items: [{ awsAccountId: "111122223333" }] });

    const data = await collectTenantDataExport(api, {
      tenantId: "tenant-1",
      tenantName: "Acme",
      exportedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(data.schemaVersion).toBe(TENANT_EXPORT_SCHEMA_VERSION);
    expect(data.tenantId).toBe("tenant-1");
    expect(data.tenantName).toBe("Acme");
    expect(data.exportedAt).toBe("2026-06-04T00:00:00.000Z");
    expect(data.events).toEqual([{ id: "e1" }, { id: "e2" }]); // 2 pages merged
    expect(data.deployments).toEqual([{ jobId: "j1" }]);
    expect(data.competitorAccounts).toEqual([{ awsAccountId: "111122223333" }]);
    expect(data.auditLog).toMatch(/CSV export/);
    expect(mockListEvents).toHaveBeenCalledTimes(2);
    // 2 ページ目は cursor を渡している
    expect(mockListEvents).toHaveBeenLastCalledWith(api, { limit: 200, cursor: "c1" });
  });

  it("should handle empty result sets", async () => {
    mockListEvents.mockResolvedValue({ items: [] });
    mockListAllDeployments.mockResolvedValue({ items: [] });
    mockListCompetitorAccounts.mockResolvedValue({ items: [] });
    const data = await collectTenantDataExport(api, {
      tenantId: null,
      tenantName: null,
      exportedAt: "2026-06-04T00:00:00.000Z",
    });
    expect(data.events).toEqual([]);
    expect(data.deployments).toEqual([]);
    expect(data.competitorAccounts).toEqual([]);
    expect(data.tenantId).toBeNull();
  });
});

describe("buildTenantExportFilename", () => {
  it("should build a filename from tenantId and a colon/dot-normalized timestamp", () => {
    expect(buildTenantExportFilename("tenant-1", "2026-06-04T01:02:03.456Z")).toBe(
      "tenant-data-tenant-1-2026-06-04T01-02-03-456Z.json",
    );
  });

  it("should fall back to 'unknown' when tenantId is null", () => {
    expect(buildTenantExportFilename(null, "2026-06-04T00:00:00.000Z")).toBe(
      "tenant-data-unknown-2026-06-04T00-00-00-000Z.json",
    );
  });
});

describe("downloadJson", () => {
  it("should create a blob URL, click an anchor, and revoke the URL", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:fake");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    const click = vi.fn();
    const remove = vi.fn();
    const anchor = { href: "", download: "", click, remove } as unknown as HTMLAnchorElement;
    const appendChild = vi.fn();
    const fakeDoc = {
      createElement: vi.fn().mockReturnValue(anchor),
      body: { appendChild },
    } as unknown as Document;

    downloadJson("out.json", { a: 1 }, fakeDoc);

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.download).toBe("out.json");
    expect(anchor.href).toBe("blob:fake");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    vi.unstubAllGlobals();
  });
});
