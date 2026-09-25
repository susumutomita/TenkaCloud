import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";
import type { ProblemSummary } from "../../src/data/problems";

/**
 * Issue #3226: the normal event-creation page on the local competition host. The host's own
 * catalog decides which problems are selectable, no AWS account or competitor-account data is
 * requested, teams carry only their slug, and "Deploy now" prepares the local environments.
 */
const mocks = vi.hoisted(() => ({
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
  return { ...actual, useT: () => (key: string) => key };
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
  it("creates a slug-only event from a host-supported problem and deploys it", async () => {
    const { container } = render(<EventCreatePage config={config} />);
    expect(screen.getByText("local_host.create_header")).toBeInTheDocument();
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

  it("says so when the host catalog cannot be loaded", async () => {
    get.mockRejectedValue(new Error("host unreachable"));
    render(<EventCreatePage config={config} />);
    expect(await screen.findByText("local_host.catalog_error_header")).toBeInTheDocument();
    expect(screen.getByText(/host unreachable/u)).toBeInTheDocument();
  });
});
