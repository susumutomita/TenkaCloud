import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";
import type { ProblemSummary } from "../../src/data/problems";

/**
 * HomePage: welcome hero + catalog stats + onboarding next-action (dismiss 可) + tenant info。
 * tokens 有無 / tenantName 欠落 warning / stats 集計 / catalog & view-all navigate /
 * onboarding の close→localStorage 永続 + 再訪で非表示 / tenantTier badge 有無 /
 * localStorage 例外時の安全側 fallback を pin。 useNavigate / useAuth / decodeIdToken /
 * listProblemSummaries / useT / resolveTenantDisplayName を mock。
 */
const {
  mockNav,
  mockAuth,
  mockDecode,
  mockListProblems,
  mockResolveName,
  mockUseApiClient,
  mockCollectExport,
  mockDownloadJson,
} = vi.hoisted(() => ({
  mockNav: vi.fn(),
  mockAuth: vi.fn(),
  mockDecode: vi.fn(),
  mockListProblems: vi.fn(),
  mockResolveName: vi.fn(),
  mockUseApiClient: vi.fn(),
  mockCollectExport: vi.fn(),
  mockDownloadJson: vi.fn(),
}));

vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/auth/claims", () => ({ decodeIdToken: mockDecode }));
vi.mock("../../src/data/problems", () => ({ listProblemSummaries: mockListProblems }));
vi.mock("../../src/i18n", () => ({ useT: () => (k: string) => k }));
vi.mock("../../src/lib/tenant-display", () => ({ resolveTenantDisplayName: mockResolveName }));
vi.mock("../../src/api/client", () => ({ useApiClient: mockUseApiClient }));
vi.mock("../../src/data/tenant-data-export", () => ({
  collectTenantDataExport: mockCollectExport,
  downloadJson: mockDownloadJson,
  buildTenantExportFilename: (id: string | null, at: string) => `tenant-data-${id}-${at}.json`,
}));

const { HomePage } = await import("../../src/pages/Home");

const cfg = {} as AppConfig;
const ONBOARDING_KEY = "TenkaCloud.applicationAdmin.onboardingDismissed";

/**
 * jsdom 標準 Storage は vi.spyOn が効かないので、 localStorage 例外 (private mode 等) を
 * 模すには window.localStorage 自体を throwing impl に差し替える。 返り値で元に戻す。
 */
function installThrowingStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {},
      clear() {},
      key() {
        return null;
      },
      length: 0,
    } satisfies Storage,
  });
  return () => {
    if (original) Object.defineProperty(window, "localStorage", original);
  };
}
const summary = (over: Partial<ProblemSummary> = {}): ProblemSummary =>
  ({
    id: "p",
    name: "P",
    category: "Battle",
    status: "ready",
    shortDescription: "s",
    difficulty: 1,
    estimatedDuration: "30m",
    tags: [],
    ...over,
  }) as ProblemSummary;

beforeEach(() => {
  window.localStorage.clear();
  mockNav.mockClear();
  mockAuth.mockReturnValue({ tokens: { idToken: "tok" } });
  mockDecode.mockReturnValue({
    "custom:tenantName": "Acme",
    "custom:tenantId": "t-1",
    "custom:tenantTier": "PLATINUM",
  });
  mockResolveName.mockReturnValue({ displayName: "Acme", fromFallback: false });
  mockUseApiClient.mockReturnValue({ get: vi.fn() }); // export button visible by default
  mockCollectExport.mockReset().mockResolvedValue({ events: [], deployments: [] });
  mockDownloadJson.mockReset();
  mockListProblems.mockReturnValue([
    summary({ id: "a", status: "ready", category: "Battle" }),
    summary({ id: "b", status: "draft", category: "Challenge" }),
    summary({ id: "c", status: "ready", category: "Challenge" }),
  ]);
});
afterEach(() => vi.clearAllMocks());

