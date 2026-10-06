import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { LITE_DRILL_CHECKPOINTS } from "@tenkacloud/portal-contracts";
import { ApiError } from "@tenkacloud/web-kit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitorAccountSummary } from "../../src/api/competitor-accounts-client";
import type { AppConfig } from "../../src/config";
import type { ProblemSummary } from "../../src/data/problems";
import { hasLiteDrillCheckpointBeenShown } from "../../src/lib/lite-drill";
import { problemPicker } from "../utils/problem-picker";

/**
 * Issue #1241: EventCreatePage は section に分割済の orchestrator。 ここでは page の
 * handler / submit flow を real section 越しに統合テストする: teamCount 変更 → name 入力
 * → 問題選択 (onProblemsChange の meta defaultRegion/supportedRegions 分岐) → account 選択
 * (updateTeamRow) → submit (createEvent) → deploy 促し modal → deploy now (bulkDeploy+navigate)
 * / deploy later (navigate) / submit error / deploy error / cancel。
 * useApiClient / useCompetitorAccountsLoader / listProblemSummaries / createEvent /
 * bulkDeployEvent / useNavigate を mock、 filterVerifiedAccounts と helpers は実物。
 */
const {
  mockApiClient,
  mockNav,
  mockCreate,
  mockBulk,
  mockLoader,
  mockListProblems,
  fetchAccounts,
} = vi.hoisted(() => ({
  mockApiClient: vi.fn(),
  mockNav: vi.fn(),
  mockCreate: vi.fn(),
  mockBulk: vi.fn(),
  mockLoader: vi.fn(),
  mockListProblems: vi.fn(),
  fetchAccounts: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mockApiClient };
});
vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return { ...actual, createEvent: mockCreate, bulkDeployEvent: mockBulk };
});
vi.mock("../../src/data/problems", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/problems")>();
  // listProblemSummaries だけ差し替え、 isExecutableProblemRuntime (buildProblemOptions が使う) は実物。
  return { ...actual, listProblemSummaries: mockListProblems };
});
vi.mock("../../src/pages/event-create/useCompetitorAccountsLoader", () => ({
  useCompetitorAccountsLoader: mockLoader,
}));
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return { ...actual, useT: () => (k: string) => k, useI18n: () => ({ locale: "ja" }) };
});

const { EventCreatePage } = await import("../../src/pages/EventCreate");

const ACCOUNT_ID = "111111111111";
const account: CompetitorAccountSummary = {
  awsAccountId: ACCOUNT_ID,
  region: "ap-northeast-1",
  competitorRoleName: "Role",
  alias: "prod",
  verified: true,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
};
// #1910: 選択した問題に costEstimate があれば EventCreate が row へ引き継ぐ分岐 (truthy) を
// 踏むための fixture。 これを持つ p1 と、 持たない p2 の両方を選択して両分岐を pin する。
const costEstimate: ProblemSummary["costEstimate"] = {
  alwaysOnResources: [
    {
      logicalId: "Nat",
      resourceType: "AWS::EC2::NatGateway",
      riskLevel: "high",
    },
  ],
  unclassifiedResourceTypes: [],
  resourceTypes: ["AWS::EC2::NatGateway"],
};

const problem = (over: Partial<ProblemSummary> = {}): ProblemSummary =>
  ({
    id: "p1",
    name: "Problem 1",
    category: "Battle",
    status: "ready",
    shortDescription: "s",
    difficulty: 1,
    estimatedDuration: "30m",
    tags: [],
    defaultRegion: "us-east-1",
    supportedRegions: ["us-east-1", "ap-northeast-1"],
    runtime: { provider: "aws", engine: "cloudformation" },
    ...over,
  }) as ProblemSummary;

let config: AppConfig = { eventLimits: { maxTeams: 99, maxProblems: 50 } } as AppConfig;
const renderPage = () => render(<EventCreatePage config={config} />);
const w = (c: HTMLElement) => createWrapper(c);
// #1776: 問題チェック一覧の前に filter 用 Multiselect (difficulty / scoring kind / tags)
// が並ぶため、 data-testid で特定する。
const problemSelect = (c: HTMLElement) => problemPicker(c);

