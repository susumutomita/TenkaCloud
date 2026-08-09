import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import type { AppConfig } from "../../src/config";

const { mockUseApiClient } = vi.hoisted(() => ({ mockUseApiClient: vi.fn() }));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mockUseApiClient };
});
vi.mock("../../src/i18n", () => ({
  useLang: () => "en",
  useT: () => (key: string) => key,
}));

const { SettingsPage } = await import("../../src/pages/Settings");

const config = {} as AppConfig;

function fakeApiClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    tenantAccess: { role: "editor", canMutateTenant: true },
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    delJson: vi.fn(),
    ...over,
  } as unknown as ApiClient;
}

const renderPage = (override: AppConfig = config) => render(<SettingsPage config={override} />);

afterEach(() => {
  vi.clearAllMocks();
});

describe("SettingsPage", () => {
  beforeEach(() => {
    mockUseApiClient.mockReturnValue(null);
  });

  it("should render nothing but a spinner while apiClient / flags are unavailable", () => {
    renderPage();
    expect(screen.getByText("settings.header")).toBeInTheDocument();
  });

  it("should load flags and render a toggle per registered feature", async () => {
    const get = vi.fn().mockResolvedValue({ flags: { redTeam: false } });
    mockUseApiClient.mockReturnValue(fakeApiClient({ get }));
    renderPage();

    expect(await screen.findByText("samlSso")).toBeInTheDocument();
    expect(screen.getByText("nonAwsRuntime")).toBeInTheDocument();
    expect(screen.getByText("redTeam")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/feature-flags");
  });

  it("should fall back to the registry default when a key has no stored override", async () => {
    mockUseApiClient.mockReturnValue(
      fakeApiClient({ get: vi.fn().mockResolvedValue({ flags: {} }) }),
    );
    renderPage();
    await screen.findByText("redTeam");
    // redTeam defaults to true in FEATURE_REGISTRY.
    const toggles = screen.getAllByRole("checkbox");
    expect(toggles.some((el) => (el as HTMLInputElement).checked)).toBe(true);
  });

  it("should show a load error when GET /feature-flags fails", async () => {
    mockUseApiClient.mockReturnValue(
      fakeApiClient({ get: vi.fn().mockRejectedValue(new Error("boom")) }),
    );
    renderPage();
    expect(await screen.findByText("settings.load_error")).toBeInTheDocument();
  });

  it("should not update state after unmount once the pending GET resolves", async () => {
    let resolveGet: ((value: { flags: Record<string, boolean> }) => void) | undefined;
    const get = vi.fn().mockReturnValue(
      new Promise<{ flags: Record<string, boolean> }>((resolve) => {
        resolveGet = resolve;
      }),
    );
    mockUseApiClient.mockReturnValue(fakeApiClient({ get }));
    const { unmount } = renderPage();
    unmount();
    resolveGet?.({ flags: { redTeam: false } });
    // No assertion needed beyond "this doesn't throw" — the `cancelled` guard in the
    // effect's .then() must skip the now-unmounted component's setFlags call.
    await Promise.resolve();
  });

  it("should disable every toggle for a non-mutating (viewer) role", async () => {
    mockUseApiClient.mockReturnValue(
      fakeApiClient({
        tenantAccess: { role: "viewer", canMutateTenant: false },
        get: vi.fn().mockResolvedValue({ flags: {} }),
      } as unknown as Partial<ApiClient>),
    );
    renderPage();
    await screen.findByText("redTeam");
    expect(screen.getByText("settings.readonly_notice")).toBeInTheDocument();
    for (const toggle of screen.getAllByRole("checkbox")) {
      expect(toggle).toBeDisabled();
    }
  });

  it("should PUT the full flag set (not a partial patch) and apply the server response", async () => {
    const put = vi
      .fn()
      .mockResolvedValue({ flags: { samlSso: true, nonAwsRuntime: false, redTeam: true } });
    mockUseApiClient.mockReturnValue(
      fakeApiClient({ get: vi.fn().mockResolvedValue({ flags: {} }), put }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("samlSso");

    const samlToggle = screen.getAllByRole("checkbox")[0] as HTMLElement;
    await user.click(samlToggle);

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith(
      "/admin/feature-flags",
      expect.objectContaining({ samlSso: true, nonAwsRuntime: false, redTeam: true }),
    );
  });

  it("should not update state after unmount once the pending GET rejects", async () => {
    let rejectGet: ((reason: unknown) => void) | undefined;
    const get = vi.fn().mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectGet = reject;
      }),
    );
    mockUseApiClient.mockReturnValue(fakeApiClient({ get }));
    const { unmount } = renderPage();
    unmount();
    rejectGet?.(new Error("boom"));
    // The `cancelled` guard in the effect's .catch() must skip setLoadError after unmount.
    await Promise.resolve();
  });

  it("should ignore a toggle click while another key's save is still in flight", async () => {
    let resolvePut: ((value: { flags: Record<string, boolean> }) => void) | undefined;
    const put = vi.fn().mockReturnValue(
      new Promise<{ flags: Record<string, boolean> }>((resolve) => {
        resolvePut = resolve;
      }),
    );
    mockUseApiClient.mockReturnValue(
      fakeApiClient({ get: vi.fn().mockResolvedValue({ flags: {} }), put }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("samlSso");

    const toggles = screen.getAllByRole("checkbox");
    // First click starts a PUT that stays pending; the second key's Toggle is still
    // enabled (only the in-flight key is disabled) but the guard must drop the click.
    await user.click(toggles[0] as HTMLElement);
    await user.click(toggles[1] as HTMLElement);
    expect(put).toHaveBeenCalledTimes(1);

    resolvePut?.({ flags: { samlSso: true, nonAwsRuntime: false, redTeam: true } });
    await waitFor(() => expect(toggles[1]).not.toBeDisabled());
  });

  it("should still allow toggling from registry defaults when the initial GET failed", async () => {
    const put = vi
      .fn()
      .mockResolvedValue({ flags: { samlSso: true, nonAwsRuntime: false, redTeam: true } });
    mockUseApiClient.mockReturnValue(
      fakeApiClient({ get: vi.fn().mockRejectedValue(new Error("boom")), put }),
    );
    const user = userEvent.setup();
    renderPage();
    // GET failed → flags stays null, but the toggles render from registry defaults.
    await screen.findByText("settings.load_error");
    await screen.findByText("samlSso");

    await user.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  });

  it("should roll back the optimistic update and show an error when PUT fails", async () => {
    const put = vi.fn().mockRejectedValue(new Error("boom"));
    mockUseApiClient.mockReturnValue(
      fakeApiClient({ get: vi.fn().mockResolvedValue({ flags: { samlSso: false } }), put }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("samlSso");

    const samlToggle = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    expect(samlToggle.checked).toBe(false);
    await user.click(samlToggle);

    expect(await screen.findByText("settings.save_error")).toBeInTheDocument();
    await waitFor(() => expect(samlToggle.checked).toBe(false));
  });
});

/**
 * deploy-time override の尊重 (Issue 2984)。
 *
 * Lite の初期セットアップは `runtime-config.json` の `features` で `samlSso` を有効化する。
 * この画面はそれを見ずに registry 既定値へ落ちていたため、機能が実際に動いていて左ナビにも
 * 「ID プロバイダ」が出ているのに、トグルだけが OFF と表示されていた。
 *
 * 実際に gate している 2 経路 (AppLayout の nav と IdentityProviders のガード) はどちらも
 * `config.features` を見ているので、食い違っていたのはこの画面の表示だけ。security bypass
 * ではないが、tenant admin が「無効になっている」と誤認する。
 */
describe("SettingsPage deploy-time overrides (Issue 2984)", () => {
  /** テナント別 override が 1 つも保存されていない状態。 */
  const noStoredOverrides = () => fakeApiClient({ get: vi.fn().mockResolvedValue({ flags: {} }) });

  function toggleFor(label: string): HTMLInputElement {
    // Cloudscape の Toggle は label と input が同じ wrapper に入る。
    const row = screen.getByText(label).closest("div");
    const input = row?.parentElement?.querySelector('input[type="checkbox"]');
    expect(input, `${label} のトグルが見つからない`).not.toBeNull();
    return input as HTMLInputElement;
  }

  it("は deploy 時に有効化された機能を ON と表示する", async () => {
    mockUseApiClient.mockReturnValue(noStoredOverrides());
    renderPage({ features: { samlSso: true } } as unknown as AppConfig);
    await screen.findByText("samlSso");
    expect(toggleFor("samlSso").checked).toBe(true);
  });

  it("は deploy 時に無効化された機能を OFF と表示する", async () => {
    // registry 既定が true の key を deploy 側で落としている場合。逆向きも効くこと。
    mockUseApiClient.mockReturnValue(noStoredOverrides());
    renderPage({ features: { redTeam: false } } as unknown as AppConfig);
    await screen.findByText("redTeam");
    expect(toggleFor("redTeam").checked).toBe(false);
  });

  it("は保存済みのテナント別 override を deploy-time override より優先する", async () => {
    mockUseApiClient.mockReturnValue(
      fakeApiClient({ get: vi.fn().mockResolvedValue({ flags: { samlSso: false } }) }),
    );
    renderPage({ features: { samlSso: true } } as unknown as AppConfig);
    await screen.findByText("samlSso");
    expect(toggleFor("samlSso").checked).toBe(false);
  });
});