describe("HomePage", () => {
  it("should render the welcome hero, catalog stats, and tenant info from claims", () => {
    render(<HomePage config={cfg} />);
    expect(screen.getByText("home.welcome")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument(); // tenant name
    expect(screen.getByText("t-1")).toBeInTheDocument(); // tenant id
    expect(screen.getByText("PLATINUM")).toBeInTheDocument(); // tier badge
    // stats: total 3 / ready 2 / draft 1 / battle 1
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("home.tenant_name_missing_header")).not.toBeInTheDocument();
  });

  it("should show the tenant-name-missing warning when the name falls back", () => {
    mockResolveName.mockReturnValue({ displayName: null, fromFallback: true });
    render(<HomePage config={cfg} />);
    expect(screen.getByText("home.tenant_name_missing_body")).toBeInTheDocument();
  });

  it("should not decode a token and show unset placeholders when signed out", () => {
    mockAuth.mockReturnValue({ tokens: null });
    mockDecode.mockReturnValue(null);
    mockResolveName.mockReturnValue({ displayName: null, fromFallback: true });
    render(<HomePage config={cfg} />);
    expect(mockDecode).not.toHaveBeenCalled();
    expect(screen.getByText("home.value_unset")).toBeInTheDocument(); // tenant name unset
    expect(screen.getAllByText("home.value_unknown").length).toBeGreaterThan(0); // id + tier
  });

  it("should navigate to the catalog from the header button", () => {
    render(<HomePage config={cfg} />);
    fireEvent.click(screen.getByRole("button", { name: "home.open_catalog" }));
    expect(mockNav).toHaveBeenCalledWith("/problems");
  });

  it("should navigate from the onboarding view-all and dismiss it on close", () => {
    render(<HomePage config={cfg} />);
    expect(screen.getByText("home.next_action_body")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "home.next_action_view_all" }));
    expect(mockNav).toHaveBeenCalledWith("/problems");
    // close → localStorage 永続 + section 非表示。
    fireEvent.click(screen.getByRole("button", { name: "home.next_action_close_aria" }));
    expect(window.localStorage.getItem(ONBOARDING_KEY)).toBe("true");
    expect(screen.queryByText("home.next_action_body")).not.toBeInTheDocument();
  });

  it("should hide the onboarding section when already dismissed", () => {
    window.localStorage.setItem(ONBOARDING_KEY, "true");
    render(<HomePage config={cfg} />);
    expect(screen.queryByText("home.next_action_body")).not.toBeInTheDocument();
  });

  it("should fall back to showing onboarding when localStorage read throws", () => {
    const restore = installThrowingStorage();
    try {
      render(<HomePage config={cfg} />);
      // 初期 read で getItem が throw → readOnboardingDismissed の catch → false → onboarding 表示。
      expect(screen.getByText("home.next_action_body")).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("should still hide onboarding even if persisting the dismissal throws", () => {
    const restore = installThrowingStorage();
    try {
      render(<HomePage config={cfg} />);
      fireEvent.click(screen.getByRole("button", { name: "home.next_action_close_aria" }));
      // close の setItem が throw → writeOnboardingDismissed の catch (no-op)。 それでも
      // setOnboardingDismissed(true) は走るので section は消える。
      expect(screen.queryByText("home.next_action_body")).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  describe("Issue #1697: data export", () => {
    it("should collect tenant data and trigger a JSON download on export", async () => {
      mockCollectExport.mockResolvedValue({ events: [{ id: "e1" }], deployments: [] });
      render(<HomePage config={cfg} />);
      fireEvent.click(screen.getByRole("button", { name: /home.export_data/ }));
      await waitFor(() => expect(mockCollectExport).toHaveBeenCalledOnce());
      expect(mockCollectExport).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: "t-1", tenantName: "Acme" }),
      );
      expect(mockDownloadJson).toHaveBeenCalledOnce();
    });

    it("should surface an error alert when the export fails", async () => {
      mockCollectExport.mockRejectedValue(new Error("export boom"));
      render(<HomePage config={cfg} />);
      fireEvent.click(screen.getByRole("button", { name: /home.export_data/ }));
      expect(await screen.findByText("export boom")).toBeInTheDocument();
      expect(screen.getByText("home.export_error_header")).toBeInTheDocument();
      expect(mockDownloadJson).not.toHaveBeenCalled();
    });

    it("should show a generic message when the export rejects with a non-Error", async () => {
      mockCollectExport.mockRejectedValue("string failure");
      render(<HomePage config={cfg} />);
      fireEvent.click(screen.getByRole("button", { name: /home.export_data/ }));
      expect(await screen.findByText("home.export_error_generic")).toBeInTheDocument();
    });

    it("should hide the export button when the API client is unavailable", () => {
      mockUseApiClient.mockReturnValue(null);
      render(<HomePage config={cfg} />);
      expect(screen.queryByRole("button", { name: /home.export_data/ })).not.toBeInTheDocument();
    });

    it("should pass null tenant identifiers when the claims lack them", async () => {
      mockDecode.mockReturnValue({}); // no custom:tenantId / custom:tenantName
      render(<HomePage config={cfg} />);
      fireEvent.click(screen.getByRole("button", { name: /home.export_data/ }));
      await waitFor(() => expect(mockCollectExport).toHaveBeenCalledOnce());
      expect(mockCollectExport).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: null, tenantName: null }),
      );
    });
  });
});
