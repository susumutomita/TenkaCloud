import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  listCompetitorAccounts: vi.fn(),
  createCompetitorAccount: vi.fn(),
  deleteCompetitorAccount: vi.fn(),
  verifyCompetitorAccount: vi.fn(),
  rotateExternalId: vi.fn(),
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
    createCompetitorAccount: mocks.createCompetitorAccount,
    deleteCompetitorAccount: mocks.deleteCompetitorAccount,
    verifyCompetitorAccount: mocks.verifyCompetitorAccount,
    rotateExternalId: mocks.rotateExternalId,
  };
});

import type { AppConfig } from "../../src/config";

const { CompetitorAccountsPage } = await import("../../src/pages/CompetitorAccounts");

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Test Tenant",
  apiBaseUrl: "https://api.example.com/prod",
};

const baseAccount = {
  awsAccountId: "222222222222",
  region: "ap-northeast-1",
  competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
  verified: true,
  verifiedAt: "2026-05-11T00:00:00.000Z",
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
};

function renderPage() {
  return render(
    <MemoryRouter>
      <CompetitorAccountsPage config={config} />
    </MemoryRouter>,
  );
}

async function rotateAndRevealExternalId() {
  mocks.rotateExternalId.mockResolvedValueOnce({
    ...baseAccount,
    rotatedAt: "2026-05-12T00:00:00.000Z",
    externalId: "new-rotated-secret-value",
    tenkaCloudAccountId: "111111111111",
  });

  renderPage();
  await waitFor(() => expect(mocks.listCompetitorAccounts).toHaveBeenCalled());

  fireEvent.click(await screen.findByTestId(`rotate-${baseAccount.awsAccountId}`));
  fireEvent.click(await screen.findByTestId("rotate-confirm"));

  await waitFor(() =>
    expect(mocks.rotateExternalId).toHaveBeenCalledWith(
      expect.anything(),
      baseAccount.awsAccountId,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useApiClient.mockReturnValue({});
  mocks.listCompetitorAccounts.mockResolvedValue({ items: [baseAccount] });
});

afterEach(() => vi.restoreAllMocks());

describe("CompetitorAccountsPage rotate flow (Issue #596 / Phase 3.1)", () => {
  it("Rotate ExternalId button を押すと confirmation modal が出るべき", async () => {
    renderPage();
    await waitFor(() => expect(mocks.listCompetitorAccounts).toHaveBeenCalled());

    const rotateBtn = await screen.findByTestId(`rotate-${baseAccount.awsAccountId}`);
    fireEvent.click(rotateBtn);

    // confirmation modal の warning Alert が見える
    expect(await screen.findByText(/現在の ExternalId は即時失効します/)).toBeInTheDocument();
  });

  it("確認 modal の Rotate ボタンで API を呼び成功すると Reveal modal を表示するべき", async () => {
    await rotateAndRevealExternalId();

    // Reveal modal: 新 ExternalId の値が DOM に出る
    expect(await screen.findByText("new-rotated-secret-value")).toBeInTheDocument();
    // 一覧 reload (= 2 度目の list 呼び出し)
    await waitFor(() => expect(mocks.listCompetitorAccounts).toHaveBeenCalledTimes(2));
  });

  it("Reveal modal は Launch Stack を primary action として先頭に表示すべき", async () => {
    await rotateAndRevealExternalId();

    const launchStackText = await screen.findByText("Launch Stack (Quick-create deeplink)");
    const launchStackLink = launchStackText.closest("a");
    expect(launchStackLink).toBeInTheDocument();

    const launchHref = launchStackLink?.getAttribute("href") ?? "";
    expect(launchHref).toContain(
      "https://ap-northeast-1.console.aws.amazon.com/cloudformation/home",
    );
    expect(launchHref).toContain("#/stacks/quickcreate");
    expect(decodeURIComponent(launchHref)).toContain("param_TenkaCloudAccountId=111111111111");
    expect(decodeURIComponent(launchHref)).toContain("param_ExternalId=new-rotated-secret-value");
    expect(decodeURIComponent(launchHref)).toContain(
      "param_RoleName=TenkaCloud-CompetitorDeploy-Role",
    );

    const copyAllButton = screen.getByRole("button", {
      name: /すべて \(3 値 \+ 手順 \+ Launch Stack URL\) をコピー/,
    });
    expect(
      launchStackText.compareDocumentPosition(copyAllButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Reveal modal は手動 deploy の 3 値を折りたたみ section に表示すべき", async () => {
    await rotateAndRevealExternalId();

    const manualDeployToggle = await screen.findByRole("button", {
      name: /手動 deploy の詳細/,
    });
    expect(manualDeployToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(manualDeployToggle);

    expect(manualDeployToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/TenkaCloud Account ID/)).toBeInTheDocument();
    expect(screen.getByLabelText("Copy TenkaCloudAccountId")).toBeInTheDocument();
    expect(screen.getByLabelText("Copy ExternalId")).toBeInTheDocument();
    expect(screen.getByLabelText("Copy RoleName")).toBeInTheDocument();
  });

  it("rotatedAt が 90 日以上前なら警告 badge を表示するべき", async () => {
    // 100 日前の rotatedAt
    const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    mocks.listCompetitorAccounts.mockResolvedValueOnce({
      items: [{ ...baseAccount, rotatedAt: longAgo }],
    });

    renderPage();
    await waitFor(() => expect(mocks.listCompetitorAccounts).toHaveBeenCalled());

    expect(await screen.findByText(/要 rotation/)).toBeInTheDocument();
  });
});
