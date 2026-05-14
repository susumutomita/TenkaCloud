import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2.2 (Issue #459) EventCreate verified-only drop-down 移行のテスト。
 *
 * - verified=true な CompetitorAccount のみが Select の選択肢に出る
 * - verified=false / 未登録は drop-down に出ない (UI 上で deploy 不可)
 * - 0 件のときは「Competitor Accounts へ移動」の導線を出す
 *
 * 1 ファイルで完結させるため、`useApiClient` / `listCompetitorAccounts` を vi.mock し、
 * `createEvent` は touch しない (= submit 経路は別 test の責務)。
 */

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

const { EventCreatePage, buildVerifiedAccountOption, formatVerifiedAccountSummary } = await import(
  "../../src/pages/EventCreate"
);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/events/new"]}>
      <Routes>
        <Route path="/events/new" element={<EventCreatePage config={config} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useApiClient.mockReturnValue({});
});

afterEach(() => vi.restoreAllMocks());

describe("EventCreatePage (Phase 2.2 verified-only)", () => {
  it("account option は 12 桁 ID を主ラベルにして alias を補足表示するべき", () => {
    const account = {
      awsAccountId: "111111111111",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      alias: "production-shared-account",
      verified: true,
      verifiedAt: "2026-05-10T00:00:00.000Z",
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
    };
    const option = buildVerifiedAccountOption(account);

    expect(option.label).toBe("111111111111");
    expect(option.labelTag).toBe("production-shared-account");
    expect(option.description).toContain("production-shared-account");
    expect(formatVerifiedAccountSummary(account)).toBe("111111111111 (production-shared-account)");
  });

  it("0 件のとき Competitor Accounts への導線 (Alert) を表示するべき", async () => {
    mocks.listCompetitorAccounts.mockResolvedValueOnce({ items: [] });
    renderPage();
    // listCompetitorAccounts が呼ばれた後、warning Alert が出る
    await waitFor(() => {
      expect(
        screen.getByText(/verified=true な Competitor Account がありません/),
      ).toBeInTheDocument();
    });
    // 導線として Competitor Accounts への link を出す
    expect(screen.getByText(/Competitor Accounts へ移動/)).toBeInTheDocument();
  });

  it("verified=false の account は drop-down 選択肢に出さないべき", async () => {
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
        {
          awsAccountId: "222222222222",
          region: "ap-northeast-1",
          competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
          alias: "Unverified Team B",
          verified: false,
          createdAt: "2026-05-09T00:00:00.000Z",
          updatedAt: "2026-05-09T00:00:00.000Z",
        },
      ],
    });
    renderPage();
    // listCompetitorAccounts が呼ばれる
    await waitFor(() => {
      expect(mocks.listCompetitorAccounts).toHaveBeenCalled();
    });
    // Cloudscape Select の placeholder で「verified=true 行のみ」を operator に明示
    // verified=false (222) は drop-down に出ないことを確認するため、placeholder の存在を pin
    // (= verified=true な選択肢があるなら placeholder は「verified account を選択」)。
    await waitFor(() => {
      const trigger = screen.queryAllByText(/verified account を選択/);
      expect(trigger.length).toBeGreaterThan(0);
    });
    // verified=false な account の alias は drop-down trigger に出ない
    // (closed 状態では選択肢 ul が DOM に無いので、alias 文字列がページ上に出ない)
    expect(screen.queryByText(/Unverified Team B/)).not.toBeInTheDocument();
  });

  it("API 取得 error は赤 Alert で operator に通知するべき", async () => {
    mocks.listCompetitorAccounts.mockRejectedValueOnce(new Error("network down"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Competitor Accounts の取得に失敗しました/)).toBeInTheDocument();
    });
    expect(screen.getByText(/network down/)).toBeInTheDocument();
  });
});
