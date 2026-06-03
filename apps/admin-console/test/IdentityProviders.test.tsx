import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { IdentityProvidersPage } from "../src/pages/IdentityProviders";

/**
 * Issue #1418: 未テストだった admin IdentityProviders (SAML IdP 一覧/削除/追加) page を 100% に。
 * useAuth / createIdpClient / i18n / format / 子 CreateIdpModal を mock し、 list 成功・失敗・空、
 * 削除 (confirm 可否 / 成功 / 失敗)、 not-wired、 client 不在、 追加モーダル開閉を網羅する。
 */
const { mockUseAuth, mockCreateIdpClient, mockList, mockRemove } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockCreateIdpClient: vi.fn(),
  mockList: vi.fn(),
  mockRemove: vi.fn(),
}));

vi.mock("../src/auth/AuthProvider", () => ({ useAuth: mockUseAuth }));
vi.mock("../src/api/idp-client", () => ({
  createIdpClient: mockCreateIdpClient,
  describeIdpError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../src/i18n", async () => {
  const en = (await import("../src/i18n/locales/en.json")).default as Record<string, unknown>;
  const resolve = (key: string): string => {
    const v = key
      .split(".")
      .reduce<unknown>(
        (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
        en,
      );
    return typeof v === "string" ? v : key;
  };
  return {
    useLang: () => "en",
    useT: () => (key: string, params?: Record<string, string | number>) => {
      let s = resolve(key);
      if (params)
        for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
      return s;
    },
  };
});
vi.mock("../src/lib/format", () => ({ formatRelativeTime: (iso: string) => `rel:${iso}` }));
vi.mock("../src/pages/CreateIdpModal", () => ({
  CreateIdpModal: ({
    onClose,
    onCreated,
  }: {
    onClose: () => void;
    onCreated: () => Promise<void>;
  }) => (
    <div data-testid="create-modal">
      <button type="button" onClick={onClose}>
        mock-modal-close
      </button>
      <button
        type="button"
        onClick={() => {
          void onCreated();
        }}
      >
        mock-modal-created
      </button>
    </div>
  ),
}));

const config = {
  apiBaseUrl: "https://api.example.com",
  cognitoDomain: "auth.example.com",
  cognitoClientId: "client-123",
  scope: "openid email",
  redirectUri: "https://app.example.com/callback",
  features: { samlSso: true },
} as AppConfig;

const idp = (over: Record<string, unknown> = {}) => ({
  idpId: "okta",
  displayName: "Okta",
  description: "corp okta",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAuth.mockReturnValue({ tokens: { idToken: "id-token" } });
  mockCreateIdpClient.mockReturnValue({ list: mockList, remove: mockRemove });
  mockList.mockResolvedValue([]);
  mockRemove.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("IdentityProvidersPage", () => {
  it("should show the feature-disabled hero (and skip fetch) when samlSso is off", () => {
    render(
      <IdentityProvidersPage config={{ ...config, features: { samlSso: false } } as AppConfig} />,
    );
    expect(screen.getByText("Identity providers are not available")).toBeInTheDocument();
    expect(mockCreateIdpClient).not.toHaveBeenCalled();
  });

  it("should show the not-wired alert when apiBaseUrl is missing", () => {
    render(<IdentityProvidersPage config={{ ...config, apiBaseUrl: "" } as AppConfig} />);
    expect(screen.getByText("The identity-provider API is unavailable")).toBeInTheDocument();
  });

  it("should not call list when there is no auth token (client null)", () => {
    mockUseAuth.mockReturnValue({ tokens: null });
    render(<IdentityProvidersPage config={config} />);
    expect(mockCreateIdpClient).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add SAML IdP" })).toBeInTheDocument();
  });

  it("should render IdP rows with description fallback and a test-sign-in deep link", async () => {
    mockList.mockResolvedValue([
      idp(),
      idp({ idpId: "entra", displayName: "Entra", description: undefined }),
    ]);
    render(<IdentityProvidersPage config={config} />);
    expect(await screen.findByText("Okta")).toBeInTheDocument();
    expect(screen.getByText("Entra")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument(); // description fallback for entra
    const testLinks = screen.getAllByRole("link", { name: "Test sign-in" });
    expect(testLinks[0]).toHaveAttribute("href", expect.stringContaining("identity_provider=okta"));
    expect(testLinks[0]).toHaveAttribute("href", expect.stringContaining("client_id=client-123"));
  });

  it("should show the empty state when there are no IdPs", async () => {
    mockList.mockResolvedValue([]);
    render(<IdentityProvidersPage config={config} />);
    expect(await screen.findByText(/No SAML IdPs configured/)).toBeInTheDocument();
  });

  it("should surface a load error", async () => {
    mockList.mockRejectedValue(new Error("list failed"));
    render(<IdentityProvidersPage config={config} />);
    expect(await screen.findByText("list failed")).toBeInTheDocument();
  });

  it("should delete an IdP after confirmation and refresh", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockList.mockResolvedValue([idp()]);
    render(<IdentityProvidersPage config={config} />);
    await screen.findByText("Okta");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith("okta"));
    expect(mockList).toHaveBeenCalledTimes(2); // initial + after delete
  });

  it("should not delete when the confirmation is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mockList.mockResolvedValue([idp()]);
    render(<IdentityProvidersPage config={config} />);
    await screen.findByText("Okta");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("should surface a delete error", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockList.mockResolvedValue([idp()]);
    mockRemove.mockRejectedValue(new Error("delete denied"));
    render(<IdentityProvidersPage config={config} />);
    await screen.findByText("Okta");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("delete denied")).toBeInTheDocument();
  });

  it("should open the create modal, close it, and refresh after creation", async () => {
    mockList.mockResolvedValue([]);
    render(<IdentityProvidersPage config={config} />);
    await screen.findByText(/No SAML IdPs configured/);

    fireEvent.click(screen.getByRole("button", { name: "Add SAML IdP" }));
    const modal = screen.getByTestId("create-modal");
    // onClose path
    fireEvent.click(within(modal).getByText("mock-modal-close"));
    await waitFor(() => expect(screen.queryByTestId("create-modal")).not.toBeInTheDocument());

    // re-open then onCreated path
    fireEvent.click(screen.getByRole("button", { name: "Add SAML IdP" }));
    fireEvent.click(within(screen.getByTestId("create-modal")).getByText("mock-modal-created"));
    await waitFor(() => expect(screen.queryByTestId("create-modal")).not.toBeInTheDocument());
    expect(mockList).toHaveBeenCalledTimes(2); // initial + after creation
  });
});