/** name 入力 + teamCount=1 + 問題 p1 選択 + account 選択 を行い、 submit 可能状態にする。 */
function fillValidForm(container: HTMLElement) {
  // findAllInputs: [name, teamCount, slug...]。 まず teamCount を 1 に。
  w(container).findAllInputs()[1]?.setInputValue("1");
  w(container).findAllInputs()[0]?.setInputValue("My Event");
  const ms = problemSelect(container);

  ms?.toggleProblem("p1");
  const accountSelect = w(container).findAllSelects()[0]; // TeamsSection の account Select
  accountSelect?.openDropdown();
  accountSelect?.selectOptionByValue(ACCOUNT_ID, { expandToViewport: true });
}

beforeEach(() => {
  config = { eventLimits: { maxTeams: 99, maxProblems: 50 } } as AppConfig;
  window.localStorage.clear();
  mockApiClient.mockReturnValue({ post: vi.fn() });
  mockNav.mockClear();
  mockCreate.mockReset().mockResolvedValue({
    eventId: "e1",
    teams: [{ teamId: "t1", internalSlug: "team-1", teamLoginKey: "ONE-TIME-KEY" }],
  });
  mockBulk.mockReset().mockResolvedValue({ ok: true });
  mockListProblems.mockReturnValue([
    problem({ costEstimate }), // p1: costEstimate あり → 引き継ぎ分岐 (truthy)
    problem({ id: "p2", name: "Problem 2", defaultRegion: undefined, supportedRegions: undefined }), // p2: なし (falsy)
  ]);
  mockLoader.mockReturnValue({
    competitorAccounts: [account],
    accountsLoadError: null,
    accountsLoading: false,
    fetchAccounts,
  });
  fetchAccounts.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("EventCreatePage flow", () => {
  it.each([undefined, "cloud-host"] as const)(
    "submits two teams in one separate competitor account with independent regions in mode %s",
    async (mode) => {
      config = {
        ...config,
        mode,
        hostAwsRegion: "ap-northeast-1",
        supportedProblemIds: ["p1"],
      };
      const { container } = renderPage();
      w(container).findAllInputs()[1]?.setInputValue("2");
      w(container).findAllInputs()[0]?.setInputValue("Shared account event");
      const selector = problemSelect(container);

      selector?.toggleProblem("p1");
      expect(screen.getByText("event_create.col_team_region")).toBeInTheDocument();
      for (const [index, region] of ["ap-northeast-1", "us-east-1"].entries()) {
        const selects = w(container).findAllSelects();
        selects[index * 2]?.openDropdown();
        selects[index * 2]?.selectOptionByValue(ACCOUNT_ID, { expandToViewport: true });
        selects[index * 2 + 1]?.openDropdown();
        selects[index * 2 + 1]?.selectOptionByValue(region, { expandToViewport: true });
      }
      expect(screen.getByRole("button", { name: "event_create.submit" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
      expect(mockCreate.mock.calls[0]?.[1].teams).toEqual([
        { internalSlug: "team-1", awsAccountId: ACCOUNT_ID, region: "ap-northeast-1" },
        { internalSlug: "team-2", awsAccountId: ACCOUNT_ID, region: "us-east-1" },
      ]);
    },
  );
  it.each([undefined, "cloud-host"] as const)(
    "shows only problems advertised by the execution catalog in mode %s",
    (mode) => {
      config = { ...config, mode, supportedProblemIds: ["p1"] };
      const { container } = renderPage();
      const select = problemSelect(container);

      expect(select?.findOptionByValue("p1")).not.toBeNull();
      expect(select?.findOptionByValue("p2")).toBeNull();
      select?.toggleProblem("p1");
      expect(
        problemSelect(container)
          ?.findTokens()
          .some((token) => token.getElement().textContent?.includes("Problem 1")),
      ).toBe(true);
    },
  );
  it.each([{ supportedProblemIds: undefined }, { supportedProblemIds: [] }])(
    "offers no cloud problem when its capability list is %s",
    ({ supportedProblemIds }) => {
      config = { ...config, mode: "cloud-host", supportedProblemIds };
      const { container } = renderPage();
      const select = problemSelect(container);

      expect(select?.findOptionByValue("p1")).toBeNull();
      expect(select?.findOptionByValue("p2")).toBeNull();
      expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "cloud-host"] as const)(
    "creates and initializes a native-only event without a competitor account in mode %s",
    async (mode) => {
      config = {
        ...config,
        mode,
        supportedProblemIds: ["p1", "p2"],
        nativeProblemIds: ["p1"],
      };
      mockLoader.mockReturnValue({
        competitorAccounts: [],
        accountsLoadError: null,
        accountsLoading: false,
        fetchAccounts,
      });
      const { container } = renderPage();
      w(container).findAllInputs()[1]?.setInputValue("1");
      w(container).findAllInputs()[0]?.setInputValue("Native event");
      const selector = problemSelect(container);

      selector?.toggleProblem("p1");
      expect(screen.getByText("event_create.teams_description_native")).toBeInTheDocument();
      expect(screen.queryByText("event_create.col_aws_account")).not.toBeInTheDocument();
      expect(screen.getByText("event_create.native_execution")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "event_create.submit" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0]?.[1].teams).toEqual([{ internalSlug: "team-1" }]);
      fireEvent.click(screen.getByTestId("deploy-prompt-now"));
      await waitFor(() => expect(mockBulk).toHaveBeenCalled());
    },
  );
  it.each([undefined, "cloud-host"] as const)(
    "requires a competitor account for mixed native and AWS problems in mode %s",
    async (mode) => {
      config = {
        ...config,
        mode,
        supportedProblemIds: ["p1", "p2"],
        nativeProblemIds: ["p1"],
      };
      const { container } = renderPage();
      w(container).findAllInputs()[1]?.setInputValue("1");
      w(container).findAllInputs()[0]?.setInputValue("Mixed event");
      const selector = problemSelect(container);

      selector?.toggleProblem("p1");
      selector?.toggleProblem("p2");
      expect(screen.getByText("event_create.col_aws_account")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
      const accountSelect = w(container).findAllSelects()[0];
      accountSelect?.openDropdown();
      accountSelect?.selectOptionByValue(ACCOUNT_ID, { expandToViewport: true });
      expect(screen.getByRole("button", { name: "event_create.submit" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
      expect(mockCreate.mock.calls[0]?.[1].teams).toEqual([
        { internalSlug: "team-1", awsAccountId: ACCOUNT_ID },
      ]);
    },
  );
  it("does not present competitor-account failures as blockers for a native-only event", () => {
    config = { ...config, supportedProblemIds: ["p1"], nativeProblemIds: ["p1"] };
    mockLoader.mockReturnValue({
      competitorAccounts: null,
      accountsLoadError: "accounts unavailable",
      accountsLoading: false,
      fetchAccounts,
    });
    const { container } = renderPage();
    w(container).findAllInputs()[0]?.setInputValue("Native event");
    const selector = problemSelect(container);

    selector?.toggleProblem("p1");
    expect(screen.queryByText("accounts unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeEnabled();
  });
  it("should create the event then bulk-deploy and navigate on 'deploy now'", async () => {
    const { container } = renderPage();
    fillValidForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    // deploy 促し modal の primary を押す。
    fireEvent.click(screen.getByTestId("deploy-prompt-now"));
    await waitFor(() =>
      expect(mockBulk).toHaveBeenCalledWith(expect.anything(), "e1", {}, expect.any(String)),
    );
    expect(mockNav).toHaveBeenCalledWith("/events/e1");
  });

  it("should mark the first-event-created drill checkpoint shown once revealed in Lite mode (#2696)", async () => {
    config = { tenantId: "local", eventLimits: { maxTeams: 99, maxProblems: 50 } } as AppConfig;
    const { container } = renderPage();
    fillValidForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(
      await screen.findByText(LITE_DRILL_CHECKPOINTS.firstEventCreated.code),
    ).toBeInTheDocument();
    expect(hasLiteDrillCheckpointBeenShown("firstEventCreated")).toBe(true);
  }, 15_000);

  it("should navigate without deploying on 'deploy later'", async () => {
    const { container } = renderPage();
    fillValidForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(screen.getByText("ONE-TIME-KEY")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "event_create.deploy_modal_later" }));
    expect(mockNav).toHaveBeenCalledWith("/events/e1");
    expect(mockBulk).not.toHaveBeenCalled();
  });

  it("should surface a create error and keep the form", async () => {
    mockCreate.mockRejectedValue(new Error("create boom"));
    const { container } = renderPage();
    fillValidForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    expect(await screen.findByText("create boom")).toBeInTheDocument();
  });

  it("should still navigate when bulk deploy fails after create", async () => {
    mockBulk.mockRejectedValue(new Error("deploy boom"));
    const { container } = renderPage();
    fillValidForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("deploy-prompt-now"));
    await waitFor(() => expect(mockNav).toHaveBeenCalledWith("/events/e1"));
  });

  it("keeps login keys visible and links to account setup after the hosting-account refusal", async () => {
    mockBulk.mockRejectedValue(
      new ApiError(
        422,
        JSON.stringify({
          error: "unsupported_hosting_account",
          awsAccountId: ACCOUNT_ID,
          message: "AWS resource exercises cannot target the platform hosting account.",
        }),
      ),
    );
    const { container } = renderPage();
    fillValidForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByTestId("deploy-prompt-now"));
    expect(
      await screen.findByText("event_create.hosting_account_rejected_body"),
    ).toBeInTheDocument();
    expect(screen.getByText("ONE-TIME-KEY")).toBeInTheDocument();
    expect(mockNav).not.toHaveBeenCalled();
    const setup = screen.getByRole("link", { name: "event_create.go_to_competitor_accounts" });
    expect(setup).toHaveAttribute("href", "/competitor-accounts");
    expect(setup).toHaveAttribute("target", "_blank");
    expect(screen.getByTestId("deploy-prompt-now")).toBeDisabled();
    fireEvent.click(screen.getByTestId("deploy-prompt-now"));
    expect(mockBulk).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "event_create.deploy_modal_later" }));
    expect(mockNav).toHaveBeenCalledWith("/events/e1");
  });

  it("should stringify a non-Error create rejection", async () => {
    mockCreate.mockRejectedValue("create string fail");
    const { container } = renderPage();
    fillValidForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    expect(await screen.findByText("create string fail")).toBeInTheDocument();
  });

  it("should stringify a non-Error bulk-deploy rejection and still navigate", async () => {
    mockBulk.mockRejectedValue("deploy string fail");
    const { container } = renderPage();
    fillValidForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("deploy-prompt-now"));
    await waitFor(() => expect(mockNav).toHaveBeenCalledWith("/events/e1"));
  });

  it("should keep the submit button disabled until the form is valid", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
  });

  it("should navigate to the event list on cancel", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "event_create.cancel" }));
    expect(mockNav).toHaveBeenCalledWith("/events");
  });

  it("should reuse existing rows when adding a problem and update one region among many", () => {
    const { container } = renderPage();
    // 1 team → selects: [account, category-filter, region-p1, region-p2]
    w(container).findAllInputs()[1]?.setInputValue("1");
    const ms = problemSelect(container);

    ms?.toggleProblem("p1"); // [p1]
    ms?.toggleProblem("p2"); // [p1, p2] → onProblemsChange の prev に p1 → existing 再利用経路
    expect(
      problemSelect(container)
        ?.findTokens()
        .some((token) => token.getElement().textContent?.includes("Problem 1")),
    ).toBe(true);
    expect(
      problemSelect(container)
        ?.findTokens()
        .some((token) => token.getElement().textContent?.includes("Problem 2")),
    ).toBe(true);
    // p1 の region Select だけ変更 → updateProblemRow の map で p1=match / p2=非match 両分岐。
    // [Issue #3173] Teams 表が account と region の 2 Select を持つようになったので、
    // 問題側の Select は「Teams 表のぶんを飛ばした先頭」= 全 team 分の後ろから数える。
    const teamSelectCount = w(container).findAllSelects().length - 2; // p1 / p2 の 2 件
    const regionP1 = w(container).findAllSelects()[teamSelectCount];
    regionP1?.openDropdown();
    regionP1?.selectOptionByValue("ap-northeast-1", { expandToViewport: true });
    expect(
      problemSelect(container)
        ?.findTokens()
        .some((token) => token.getElement().textContent?.includes("Problem 1")),
    ).toBe(true);
  });

  it("should fall back to the default region for a problem without metadata region", () => {
    const { container } = renderPage();
    const ms = problemSelect(container);

    ms?.toggleProblem("p2"); // defaultRegion / supportedRegions 未宣言 → fallback 分岐
    expect(
      problemSelect(container)
        ?.findTokens()
        .some((token) => token.getElement().textContent?.includes("Problem 2")),
    ).toBe(true);
  });

  it("should show the loading hint while accounts are still loading", () => {
    mockLoader.mockReturnValue({
      competitorAccounts: null,
      accountsLoadError: null,
      accountsLoading: true,
      fetchAccounts,
    });
    renderPage();
    expect(screen.getByText("event_create.accounts_loading_body")).toBeInTheDocument();
  });

  it("should reload accounts from the load-error alert", () => {
    mockLoader.mockReturnValue({
      competitorAccounts: null,
      accountsLoadError: "load boom",
      accountsLoading: false,
      fetchAccounts,
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "event_create.accounts_reload" }));
    expect(fetchAccounts).toHaveBeenCalled();
  });

  // --- canSubmit の各 operand を false にして submit が disabled になることを確認 ---
  it("should disable submit when the API client is unavailable", () => {
    mockApiClient.mockReturnValue(null);
    renderPage();
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
  });

  it("should disable submit for a read-only viewer even when the form is valid", () => {
    mockApiClient.mockReturnValue({
      post: vi.fn(),
      tenantAccess: { role: "viewer", canMutateTenant: false },
    });
    const { container } = renderPage();
    fillValidForm(container);
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("should disable submit when the team count is zero", () => {
    const { container } = renderPage();
    w(container).findAllInputs()[1]?.setInputValue("0"); // teamCount 0 → teamCountInvalid
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
  });

  it("should disable submit when the name exceeds the max length", () => {
    const { container } = renderPage();
    w(container).findAllInputs()[0]?.setInputValue("a".repeat(121)); // > NAME_MAX
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
  });

  it("should disable submit when no problems are selected", () => {
    const { container } = renderPage();
    w(container).findAllInputs()[1]?.setInputValue("1");
    w(container).findAllInputs()[0]?.setInputValue("My Event");
    const accountSelect = w(container).findAllSelects()[0];
    accountSelect?.openDropdown();
    accountSelect?.selectOptionByValue(ACCOUNT_ID, { expandToViewport: true });
    // 問題未選択 → problemRows 空 → disabled
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
  });

  it("should disable submit when a team has no valid account", () => {
    const { container } = renderPage();
    w(container).findAllInputs()[1]?.setInputValue("1");
    w(container).findAllInputs()[0]?.setInputValue("My Event");
    const ms = problemSelect(container);

    ms?.toggleProblem("p1");
    // account 未選択 → awsAccountId "" → allAccountsValid false → disabled
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
  });

  it("should disable submit when a team slug is invalid", () => {
    const { container } = renderPage();
    fillValidForm(container);
    // slug を不正値に上書き (findAllInputs: [name, teamCount, slug])。
    w(container).findAllInputs()[2]?.setInputValue("Invalid Slug!");
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
  });

  it("should disable submit when two teams share a slug", () => {
    const { container } = renderPage();
    w(container).findAllInputs()[1]?.setInputValue("2"); // 2 teams
    w(container).findAllInputs()[0]?.setInputValue("My Event");
    const ms = problemSelect(container);

    ms?.toggleProblem("p1");
    // 両 team に valid account を割り当て (allAccountsValid true にして hasDuplicateSlug まで到達)。
    // [Issue #3173] Each team row now renders account then region, so the
    // account selects are the even indices rather than the first two.
    const selects = w(container).findAllSelects();
    for (const s of [selects[0], selects[2]]) {
      s?.openDropdown();
      s?.selectOptionByValue(ACCOUNT_ID, { expandToViewport: true });
    }
    // team-2 の slug を team-1 に揃えて重複させる (slug input は [2], [3])。
    w(container).findAllInputs()[3]?.setInputValue("team-1");
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
  });
});

