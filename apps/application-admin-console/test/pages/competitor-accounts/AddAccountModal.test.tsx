import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../../src/config";
import { AddAccountModal } from "../../../src/pages/competitor-accounts/AddAccountModal";

/**
 * AddAccountModal (#1314): account-id / alias validation + submit (createCompetitorAccount) +
 * friendly error を pin する。 useApiClient / createCompetitorAccount / i18n は mock、
 * FriendlyErrorAlert + toFriendlyError + defaultCompetitorRoleName は実物。
 */
const { mockUseApiClient, mockCreate } = vi.hoisted(() => ({
  mockUseApiClient: vi.fn(),
  mockCreate: vi.fn(),
}));

vi.mock("../../../src/api/client", async (importOriginal) => {
  // ApiError は friendly-error が instanceof で使うので実物を残す (partial mock)。
  const actual = await importOriginal<typeof import("../../../src/api/client")>();
  return { ...actual, useApiClient: mockUseApiClient };
});
vi.mock("../../../src/api/competitor-accounts-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/api/competitor-accounts-client")>();
  return { ...actual, createCompetitorAccount: mockCreate };
});
vi.mock("../../../src/i18n", () => {
  const t = (key: string) => key;
  return { useT: () => t };
});

const config = { tenantId: "tenant-1", apiBaseUrl: "https://api.example.com" } as AppConfig;
const props = (over = {}) => ({
  config,
  visible: true,
  onDismiss: vi.fn(),
  onSuccess: vi.fn(),
  ...over,
});
const accountInput = () => screen.getByPlaceholderText("123456789012");
const submitBtn = () =>
  screen.getByRole("button", { name: "competitor_accounts.add_modal_submit" });

beforeEach(() => {
  mockUseApiClient.mockReturnValue({ fetch: vi.fn() });
  mockCreate.mockReset().mockResolvedValue({
    tenkaCloudAccountId: "999988887777",
    externalId: "ext-123",
    competitorRoleName: "Role",
  });
});

afterEach(() => vi.clearAllMocks());

describe("AddAccountModal", () => {
  it("should keep submit disabled until a 12-digit account id is entered", () => {
    render(<AddAccountModal {...props()} />);
    expect(submitBtn()).toBeDisabled(); // empty
    fireEvent.change(accountInput(), { target: { value: "123" } }); // invalid
    expect(
      screen.getByText("competitor_accounts.add_modal_account_id_invalid"),
    ).toBeInTheDocument();
    expect(submitBtn()).toBeDisabled();
    fireEvent.change(accountInput(), { target: { value: "123456789012" } }); // valid
    expect(submitBtn()).toBeEnabled();
  });

  it("should disable submit when the alias exceeds the max length", () => {
    render(<AddAccountModal {...props()} />);
    fireEvent.change(accountInput(), { target: { value: "123456789012" } });
    fireEvent.change(screen.getByPlaceholderText("Team Acme prod"), {
      target: { value: "a".repeat(121) },
    });
    expect(submitBtn()).toBeDisabled();
  });

  it("should create the account with an alias and call onSuccess", async () => {
    const onSuccess = vi.fn();
    render(<AddAccountModal {...props({ onSuccess })} />);
    fireEvent.change(accountInput(), { target: { value: "123456789012" } });
    fireEvent.change(screen.getByPlaceholderText("Team Acme prod"), { target: { value: "Acme" } });
    fireEvent.click(submitBtn());
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ awsAccountId: "123456789012", alias: "Acme" }),
      ),
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("should omit the alias key when no alias is given", async () => {
    render(<AddAccountModal {...props()} />);
    fireEvent.change(accountInput(), { target: { value: "123456789012" } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0]?.[1]).not.toHaveProperty("alias");
  });

  it("should show a friendly error when creation fails", async () => {
    mockCreate.mockRejectedValue(new Error("account already linked"));
    render(<AddAccountModal {...props()} />);
    fireEvent.change(accountInput(), { target: { value: "123456789012" } });
    fireEvent.click(submitBtn());
    expect(await screen.findByText("account already linked")).toBeInTheDocument();
  });

  it("should reset and dismiss on cancel", () => {
    const onDismiss = vi.fn();
    render(<AddAccountModal {...props({ onDismiss })} />);
    fireEvent.change(accountInput(), { target: { value: "123456789012" } });
    fireEvent.click(screen.getByRole("button", { name: "competitor_accounts.add_modal_cancel" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("should update the region and role inputs", () => {
    render(<AddAccountModal {...props()} />);
    const boxes = screen.getAllByRole("textbox"); // [account, alias, region, role]
    fireEvent.change(boxes[2], { target: { value: "us-east-1" } });
    fireEvent.change(boxes[3], { target: { value: "CustomRole" } });
    expect(boxes[2]).toHaveValue("us-east-1");
    expect(boxes[3]).toHaveValue("CustomRole");
  });

  it("should keep submit disabled when the API client is unavailable", () => {
    mockUseApiClient.mockReturnValue(null);
    render(<AddAccountModal {...props()} />);
    fireEvent.change(accountInput(), { target: { value: "123456789012" } });
    expect(submitBtn()).toBeDisabled();
  });

  it("should keep submit disabled for a read-only viewer", () => {
    mockUseApiClient.mockReturnValue({
      fetch: vi.fn(),
      tenantAccess: { role: "viewer", canMutateTenant: false },
    });
    render(<AddAccountModal {...props()} />);
    fireEvent.change(accountInput(), { target: { value: "123456789012" } });
    expect(submitBtn()).toBeDisabled();
  });
});
