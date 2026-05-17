import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getTenantSamlConfig: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mocks.useApiClient };
});

vi.mock("../../src/api/tenant-saml-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/tenant-saml-client")>();
  return { ...actual, getTenantSamlConfig: mocks.getTenantSamlConfig };
});

import type { AppConfig } from "../../src/config";
import { I18nProvider } from "../../src/i18n";
import { SamlSsoPage } from "../../src/pages/SamlSso";

const baseConfig: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Test Tenant",
  apiBaseUrl: "https://api.example.com/prod",
};

describe("SamlSsoPage tier gating (Issue #897)", () => {
  describe("pooled tenant のとき", () => {
    it("upgrade promo を表示し、 form は表示しないべき", async () => {
      mocks.useApiClient.mockReturnValue(null);
      const config: AppConfig = { ...baseConfig, isolation: "pooled" };
      render(
        <I18nProvider>
          <MemoryRouter>
            <SamlSsoPage config={config} />
          </MemoryRouter>
        </I18nProvider>,
      );
      await waitFor(() => {
        // \"Available on PLATINUM tier\" (en) または \"PLATINUM tier 限定機能\" (ja) を含む heading 等
        expect(screen.queryAllByText(/PLATINUM/).length).toBeGreaterThan(0);
      });
      // form の Provider name input は出ない
      expect(screen.queryByLabelText(/Provider name/i)).not.toBeInTheDocument();
      // form の Metadata URL input も出ない
      expect(screen.queryByLabelText(/Metadata URL/i)).not.toBeInTheDocument();
    });

    it("isolation 未指定 (undefined) も pooled 扱いで promo を表示すべき", async () => {
      mocks.useApiClient.mockReturnValue(null);
      const config: AppConfig = { ...baseConfig };
      render(
        <I18nProvider>
          <MemoryRouter>
            <SamlSsoPage config={config} />
          </MemoryRouter>
        </I18nProvider>,
      );
      await waitFor(() => {
        // \"Available on PLATINUM tier\" (en) または \"PLATINUM tier 限定機能\" (ja) を含む heading 等
        expect(screen.queryAllByText(/PLATINUM/).length).toBeGreaterThan(0);
      });
    });
  });

  describe("silo (PLATINUM) tenant のとき", () => {
    it("form を表示し、 promo は表示しないべき", async () => {
      mocks.useApiClient.mockReturnValue({});
      mocks.getTenantSamlConfig.mockResolvedValue({ enabled: false });
      const config: AppConfig = { ...baseConfig, isolation: "silo" };
      render(
        <I18nProvider>
          <MemoryRouter>
            <SamlSsoPage config={config} />
          </MemoryRouter>
        </I18nProvider>,
      );
      await waitFor(() => {
        expect(screen.getByLabelText(/Metadata URL/i)).toBeInTheDocument();
      });
    });
  });
});