describe("EventCreatePage hosting-account confirmation", () => {
  const rejection = () =>
    new ApiError(
      422,
      JSON.stringify({
        error: "unsupported_hosting_account",
        awsAccountId: ACCOUNT_ID,
      }),
    );

  it("shows risk before keys, cancels without another request, and confirms the selected event", async () => {
    mockCreate.mockRejectedValueOnce(rejection());
    const { container } = renderPage();
    fillValidForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    expect(await screen.findByText("event_create.self_test_risk")).toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate.mock.calls[0]?.[1].hostingAccountSelfTest).toBeUndefined();
    expect(screen.queryByText("ONE-TIME-KEY")).not.toBeInTheDocument();
    createWrapper(document.body)
      .findModal('[data-testid="self-test-prompt"]')
      ?.findDismissButton()
      ?.click();
    await waitFor(() =>
      expect(screen.queryByText("event_create.self_test_risk")).not.toBeInTheDocument(),
    );
    expect(mockCreate).toHaveBeenCalledOnce();
    mockCreate.mockRejectedValueOnce(rejection());
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    fireEvent.click(await screen.findByRole("button", { name: "event_create.self_test_confirm" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(3));
    expect(mockCreate.mock.calls[2]?.[1]).toEqual({
      ...mockCreate.mock.calls[0]?.[1],
      hostingAccountSelfTest: {
        awsAccountId: ACCOUNT_ID,
        riskVersion: "hosting-account-self-test-v1",
      },
    });
    expect(await screen.findByText("ONE-TIME-KEY")).toBeInTheDocument();
  });

  it("handles an actual HTTP 422 and posts consent through the real API client", async () => {
    const { createCoreApiClient } = await import("@tenkacloud/web-kit");
    const realEvents = await vi.importActual<typeof import("../../src/api/events-client")>(
      "../../src/api/events-client",
    );
    const requests: { body: Record<string, unknown>; headers: Headers }[] = [];
    const fetchHttp = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/api/events");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body, headers: new Headers(init?.headers) });
      if (!body.hostingAccountSelfTest)
        return Response.json(
          {
            error: "unsupported_hosting_account",
            awsAccountId: ACCOUNT_ID,
            message:
              "Using the hosting AWS account requires explicit self-test risk acknowledgment before event creation.",
          },
          { status: 422 },
        );
      return Response.json({
        eventId: "e1",
        teams: [{ teamId: "t1", internalSlug: "team-1", teamLoginKey: "ONE-TIME-KEY" }],
      });
    });
    vi.stubGlobal("fetch", fetchHttp);
    try {
      config = { ...config, apiBaseUrl: "https://synthetic.invalid/api" };
      mockApiClient.mockReturnValue(createCoreApiClient(config.apiBaseUrl, "synthetic-id-token"));
      mockCreate.mockImplementation(realEvents.createEvent);
      const { container } = renderPage();
      fillValidForm(container);
      fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
      expect(await screen.findByText("event_create.self_test_risk")).toBeInTheDocument();
      expect(requests).toHaveLength(1);
      expect(screen.queryByText("ONE-TIME-KEY")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "event_create.self_test_confirm" }));
      expect(await screen.findByText("ONE-TIME-KEY")).toBeInTheDocument();
      expect(requests).toHaveLength(2);
      expect(requests[1]?.body.hostingAccountSelfTest).toEqual({
        awsAccountId: ACCOUNT_ID,
        riskVersion: "hosting-account-self-test-v1",
      });
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer synthetic-id-token");
      expect(requests[1]?.headers.get("Idempotency-Key")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains acknowledgment and operation key after a lost response; repeated confirmation sends once", async () => {
    mockCreate.mockRejectedValueOnce(rejection()).mockRejectedValueOnce(new Error("response lost"));
    const { container } = renderPage();
    fillValidForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    const confirm = await screen.findByRole("button", { name: "event_create.self_test_confirm" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await screen.findByText("response lost")).toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(3));
    expect(mockCreate.mock.calls[2]?.slice(1)).toEqual(mockCreate.mock.calls[1]?.slice(1));
  });
});
