import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { TenantCreatePage } from "../src/pages/TenantCreate";

/**
 * Issue #1418: 未テストだった admin TenantCreate (テナント作成フォーム) page を 100% に。
 * useApiClient / createTenant / useNavigate / i18n を mock し、 Cloudscape test-utils で
 * input / select を駆動して submit 可否・成功・失敗・cancel・api 不在を網羅する。
 */
const { mockUseApiClient, mockCreateTenant, mockNavigate } = vi.hoisted(() => ({
  mockUseApiClient: vi.fn(),
  mockCreateTenant: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock("../src/api/client", () => ({ useApiClient: mockUseApiClient }));
vi.mock("../src/api/tenants", () => ({ createTenant: mockCreateTenant }));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock("../src/i18n", () => ({ useT: () => (key: string) => key }));

const submitButton = () => screen.getByRole("button", { name: "tenant_create.submit" });
const fillForm = (container: HTMLElement, name: string, email: string) => {
  const inputs = createWrapper(container).findAllInputs();
  inputs[0]?.setInputValue(name);
  inputs[1]?.setInputValue(email);
};

afterEach(() => vi.clearAllMocks());

describe("TenantCreatePage", () => {
  beforeEach(() => mockUseApiClient.mockReturnValue({}));

  it("should keep submit disabled until both name and email are filled", () => {
    const { container } = render(<TenantCreatePage config={{} as AppConfig} />);
    expect(submitButton()).toBeDisabled();
    createWrapper(container).findAllInputs()[0]?.setInputValue("Acme"); // name only
    expect(submitButton()).toBeDisabled();
    createWrapper(container).findAllInputs()[1]?.setInputValue("admin@acme.test");
    expect(submitButton()).toBeEnabled();
  });

  it("should create the tenant with the selected tier and navigate on success", async () => {
    mockCreateTenant.mockResolvedValue(undefined);
    const { container } = render(<TenantCreatePage config={{} as AppConfig} />);
    fillForm(container, "Acme", "admin@acme.test");
    const select = createWrapper(container).findSelect();
    select?.openDropdown();
    select?.selectOptionByValue("platinum");
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/tenants"));
    expect(mockCreateTenant).toHaveBeenCalledWith(
      {},
      { tenantName: "Acme", email: "admin@acme.test", tier: "platinum" },
    );
  });

  it("should show an error alert and stay on the form when creation fails", async () => {
    mockCreateTenant.mockRejectedValue(new Error("tenant already exists"));
    const { container } = render(<TenantCreatePage config={{} as AppConfig} />);
    fillForm(container, "Acme", "admin@acme.test");
    fireEvent.click(submitButton());
    expect(await screen.findByText("tenant already exists")).toBeInTheDocument();
    expect(screen.getByText("tenant_create.error_header")).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("should navigate back to the tenant list on cancel", () => {
    render(<TenantCreatePage config={{} as AppConfig} />);
    fireEvent.click(screen.getByRole("button", { name: "tenant_create.cancel" }));
    expect(mockNavigate).toHaveBeenCalledWith("/tenants");
  });

  it("should not call createTenant when the API client is unavailable", () => {
    mockUseApiClient.mockReturnValue(null);
    const { container } = render(<TenantCreatePage config={{} as AppConfig} />);
    fillForm(container, "Acme", "admin@acme.test");
    fireEvent.click(submitButton());
    expect(mockCreateTenant).not.toHaveBeenCalled();
  });
});
