import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";
import type { ProblemSummary } from "../../src/data/problems";

/**
 * Issue #3226: the normal event-creation page on the local competition host. The host's own
 * catalog decides which problems are selectable, no AWS account or competitor-account data is
 * requested, teams carry only their slug, and preparation leaves Docker environments stopped.
 */
const mocks = vi.hoisted(() => ({
  locale: "ja" as "ja" | "en",
  useApiClient: vi.fn(),
  navigate: vi.fn(),
  createEvent: vi.fn(),
  bulkDeployEvent: vi.fn(),
  listProblemSummaries: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mocks.useApiClient };
});
vi.mock("react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return {
    ...actual,
    createEvent: mocks.createEvent,
    bulkDeployEvent: mocks.bulkDeployEvent,
  };
});
vi.mock("../../src/data/problems", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/problems")>();
  return { ...actual, listProblemSummaries: mocks.listProblemSummaries };
});
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return { ...actual, useT: () => (key: string) => key, useI18n: () => ({ locale: mocks.locale }) };
});

const { EventCreatePage } = await import("../../src/pages/EventCreate");

const config: AppConfig = {
  cognitoDomain: "http://127.0.0.1:5174/api/host",
  cognitoClientId: "local-host",
  redirectUri: "http://127.0.0.1:5174/callback",
  scope: "",
  tenantId: "local-host",
  tenantName: "Local competition",
  apiBaseUrl: "http://127.0.0.1:5174/api",
  samlIdpDirectory: {},
  participantPortalUrl: "http://127.0.0.1:5175",
  mode: "local-host",
};

function problem(id: string, provider: string, engine: string): ProblemSummary {
  return {
    id,
    name: id,
    category: "Challenge",
    status: "ready",
    shortDescription: id,
    difficulty: 1,
    estimatedDuration: "30m",
    tags: [],
    runtime: { provider, engine },
  };
}

const get = vi.fn();
beforeEach(() => {
  mocks.locale = "ja";
  get.mockReset().mockResolvedValue({ items: [{ problemId: "sqli-demo" }] });
  mocks.useApiClient.mockReturnValue({ get, post: vi.fn(), tenantAccess: undefined });
  mocks.createEvent.mockResolvedValue({
    eventId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
    teams: [{ teamId: "t1", internalSlug: "team-1", teamLoginKey: "KEY" }],
  });
  mocks.bulkDeployEvent.mockResolvedValue({ enqueued: 1, skipped: 0 });
  mocks.listProblemSummaries.mockReturnValue([
    problem("sqli-demo", "docker", "compose"),
    problem("cloud-only", "aws", "cloudformation"),
  ]);
});
afterEach(() => vi.clearAllMocks());

const multiselect = (container: HTMLElement) =>
  createWrapper(container).findMultiselect('[data-testid="problem-select"]');

