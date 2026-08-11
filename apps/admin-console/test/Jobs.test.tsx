import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminInsightApiError } from "../src/api/admin-drill-down";
import type { AppConfig } from "../src/config";
import {
  colorFor,
  DeprovisioningJobsTab,
  formatElapsed,
  JobsPage,
  PipelineJobsTab,
  ProvisioningJobsTab,
} from "../src/pages/Jobs";

/**
 * Issue #1418: 未テストだった admin Provisioning Jobs page を 100% に引き上げる。
 * pure helper (colorFor / formatElapsed) を直接 unit-test し、 JobsPage と
 * DeprovisioningJobsTab は useAuth / admin-drill-down API / i18n を mock して render 分岐
 * (loading / not-configured / forbidden / error+dismiss / table) を網羅する。
 */
const { mockAuth, mockFetchPipeline, mockFetchSfn, mockFetchProvisioning } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFetchPipeline: vi.fn(),
  mockFetchSfn: vi.fn(),
  mockFetchProvisioning: vi.fn(),
}));

vi.mock("../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
// admin-drill-down は全 mock (importOriginal を使わない) → 実 module を読み込まず、本 test の
// coverage scope を Jobs.tsx に限定する。API client は専用 test で検証する。
// fake error class は Jobs.tsx の `err instanceof AdminInsightApiError` を満たす。
vi.mock("../src/api/admin-drill-down", () => {
  class AdminInsightApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(`AdminInsight API ${status}: ${message}`);
      this.name = "AdminInsightApiError";
    }
  }
  return {
    AdminInsightApiError,
    fetchPipelineExecutions: mockFetchPipeline,
    fetchStateMachineExecutions: mockFetchSfn,
    fetchProvisioningExecutions: mockFetchProvisioning,
  };
});
vi.mock("../src/i18n", () => {
  // 安定参照の t (毎 render で新関数を返すと columns useMemo の dep が変わり無限 render)。
  const stableT = (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key;
  const interpolate = (tmpl: string, vars: Readonly<Record<string, string>>) =>
    tmpl.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? vars[k] : ""));
  return { useT: () => stableT, interpolate };
});

const config = { awsRegion: "" } as AppConfig;
const loggedIn = { tokens: { idToken: "id-token" } };

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Jobs helpers", () => {
  it("should map known statuses to a color and fall back to grey", () => {
    expect(colorFor("Succeeded")).toBe("green");
    expect(colorFor("InProgress")).toBe("blue");
    expect(colorFor("WeirdUnknown")).toBe("grey");
  });

  it("should format elapsed time across hour / minute / second granularities", () => {
    expect(formatElapsed("2026-01-01T00:00:00Z", "2026-01-01T02:30:00Z")).toBe("2h 30m");
    expect(formatElapsed("2026-01-01T00:00:00Z", "2026-01-01T00:05:30Z")).toBe("5m 30s");
    expect(formatElapsed("2026-01-01T00:00:00Z", "2026-01-01T00:00:45Z")).toBe("45s");
  });

  it("should return em-dash for missing or unparseable start time", () => {
    expect(formatElapsed(undefined, undefined)).toBe("—");
    expect(formatElapsed("not-a-date", "2026-01-01T00:00:00Z")).toBe("—");
  });

  it("should use the current time when there is no end time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    expect(formatElapsed("2026-01-01T00:00:00Z", undefined)).toBe("10s");
  });
});

