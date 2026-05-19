import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  listCompetitorAccounts: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return {
    ...actual,
    useApiClient: mocks.useApiClient,
  };
});

vi.mock("../../src/api/competitor-accounts-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/competitor-accounts-client")>();
  return {
    ...actual,
    listCompetitorAccounts: mocks.listCompetitorAccounts,
  };
});

import type { AppConfig } from "../../src/config";

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Test Tenant",
  apiBaseUrl: "https://api.example.com/prod",
};

const { EventCreatePage } = await import("../../src/pages/EventCreate");

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/events/new"]}>
        <Routes>
          <Route path="/events/new" element={<EventCreatePage config={config} />} />
          <Route path="/competitor-accounts" element={<div>Competitor Accounts page</div>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useApiClient.mockReturnValue({});
  // #1090: i18n test 配下では ja を default にして既存の ja string assertion を維持する。
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
});

afterEach(() => vi.restoreAllMocks());

describe("EventCreatePage #719 verified account 0 件の救済 UX", () => {
  it("verified account が 0 件なら Alert と Competitor Accounts link を表示すべき", async () => {
    mocks.listCompetitorAccounts.mockResolvedValueOnce({ items: [] });
    renderPage();

    expect(
      await screen.findByText(/verified=true な Competitor Account がありません/),
    ).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "Competitor Accounts へ移動" });
    expect(link).toHaveAttribute("href", "/competitor-accounts");

    const disabledSelect = screen
      .getAllByText("No verified accounts available. Add one first.")
      .map((node) => node.closest("button"))
      .find((button): button is HTMLButtonElement => button instanceof HTMLButtonElement);
    expect(disabledSelect).toBeDisabled();
  });

  it("verified=true が 1 件あれば Alert を出さず dropdown を通常 render すべき", async () => {
    mocks.listCompetitorAccounts.mockResolvedValueOnce({
      items: [
        {
          awsAccountId: "111111111111",
          region: "ap-northeast-1",
          competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
          alias: "Verified Team A",
          verified: true,
          verifiedAt: "2026-05-10T00:00:00.000Z",
          createdAt: "2026-05-09T00:00:00.000Z",
          updatedAt: "2026-05-10T00:00:00.000Z",
        },
      ],
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText(/verified account を選択/).length).toBeGreaterThan(0);
    });

    expect(
      screen.queryByText(/verified=true な Competitor Account がありません/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("No verified accounts available. Add one first."),
    ).not.toBeInTheDocument();
  });
});
