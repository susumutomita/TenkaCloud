import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkCreateCompetitorAccountsResponse } from "../../../src/api/competitor-accounts-client";
import type { AppConfig } from "../../../src/config";
import { BulkImportModal } from "../../../src/pages/competitor-accounts/BulkImportModal";

vi.mock("../../../src/i18n", () => ({ useT: () => (key: string) => key }));

const mocks = vi.hoisted(() => ({
  bulkCreateCompetitorAccounts: vi.fn(),
  apiClient: { post: vi.fn() },
}));

vi.mock("../../../src/api/client", async (importOriginal) => {
  // `toFriendlyError` does `err instanceof ApiError`, so the real class has to
  // survive the mock — stubbing it with a fresh one would make every error an
  // "unknown" one and hide exactly what this file is checking.
  const actual = await importOriginal<typeof import("../../../src/api/client")>();
  return {
    ...actual,
    useApiClient: () => mocks.apiClient,
    canMutateTenant: () => true,
  };
});

vi.mock("../../../src/api/competitor-accounts-client", () => ({
  bulkCreateCompetitorAccounts: mocks.bulkCreateCompetitorAccounts,
}));

// The modal only reads `tenantId` (for the suggested role name), so the rest of
// AppConfig is left out rather than filled with values no assertion here checks.
const configFixture: Partial<AppConfig> = { tenantId: "acme" };
const config = configFixture as AppConfig;

const response = (
  over: Partial<BulkCreateCompetitorAccountsResponse> = {},
): BulkCreateCompetitorAccountsResponse => ({
  results: [
    { awsAccountId: "222222222222", outcome: "created" },
    { awsAccountId: "333333333333", outcome: "duplicate", message: "already registered" },
  ],
  created: 1,
  duplicate: 1,
  invalid: 0,
  failed: 0,
  externalId: "ext-id-abc",
  tenkaCloudAccountId: "111111111111",
  ...over,
});

function renderModal(overrides: Partial<Parameters<typeof BulkImportModal>[0]> = {}) {
  const onCompleted = vi.fn();
  const onDismiss = vi.fn();
  render(
    <BulkImportModal
      config={config}
      visible
      onDismiss={onDismiss}
      onCompleted={onCompleted}
      {...overrides}
    />,
  );
  return { onCompleted, onDismiss };
}

const typeAccounts = (value: string) => {
  const textarea = screen.getByPlaceholderText(/222222222222/);
  fireEvent.change(textarea, { target: { value } });
};

const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "competitor_accounts.bulk_modal_submit" }));

describe("BulkImportModal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should send the pasted account IDs with the screen's region and role name as defaults", async () => {
    mocks.bulkCreateCompetitorAccounts.mockResolvedValueOnce(response());
    renderModal();
    typeAccounts("222222222222\n333333333333");
    submit();

    await waitFor(() => expect(mocks.bulkCreateCompetitorAccounts).toHaveBeenCalledTimes(1));
    const [, body] = mocks.bulkCreateCompetitorAccounts.mock.calls[0] as [
      unknown,
      { defaults: { region: string; competitorRoleName: string }; accounts: unknown[] },
    ];
    expect(body.accounts).toEqual([
      { awsAccountId: "222222222222" },
      { awsAccountId: "333333333333" },
    ]);
    expect(body.defaults.region).toBe("ap-northeast-1");
    expect(body.defaults.competitorRoleName).toContain("acme");
  });

  it("should let the pasted JSON's own defaults win over the screen inputs", async () => {
    mocks.bulkCreateCompetitorAccounts.mockResolvedValueOnce(response());
    renderModal();
    typeAccounts(
      JSON.stringify({
        defaults: { region: "us-east-1", competitorRoleName: "Pasted-Role" },
        accounts: [{ awsAccountId: "222222222222" }],
      }),
    );
    submit();

    await waitFor(() => expect(mocks.bulkCreateCompetitorAccounts).toHaveBeenCalledTimes(1));
    const [, body] = mocks.bulkCreateCompetitorAccounts.mock.calls[0] as [
      unknown,
      { defaults: { region: string; competitorRoleName: string } },
    ];
    expect(body.defaults).toEqual({
      region: "us-east-1",
      competitorRoleName: "Pasted-Role",
    });
  });

  it("should show every row's outcome rather than collapsing a partial success", async () => {
    // The operator's next action depends on which rows landed, so a mixed
    // result has to stay per row on screen.
    mocks.bulkCreateCompetitorAccounts.mockResolvedValueOnce(response());
    renderModal();
    typeAccounts("222222222222\n333333333333");
    submit();

    await screen.findByText("competitor_accounts.bulk_outcome_created");
    expect(screen.getByText("competitor_accounts.bulk_outcome_duplicate")).toBeTruthy();
    expect(screen.getByText("already registered")).toBeTruthy();
    expect(screen.getByText("222222222222")).toBeTruthy();
  });

  it("should hand the caller the role name it actually sent, so the shared values match", async () => {
    mocks.bulkCreateCompetitorAccounts.mockResolvedValueOnce(response());
    const { onCompleted } = renderModal();
    typeAccounts(
      JSON.stringify({
        defaults: { competitorRoleName: "Pasted-Role" },
        accounts: [{ awsAccountId: "222222222222" }],
      }),
    );
    submit();

    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(onCompleted.mock.calls[0]?.[1]).toBe("Pasted-Role");
  });

  it("should block submission and name the problem while the input does not parse", () => {
    renderModal();
    typeAccounts("222222222222 oops");
    expect(screen.getByText(/AWS Account ID として読めません: oops/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "competitor_accounts.bulk_modal_submit" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(mocks.bulkCreateCompetitorAccounts).not.toHaveBeenCalled();
  });

  it("should surface a request failure instead of reporting a silent success", async () => {
    mocks.bulkCreateCompetitorAccounts.mockRejectedValueOnce(new Error("boom"));
    const { onCompleted } = renderModal();
    typeAccounts("222222222222");
    submit();

    await waitFor(() => expect(mocks.bulkCreateCompetitorAccounts).toHaveBeenCalled());
    // No result table appeared, and the caller was not told anything landed.
    await waitFor(() =>
      expect(screen.queryByText("competitor_accounts.bulk_outcome_created")).toBeNull(),
    );
    expect(onCompleted).not.toHaveBeenCalled();
  });
});