describe("PipelineJobsTab", () => {
  beforeEach(() => mockAuth.mockReturnValue(loggedIn));

  it("should show the loading spinner while no token / no data yet", () => {
    mockAuth.mockReturnValue({ tokens: undefined });
    render(<PipelineJobsTab config={config} />);
    expect(screen.getByText("jobs_page.loading")).toBeInTheDocument();
    expect(mockFetchPipeline).not.toHaveBeenCalled();
  });

  it("should render the not-configured alert when the API returns null", async () => {
    mockFetchPipeline.mockResolvedValue(null);
    render(<PipelineJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.not_configured_header")).toBeInTheDocument();
  });

  it("should render the forbidden alert on a 403 AdminInsightApiError", async () => {
    mockFetchPipeline.mockRejectedValue(new AdminInsightApiError(StatusCodes.FORBIDDEN, "denied"));
    render(<PipelineJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.forbidden_header")).toBeInTheDocument();
  });

  it("should show a dismissible error alert on a non-403 failure", async () => {
    mockFetchPipeline.mockRejectedValue(new Error("network down"));
    render(<PipelineJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.error_header")).toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();
    // error 状態では table data が無く、 alert の dismiss button が唯一の button。
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.queryByText("network down")).not.toBeInTheDocument());
  });

  it("should render the executions table with status badge and elapsed / em-dash cells", async () => {
    mockFetchPipeline.mockResolvedValue({
      pipelineName: "p",
      items: [
        {
          executionId: "exec-1234567890abc",
          status: "Succeeded",
          startTimeIso: "2026-01-01T00:00:00Z",
          lastUpdateTimeIso: "2026-01-01T00:01:00Z",
          consoleUrl: "https://console/exec1",
        },
        {
          executionId: "exec-pending",
          status: "Running",
          startTimeIso: undefined,
          lastUpdateTimeIso: undefined,
          consoleUrl: "https://console/exec2",
        },
      ],
    });
    render(<PipelineJobsTab config={config} />);
    expect(await screen.findByText(/exec-1234567/)).toBeInTheDocument();
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("should re-fetch on the 60s polling interval", async () => {
    vi.useFakeTimers();
    mockFetchPipeline.mockResolvedValue({ pipelineName: "p", items: [] });
    render(<PipelineJobsTab config={config} />);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFetchPipeline).toHaveBeenCalledTimes(2); // initial + 1 interval tick
  });
});

/**
 * Regression: the Provisioning tab used to render CodePipeline executions, so three tenants
 * provisioning concurrently produced an empty table while an unrelated pipeline failure showed
 * up as "provisioning failed". The tab must read the SBT provisioning state machine, and the
 * page must not collapse to a single pipeline-shaped view.
 */
describe("ProvisioningJobsTab", () => {
  beforeEach(() => mockAuth.mockReturnValue(loggedIn));

  it("should read the provisioning state machine, not the deploy pipeline", async () => {
    mockFetchProvisioning.mockResolvedValue({
      stateMachineArn: "arn:aws:states:ap-northeast-1:1:stateMachine:provisioningJobRunner",
      items: [
        {
          executionArn: "arn:aws:states:ap-northeast-1:1:execution:sm:abc",
          name: "tenant-basic",
          status: "SUCCEEDED",
          startTimeIso: "2026-08-08T05:03:01Z",
          stopTimeIso: "2026-08-08T05:06:01Z",
          consoleUrl: "https://console/exec",
        },
      ],
    });

    render(<ProvisioningJobsTab config={config} />);

    expect(await screen.findByText("tenant-basic")).toBeInTheDocument();
    expect(screen.getByText("SUCCEEDED")).toBeInTheDocument();
    expect(mockFetchProvisioning).toHaveBeenCalled();
    expect(mockFetchPipeline).not.toHaveBeenCalled();
  });

  it("should surface a 403 as forbidden rather than an empty table", async () => {
    mockFetchProvisioning.mockRejectedValue(
      new AdminInsightApiError(StatusCodes.FORBIDDEN, "denied"),
    );
    render(<ProvisioningJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.forbidden_header")).toBeInTheDocument();
  });

  it("should surface a non-403 failure instead of showing nothing", async () => {
    mockFetchProvisioning.mockRejectedValue(new Error("network down"));
    render(<ProvisioningJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.fetch_failed_header")).toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();
  });

  it("should fall back to the console link when the state machine is not configured", async () => {
    mockFetchProvisioning.mockResolvedValue(null);
    render(<ProvisioningJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.not_configured_header")).toBeInTheDocument();
  });

  it("should not fetch before a token is available", () => {
    mockAuth.mockReturnValue({ tokens: undefined });
    render(<ProvisioningJobsTab config={config} />);
    expect(mockFetchProvisioning).not.toHaveBeenCalled();
  });
});

describe("JobsPage", () => {
  beforeEach(() => mockAuth.mockReturnValue(loggedIn));

  // The pipeline being unavailable must not blank the whole page — that would hide the
  // provisioning tab, which is the one that shows real tenant activity.
  it("should keep showing the provisioning tab when the pipeline is not configured", async () => {
    mockFetchPipeline.mockResolvedValue(null);
    mockFetchProvisioning.mockResolvedValue({
      stateMachineArn: "arn:sm",
      items: [
        {
          executionArn: "arn:exec",
          name: "tenant-platinum",
          status: "RUNNING",
          startTimeIso: "2026-08-08T05:03:44Z",
          stopTimeIso: undefined,
          consoleUrl: "https://console/exec",
        },
      ],
    });

    render(<JobsPage config={config} />);

    expect(await screen.findByText("tenant-platinum")).toBeInTheDocument();
  });
});

describe("DeprovisioningJobsTab", () => {
  beforeEach(() => mockAuth.mockReturnValue(loggedIn));

  it("should return early and render nothing fetched when there is no token", () => {
    mockAuth.mockReturnValue({ tokens: undefined });
    render(<DeprovisioningJobsTab config={config} />);
    expect(mockFetchSfn).not.toHaveBeenCalled();
  });

  it("should render the phase-1 placeholder + console link when the API returns null", async () => {
    mockFetchSfn.mockResolvedValue(null);
    render(<DeprovisioningJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.deprovisioning_phase1_header")).toBeInTheDocument();
    expect(screen.getByText("jobs_page.deprovisioning_open_console")).toBeInTheDocument();
  });

  it("should render the forbidden alert on a 403", async () => {
    mockFetchSfn.mockRejectedValue(new AdminInsightApiError(StatusCodes.FORBIDDEN, "denied"));
    render(<DeprovisioningJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.forbidden_header")).toBeInTheDocument();
  });

  it("should render the fetch-failed alert on a non-403 failure", async () => {
    mockFetchSfn.mockRejectedValue(new Error("sfn boom"));
    render(<DeprovisioningJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.fetch_failed_header")).toBeInTheDocument();
    expect(screen.getByText("sfn boom")).toBeInTheDocument();
  });

  it("should treat a non-403 AdminInsightApiError as a fetch failure (not forbidden)", async () => {
    mockFetchSfn.mockRejectedValue(
      new AdminInsightApiError(StatusCodes.INTERNAL_SERVER_ERROR, "server error"),
    );
    render(<DeprovisioningJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.fetch_failed_header")).toBeInTheDocument();
    expect(screen.queryByText("jobs_page.forbidden_header")).not.toBeInTheDocument();
  });

  it("should render the executions table with rows (region from config)", async () => {
    mockFetchSfn.mockResolvedValue({
      kind: "ok",
      stateMachineArn: "arn:sfn",
      items: [
        {
          executionArn: "arn:exec1",
          name: "deprov-1",
          status: "Succeeded",
          startTimeIso: "2026-01-01T00:00:00Z",
          stopTimeIso: "2026-01-01T00:02:00Z",
          consoleUrl: "https://console/sfn1",
        },
        {
          executionArn: "arn:exec2",
          name: "deprov-2",
          status: "Failed",
          startTimeIso: undefined,
          stopTimeIso: undefined,
          consoleUrl: "https://console/sfn2",
        },
      ],
    });
    render(<DeprovisioningJobsTab config={{ awsRegion: "us-east-1" } as AppConfig} />);
    expect(await screen.findByText("deprov-1")).toBeInTheDocument();
    expect(screen.getByText("deprov-2")).toBeInTheDocument();
  });

  it("should render the empty state when there are no executions", async () => {
    mockFetchSfn.mockResolvedValue({ kind: "ok", stateMachineArn: "arn:sfn", items: [] });
    render(<DeprovisioningJobsTab config={config} />);
    expect(await screen.findByText("jobs_page.empty_deprovisioning")).toBeInTheDocument();
  });

  it("should re-fetch on the 60s polling interval", async () => {
    vi.useFakeTimers();
    mockFetchSfn.mockResolvedValue({ kind: "ok", stateMachineArn: "arn:sfn", items: [] });
    render(<DeprovisioningJobsTab config={config} />);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFetchSfn).toHaveBeenCalledTimes(2); // initial + 1 interval tick
  });
});