describe("EventCreatePage on the local competition host", () => {
  it.each(["local-host", "cloud-host"] as const)(
    "updates selected text in %s while retaining filtered selections and regions",
    async (mode) => {
      const translated = {
        ...problem("cloud-only", "aws", "cloudformation"),
        name: "日本語の問題",
        shortDescription: "日本語の説明",
        i18n: { en: { name: "English problem", shortDescription: "English description" } },
      };
      mocks.listProblemSummaries.mockReturnValue([translated]);
      get.mockResolvedValue({ items: [{ problemId: "cloud-only" }] });
      const pageConfig = { ...config, mode, supportedProblemIds: ["cloud-only"] };
      const { container, rerender } = render(<EventCreatePage config={pageConfig} />);
      if (mode === "local-host")
        await waitFor(() => expect(get).toHaveBeenCalledWith("host/catalog"));
      const picker = multiselect(container);
      picker?.openDropdown();
      picker?.selectOptionByValue("cloud-only");
      picker?.closeDropdown();
      const selection = () => picker?.findTokens()[0]?.getElement().textContent;
      expect(selection()).toContain("日本語の問題");
      const region = createWrapper(container).findAllSelects().at(-1);
      if (mode === "cloud-host") {
        region?.openDropdown();
        region?.selectOptionByValue("us-east-1", { expandToViewport: true });
        expect(region?.findTrigger().getElement().textContent).toContain("us-east-1");
      }
      createWrapper(container)
        .findInput('[data-testid="problem-filter-search"]')
        ?.setInputValue("no match");
      mocks.locale = "en";
      rerender(<EventCreatePage config={pageConfig} />);
      expect(selection()).toContain("English problem");
      expect(selection()).toContain("English description");
      expect(selection()).not.toContain("日本語の問題");
      if (mode === "cloud-host") {
        expect(region?.findTrigger().getElement().textContent).toContain("us-east-1");
        expect(createWrapper(container).findAllTables().at(-1)?.getElement().textContent).toContain(
          "English problem",
        );
      }
      mocks.locale = "ja";
      rerender(<EventCreatePage config={pageConfig} />);
      expect(selection()).toContain("日本語の問題");
      expect(picker?.findTokens()).toHaveLength(1);
    },
  );

  it("creates a slug-only event from a host-supported problem and deploys it", async () => {
    const { container } = render(<EventCreatePage config={config} />);
    expect(screen.queryByText("local_host.create_header")).toBeNull();
    expect(screen.queryByText("local_host.create_body")).toBeNull();
    await waitFor(() => expect(get).toHaveBeenCalledWith("host/catalog"));
    // No AWS competitor accounts are requested on the local host.
    expect(get).not.toHaveBeenCalledWith("admin/competitor-accounts");
    expect(screen.queryByText("event_create.col_aws_account")).toBeNull();
    const wrapper = createWrapper(container);
    wrapper.findAllInputs()[1]?.setInputValue("1");
    wrapper.findAllInputs()[0]?.setInputValue("Local Cup");
    const picker = multiselect(container);
    picker?.openDropdown();
    await waitFor(() => {
      const options = picker?.findDropdown().findOptions() ?? [];
      const unsupported = options.find((option) =>
        option.getElement().textContent?.includes("cloud-only"),
      );
      expect(unsupported?.getElement().textContent).toContain("local_host.problem_unsupported_tag");
    });
    picker?.selectOptionByValue("sqli-demo");
    // No region or cloud cost columns for a local environment.
    expect(screen.queryByText("event_create.col_region")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mocks.createEvent).toHaveBeenCalled());
    expect(mocks.createEvent.mock.calls[0]?.[1].teams).toEqual([{ internalSlug: "team-1" }]);
    fireEvent.click(await screen.findByTestId("deploy-prompt-now"));
    await waitFor(() => expect(mocks.bulkDeployEvent).toHaveBeenCalled());
    expect(mocks.navigate).toHaveBeenCalledWith("/events/01HZX0K3M3K9ZQHB3MRQHBA1B2");
  });

  it("keeps the explicit legacy adapter fixture separate from production local startup", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "host/catalog")
        return { items: [{ problemId: "cloud-only", runtime: "cloudformation" }] };
      if (path === "admin/competitor-accounts")
        return {
          items: [
            {
              awsAccountId: "111111111111",
              region: "ap-northeast-1",
              competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
              verified: true,
              createdAt: "2026-09-30T00:00:00.000Z",
              updatedAt: "2026-09-30T00:00:00.000Z",
            },
          ],
        };
      throw new Error(`Unexpected host API path: ${path}`);
    });
    const { container } = render(
      <EventCreatePage config={{ ...config, hostAwsRegion: "ap-northeast-1" }} />,
    );
    await waitFor(() => expect(get).toHaveBeenCalledWith("admin/competitor-accounts"));
    const wrapper = createWrapper(container);
    wrapper.findAllInputs()[1]?.setInputValue("1");
    wrapper.findAllInputs()[0]?.setInputValue("Cloud Cup");
    const picker = multiselect(container);
    picker?.openDropdown();
    picker?.selectOptionByValue("cloud-only");
    await waitFor(() =>
      expect(screen.getByText("event_create.col_aws_account")).toBeInTheDocument(),
    );
    expect(screen.getByText("event_create.col_team_region")).toBeInTheDocument();
    const accountSelect = wrapper.findAllSelects()[0];
    accountSelect?.openDropdown();
    await waitFor(() =>
      expect(
        accountSelect
          ?.findDropdown({ expandToViewport: true })
          .findOptions()
          .some((option) => option.getElement().textContent?.includes("111111111111")),
      ).toBe(true),
    );
    accountSelect?.selectOptionByValue("111111111111", { expandToViewport: true });
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mocks.createEvent).toHaveBeenCalledTimes(1));
    const request = mocks.createEvent.mock.calls[0]?.[1];
    expect(request.teams).toEqual([{ internalSlug: "team-1", awsAccountId: "111111111111" }]);
    expect(request.problems).toEqual([
      { problemId: "cloud-only", defaultRegion: "ap-northeast-1" },
    ]);
  });

  it.each([
    { maxTeams: 40, maxEventJobs: 512, teams: 5, problems: 20 },
    { maxTeams: 40, maxEventJobs: 99, teams: 5, problems: 19 },
    { maxTeams: 4, maxEventJobs: 512, teams: 4, problems: 20 },
  ])(
    "bounds a requested 5-team × 20-problem event before submission: %j",
    async (limits) => {
      const problems = Array.from({ length: 20 }, (_, i) =>
        problem(`exercise-${i}`, "docker", "compose"),
      );
      mocks.listProblemSummaries.mockReturnValue(problems);
      get.mockResolvedValue({
        limits: { maxTeams: limits.maxTeams, maxEventJobs: limits.maxEventJobs },
        items: problems.map((item) => ({ problemId: item.id, runtime: "docker" })),
      });
      const { container } = render(<EventCreatePage config={config} />);
      await waitFor(() => expect(get).toHaveBeenCalledWith("host/catalog"));
      const wrapper = createWrapper(container);
      wrapper.findAllInputs()[0]?.setInputValue("100 entries");
      wrapper.findAllInputs()[1]?.setInputValue("5");
      const picker = multiselect(container);
      picker?.openDropdown();
      await waitFor(() => expect(picker?.findDropdown().findOptions()).toHaveLength(20));
      for (const item of problems) picker?.selectOptionByValue(item.id);
      const submit = screen.getByRole("button", { name: "event_create.submit" });
      expect(submit).toBeEnabled();
      expect(wrapper.findAllInputs()[1]?.findNativeInput().getElement()).toHaveValue(limits.teams);
      expect(screen.queryByText("local_host.job_count_invalid")).toBeNull();
      fireEvent.click(submit);
      await waitFor(() => expect(mocks.createEvent).toHaveBeenCalledTimes(1));
      const body = mocks.createEvent.mock.calls[0]?.[1];
      expect(body.teams).toHaveLength(limits.teams);
      expect(body.problems).toHaveLength(limits.problems);
      // Twenty real Cloudscape selection/rerender cycles exceed the default five seconds
      // under CI coverage instrumentation. Keep every capacity assertion and bound this
      // full-size interaction separately; this is not a production latency threshold.
    },
    20_000,
  );

  it("reopens capacity after deselection and limits team increases without dropping selected problems", async () => {
    const problems = [
      problem("first", "docker", "compose"),
      problem("second", "docker", "compose"),
      problem("third", "docker", "compose"),
    ];
    mocks.listProblemSummaries.mockReturnValue(problems);
    get.mockResolvedValue({
      limits: { maxTeams: 40, maxEventJobs: 6 },
      items: problems.map((item) => ({ problemId: item.id, runtime: "docker" })),
    });
    const { container } = render(<EventCreatePage config={config} />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("host/catalog"));
    const wrapper = createWrapper(container);
    const picker = multiselect(container);
    picker?.openDropdown();
    picker?.selectOptionByValue("first");
    picker?.selectOptionByValue("second");
    const third = () =>
      picker
        ?.findDropdown()
        .findOptions()
        .find((option) => option.getElement().textContent?.includes("third"));
    expect(third()?.isDisabled()).toBe(true);
    wrapper.findAllInputs()[1]?.setInputValue("40");
    expect(wrapper.findAllInputs()[1]?.findNativeInput().getElement()).toHaveValue(3);
    picker?.selectOptionByValue("second");
    expect(third()?.isDisabled()).toBe(false);
    picker?.selectOptionByValue("third");
    wrapper.findAllInputs()[0]?.setInputValue("Bounded selection");
    fireEvent.click(screen.getByRole("button", { name: "event_create.submit" }));
    await waitFor(() => expect(mocks.createEvent).toHaveBeenCalledTimes(1));
    expect(
      mocks.createEvent.mock.calls[0]?.[1].problems.map(
        (item: { problemId: string }) => item.problemId,
      ),
    ).toEqual(["first", "third"]);
  });

  it("says so when the host catalog cannot be loaded", async () => {
    get.mockRejectedValue(new Error("host unreachable"));
    render(<EventCreatePage config={config} />);
    expect(await screen.findByText("local_host.catalog_error_header")).toBeInTheDocument();
    expect(screen.getByText(/host unreachable/u)).toBeInTheDocument();
  });
});
