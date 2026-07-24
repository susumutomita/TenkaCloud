import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitorAccountSummary } from "../../src/api/competitor-accounts-client";
import type { AppConfig } from "../../src/config";
import type { ProblemSummary } from "../../src/data/problems";

/**
 * #2563 v1, tightened by #2757: 非 AWS single-provider event の EventCreate flow。
 * sakura/apprun (executable な reserved provider) 問題のみ選択で credential 列に
 * 切替わり、 submit payload は awsAccountId ではなく nonAwsCredentialTeamSlug を
 * 運ぶ。 deploy 促し modal は bulk 非対応 (deploy-now 無し)。 AWS + 非 AWS の混在は
 * mixed error + submit 不可。 mock 構成は EventCreate.flow と同一。
 *
 * #2757 で picker の選択可否は `capability.executable` 基準に変わったため、 元々
 * gcp/infra-manager (adapter-wired preview, executable: false) を使っていたこの
 * flow test は sakura/apprun (executable: true) に差し替えた。
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
  return { ...actual, listProblemSummaries: mockListProblems };
});
vi.mock("../../src/pages/event-create/useCompetitorAccountsLoader", () => ({
  useCompetitorAccountsLoader: mockLoader,
}));
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return { ...actual, useT: () => (k: string) => k };
});

const { EventCreatePage } = await import("../../src/pages/EventCreate");

const account: CompetitorAccountSummary = {
  awsAccountId: "111111111111",
  region: "ap-northeast-1",
  competitorRoleName: "Role",
  alias: "prod",
  verified: true,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
};

const problem = (over: Partial<ProblemSummary> = {}): ProblemSummary =>
  ({
    id: "ps1",
    name: "Sakura Problem",
    category: "Challenge",
    status: "ready",
    shortDescription: "s",
    difficulty: 1,
    estimatedDuration: "30m",
    tags: [],
    defaultRegion: "us-east-1",
    supportedRegions: ["us-east-1", "ap-northeast-1"],
    runtime: { provider: "sakura", engine: "apprun" },
    ...over,
  }) as ProblemSummary;

// #2167: 非 AWS 問題は features.nonAwsRuntime ON のときだけ picker で選択可能。
const config = { features: { nonAwsRuntime: true } } as AppConfig;
const renderPage = () => render(<EventCreatePage config={config} />);
const w = (c: HTMLElement) => createWrapper(c);
const problemSelect = (c: HTMLElement) => w(c).findMultiselect('[data-testid="problem-select"]');

/** name 入力 + teamCount=1 + sakura 問題 ps1 選択 (credential slug は default team-1 のまま)。 */
function fillNonAwsForm(container: HTMLElement) {
  w(container).findAllInputs()[1]?.setInputValue("1");
  w(container).findAllInputs()[0]?.setInputValue("Sakura Event");
  const ms = problemSelect(container);
  ms?.openDropdown();
  ms?.selectOptionByValue("ps1");
}

beforeEach(() => {
  mockApiClient.mockReturnValue({ post: vi.fn() });
  mockNav.mockClear();
  mockCreate.mockReset().mockResolvedValue({ eventId: "e9" });
  mockBulk.mockReset().mockResolvedValue({ ok: true });
  mockListProblems.mockReturnValue([
    problem(),
    problem({
      id: "pa1",
      name: "AWS Problem",
      runtime: { provider: "aws", engine: "cloudformation" },
    }),
    problem({
      id: "pcm1",
      name: "Composite Problem",
      runtime: {
        kind: "composite",
        // #2757: every target must be executable for the composite option itself to
        // be selectable; gcp/infra-manager and azure/bicep are adapter-wired previews
        // (executable: false), so only aws + sakura keep this composite selectable.
        targets: [
          { id: "aws", provider: "aws", engine: "cloudformation" },
          { id: "sakura", provider: "sakura", engine: "apprun" },
        ],
      },
    }),
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

describe("EventCreatePage non-AWS flow (#2563)", () => {
  it("should submit nonAwsCredentialTeamSlug instead of awsAccountId for a sakura-only event", async () => {
    const { container } = renderPage();
    fillNonAwsForm(container);
    // 非 AWS mode: credential 列が出て AWS account Select は無い。
    expect(screen.getByText("event_create.col_non_aws_credential")).toBeInTheDocument();
    expect(screen.queryByText("event_create.col_aws_account")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const request = mockCreate.mock.calls[0]?.[1];
    expect(request.teams).toEqual([{ internalSlug: "team-1", nonAwsCredentialTeamSlug: "team-1" }]);
  });

  it("should offer only 'later' in the deploy prompt (bulk unsupported for non-AWS)", async () => {
    const { container } = renderPage();
    fillNonAwsForm(container);
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(screen.queryByTestId("deploy-prompt-now")).not.toBeInTheDocument();
    expect(screen.getByText("event_create.deploy_modal_alert_body_non_aws")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "event_create.deploy_modal_later" }));
    expect(mockNav).toHaveBeenCalledWith("/events/e9");
    expect(mockBulk).not.toHaveBeenCalled();
  });

  it("should block submit and show the mixed error when AWS and non-AWS problems are combined", () => {
    const { container } = renderPage();
    fillNonAwsForm(container);
    // Multiselect は選択後も dropdown が開いたまま (fillNonAwsForm の続き) なので再 open しない。
    const ms = problemSelect(container);
    ms?.selectOptionByValue("pa1");
    expect(screen.getByText("event_create.mixed_provider_error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "event_create.submit" })).toBeDisabled();
  });

  it("should submit both AWS and non-AWS bindings for a composite event", async () => {
    const { container } = renderPage();
    w(container).findAllInputs()[1]?.setInputValue("1");
    w(container).findAllInputs()[0]?.setInputValue("Composite Event");
    const ms = problemSelect(container);
    ms?.openDropdown();
    ms?.selectOptionByValue("pcm1");

    expect(screen.getByText("event_create.col_aws_account")).toBeInTheDocument();
    // Composite targets are aws + sakura only (#2757: gcp/azure stay non-selectable
    // adapter-wired previews), so exactly one non-AWS credential column renders.
    expect(screen.getAllByText("event_create.col_non_aws_credential")).toHaveLength(1);
    const accountSelect = w(container).findAllSelects()[0];
    accountSelect?.openDropdown();
    accountSelect?.selectOptionByValue(account.awsAccountId, { expandToViewport: true });

    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0]?.[1].teams).toEqual([
      {
        internalSlug: "team-1",
        awsAccountId: account.awsAccountId,
        nonAwsCredentialTeamSlug: "team-1",
      },
    ]);
    expect(screen.queryByTestId("deploy-prompt-now")).not.toBeInTheDocument();
  });
});
