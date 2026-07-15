import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getDeployment: vi.fn(),
  getStackProgress: vi.fn(),
  deleteDeployment: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return {
    ...actual,
    useApiClient: mocks.useApiClient,
  };
});

vi.mock("../../src/api/deploy-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/deploy-client")>();
  return {
    ...actual,
    getDeployment: mocks.getDeployment,
    getStackProgress: mocks.getStackProgress,
    deleteDeployment: mocks.deleteDeployment,
  };
});

import type { DeploymentSummary, StackProgress } from "../../src/api/deploy-client";
import type { AppConfig } from "../../src/config";
import { I18nProvider } from "../../src/i18n";

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Test Tenant",
  apiBaseUrl: "https://api.example.com/prod",
  samlIdpDirectory: {},
};

const JOB_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";

const baseDeployment: DeploymentSummary = {
  jobId: JOB_ID,
  problemId: "hello-world-battle",
  tenantId: "tenant-test",
  awsAccountId: "111122223333",
  region: "ap-northeast-1",
  teamName: "team-alpha",
  displayTeamName: "Alpha Team",
  namePrefix: "tc-team-alpha",
  status: "PENDING",
  createdAt: "2026-05-11T01:08:58.000Z",
  updatedAt: "2026-05-11T01:09:30.000Z",
  expiresAt: 0,
};

const emptyProgress: StackProgress = {
  jobId: JOB_ID,
  stackName: "tc-team-alpha-stack",
  region: "ap-northeast-1",
  consoleUrl: "https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1",
  events: [],
  resources: [],
};

const { DeploymentDetailPage } = await import("../../src/pages/DeploymentDetail");

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[`/deployments/${JOB_ID}`]}>
        <Routes>
          <Route path="/deployments/:jobId" element={<DeploymentDetailPage config={config} />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useApiClient.mockReturnValue({});
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
});

afterEach(() => vi.restoreAllMocks());

describe("DeploymentDetailPage (Netlify-style phase + log view)", () => {
  it("should show all 5 phases as Complete (or Skipped) when deployment status=COMPLETE", async () => {
    mocks.getDeployment.mockResolvedValue({ ...baseDeployment, status: "COMPLETE" });
    mocks.getStackProgress.mockResolvedValue({
      ...emptyProgress,
      events: [
        {
          timestamp: "2026-05-11T01:09:00.000Z",
          logicalResourceId: "MyBucket",
          resourceType: "AWS::S3::Bucket",
          resourceStatus: "CREATE_COMPLETE",
        },
      ],
      resources: [
        {
          logicalResourceId: "MyBucket",
          resourceType: "AWS::S3::Bucket",
          resourceStatus: "CREATE_COMPLETE",
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(mocks.getDeployment).toHaveBeenCalled());
    await screen.findByTestId("phase-enqueued");

    // all 4 phases should be displayed (the legacy Health Check placeholder is gone)
    for (const id of ["enqueued", "building", "cfn-deploy", "complete"]) {
      expect(screen.getByTestId(`phase-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("phase-health-check")).toBeNull();

    // each phase should show Complete status
    const enqueued = within(screen.getByTestId("phase-enqueued"));
    expect(enqueued.getByText("Complete")).toBeInTheDocument();

    const building = within(screen.getByTestId("phase-building"));
    expect(building.getByText("Complete")).toBeInTheDocument();

    const cfn = within(screen.getByTestId("phase-cfn-deploy"));
    expect(cfn.getByText("Complete")).toBeInTheDocument();

    const completePhase = within(screen.getByTestId("phase-complete"));
    expect(completePhase.getByText("Complete")).toBeInTheDocument();
  });

  it("should show Building / CloudFormation Deploy phase as Failed when deployment status=FAILED", async () => {
    mocks.getDeployment.mockResolvedValue({
      ...baseDeployment,
      status: "FAILED",
      failureReason: "CodeBuild failed",
    });
    // 空 progress (= CFn 観測なし) → Building が Failed になる
    mocks.getStackProgress.mockResolvedValue(emptyProgress);
    renderPage();
    await waitFor(() => expect(mocks.getDeployment).toHaveBeenCalled());
    await screen.findByTestId("phase-building");

    const building = within(screen.getByTestId("phase-building"));
    expect(building.getByText("Failed")).toBeInTheDocument();

    // CFn 観測なし + status=FAILED → CFn phase は Pending
    const cfn = within(screen.getByTestId("phase-cfn-deploy"));
    expect(cfn.getByText("Pending")).toBeInTheDocument();

    // Top に failureReason の Alert (Complete phase の body にも出る可能性があるので getAllByText)
    expect(screen.getAllByText(/CodeBuild failed/).length).toBeGreaterThan(0);
  });

  it("should show the relevant phase as In Progress when deployment status=IN_PROGRESS", async () => {
    mocks.getDeployment.mockResolvedValue({ ...baseDeployment, status: "IN_PROGRESS" });
    mocks.getStackProgress.mockResolvedValue({
      ...emptyProgress,
      events: [
        {
          timestamp: "2026-05-11T01:09:00.000Z",
          logicalResourceId: "MyBucket",
          resourceType: "AWS::S3::Bucket",
          resourceStatus: "CREATE_IN_PROGRESS",
        },
      ],
    });
    renderPage();
    await screen.findByTestId("phase-cfn-deploy");

    const cfn = within(screen.getByTestId("phase-cfn-deploy"));
    expect(cfn.getByText("In Progress")).toBeInTheDocument();
  });

  it("should show CloudFormation Deploy phase as Pending when stackEvents is empty", async () => {
    mocks.getDeployment.mockResolvedValue({ ...baseDeployment, status: "IN_PROGRESS" });
    mocks.getStackProgress.mockResolvedValue(emptyProgress);
    renderPage();
    await screen.findByTestId("phase-cfn-deploy");
    const cfn = within(screen.getByTestId("phase-cfn-deploy"));
    expect(cfn.getByText("Pending")).toBeInTheDocument();
  });

  it("should show cause summary and remediation hint when stackProgress contains stuck diagnosis", async () => {
    mocks.getDeployment.mockResolvedValue({ ...baseDeployment, status: "IN_PROGRESS" });
    mocks.getStackProgress.mockResolvedValue({
      ...emptyProgress,
      stackStatus: "CREATE_IN_PROGRESS",
      stuck: {
        isStuck: true,
        elapsedMinutes: 45,
        observedAt: "2026-05-11T10:45:00.000Z",
        reason: "Resource handler returned message: service quota exceeded",
        remediationHint: "Request a service quota increase or delete unused resources, then retry.",
        resourceLogicalId: "WebServer",
        resourceType: "AWS::EC2::Instance",
        resourceStatus: "CREATE_IN_PROGRESS",
      },
      events: [
        {
          timestamp: "2026-05-11T10:00:00.000Z",
          logicalResourceId: "WebServer",
          resourceType: "AWS::EC2::Instance",
          resourceStatus: "CREATE_IN_PROGRESS",
          resourceStatusReason: "Resource handler returned message: service quota exceeded",
        },
      ],
    });
    renderPage();
    await screen.findByText(/CloudFormation Stack が停止している可能性があります/);

    expect(screen.getByText(/45 分/)).toBeInTheDocument();
    expect(screen.getAllByText(/service quota exceeded/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Request a service quota increase/)).toBeInTheDocument();
    expect(screen.getAllByText(/WebServer/).length).toBeGreaterThan(0);
  });

  it("should open modal and display terminal-style log when Maximize log button is pressed", async () => {
    mocks.getDeployment.mockResolvedValue({ ...baseDeployment, status: "IN_PROGRESS" });
    mocks.getStackProgress.mockResolvedValue({
      ...emptyProgress,
      events: [
        {
          timestamp: "2026-05-11T01:09:00.000Z",
          logicalResourceId: "MyBucket",
          resourceType: "AWS::S3::Bucket",
          resourceStatus: "CREATE_IN_PROGRESS",
        },
      ],
    });
    renderPage();
    await screen.findByTestId("maximize-log");

    fireEvent.click(screen.getByTestId("maximize-log"));

    const terminalLog = await screen.findByTestId("terminal-log");
    expect(terminalLog).toBeInTheDocument();
    // phase header 行が含まれる
    expect(within(terminalLog).getByText(/> Enqueued/)).toBeInTheDocument();
    expect(within(terminalLog).getByText(/> CloudFormation Deploy/)).toBeInTheDocument();
    // CFn event 行が含まれる
    expect(within(terminalLog).getByText(/CREATE_IN_PROGRESS MyBucket/)).toBeInTheDocument();
  });

  it("should show CloudFormation console link inside Building phase when consoleUrl is present", async () => {
    mocks.getDeployment.mockResolvedValue({ ...baseDeployment, status: "IN_PROGRESS" });
    mocks.getStackProgress.mockResolvedValue({
      ...emptyProgress,
      consoleUrl: "https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1",
    });
    renderPage();
    await screen.findByTestId("phase-building");

    // ExpandableSection の body は collapsed でも DOM には存在する (Cloudscape spec)。
    // Building phase body 内の link を text で拾う。
    expect(screen.getByText(/Open CloudFormation logs/)).toBeInTheDocument();
  });

  it("should show an invalid-job-id alert for a malformed jobId (no fetch)", () => {
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/deployments/bad"]}>
          <Routes>
            <Route path="/deployments/:jobId" element={<DeploymentDetailPage config={config} />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByText("不正な Job ID です。")).toBeInTheDocument();
    expect(mocks.getDeployment).not.toHaveBeenCalled();
  });

  it("should show a fetch-failed alert when loading the deployment errors", async () => {
    mocks.getDeployment.mockRejectedValue(new Error("fetch boom"));
    renderPage();
    expect(await screen.findByText("ジョブの取得に失敗しました")).toBeInTheDocument();
    expect(screen.getByText("fetch boom")).toBeInTheDocument();
  });

  it("should render failure-reason and CFn outputs without a legacy plaintext key", async () => {
    mocks.getDeployment.mockResolvedValue({
      ...baseDeployment,
      status: "FAILED",
      failureReason: "CFn rollback",
      teamLoginKey: "KEY-123",
      stackOutputs: JSON.stringify({ FrontendUrl: "https://app.example.com" }),
    } satisfies DeploymentSummary & { readonly teamLoginKey: string });
    mocks.getStackProgress.mockResolvedValue(emptyProgress);
    renderPage();
    expect(await screen.findByText("失敗理由")).toBeInTheDocument(); // failure_reason_header
    expect(screen.getAllByText("CFn rollback").length).toBeGreaterThan(0); // alert + guidance
    expect(screen.queryByText("KEY-123")).not.toBeInTheDocument();
    expect(screen.getByText("https://app.example.com")).toBeInTheDocument(); // CfnOutputsSection
  });

  it("should fall back to the internal team name in the header when displayTeamName is absent", async () => {
    mocks.getDeployment.mockResolvedValue({
      ...baseDeployment,
      displayTeamName: undefined,
      status: "COMPLETE",
    });
    mocks.getStackProgress.mockResolvedValue(emptyProgress);
    renderPage();
    // header description = problemId · (displayTeamName ?? teamName) · Job ... → teamName。
    expect(await screen.findByText(/· team-alpha · Job/)).toBeInTheDocument();
  });

  it("should render per-target rows for a composite (multi-cloud) deployment", async () => {
    mocks.getDeployment.mockResolvedValue({
      ...baseDeployment,
      status: "IN_PROGRESS",
      composite: {
        version: 1,
        targets: [
          {
            targetId: "edge",
            targetDeploymentId: "01HTARGETaws",
            ordinal: 0,
            provider: "aws",
            engine: "cloudformation",
            status: "COMPLETE",
            updatedAt: "2026-05-11T01:09:00.000Z",
          },
          {
            targetId: "store",
            targetDeploymentId: "01HTARGETazure",
            ordinal: 1,
            provider: "azure",
            engine: "bicep",
            status: "FAILED",
            updatedAt: "2026-05-11T01:09:10.000Z",
            failureReason: "quota exceeded",
          },
        ],
      },
    });
    mocks.getStackProgress.mockResolvedValue(emptyProgress);
    renderPage();
    // composite_targets_header (ja) — マルチクラウド target.
    expect(await screen.findByText("マルチクラウド target")).toBeInTheDocument();
    expect(screen.getByText("edge")).toBeInTheDocument();
    expect(screen.getByText("store")).toBeInTheDocument();
    expect(screen.getByText("aws")).toBeInTheDocument();
    expect(screen.getByText("azure")).toBeInTheDocument();
    expect(screen.getByText("quota exceeded")).toBeInTheDocument();
  });

  it("should not render the composite section for a legacy single-provider deployment", async () => {
    mocks.getDeployment.mockResolvedValue({ ...baseDeployment, status: "COMPLETE" });
    mocks.getStackProgress.mockResolvedValue(emptyProgress);
    renderPage();
    await waitFor(() => expect(mocks.getDeployment).toHaveBeenCalled());
    await screen.findByTestId("phase-enqueued");
    // Legacy detail keeps its exact shape: no composite section is ever mounted.
    expect(screen.queryByText("マルチクラウド target")).toBeNull();
  });

  it("should close the maximize-log modal on dismiss", async () => {
    mocks.getDeployment.mockResolvedValue({ ...baseDeployment, status: "IN_PROGRESS" });
    mocks.getStackProgress.mockResolvedValue(emptyProgress);
    renderPage();
    fireEvent.click(await screen.findByTestId("maximize-log"));
    await screen.findByTestId("terminal-log");
    // Modal の X (dismiss-control) → onDismiss → setLogModalOpen(false)。
    fireEvent.click(
      document.querySelector('button[class*="dismiss-control"]') as HTMLButtonElement,
    );
    // close 後も page 本体 (reload button) は残る。
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeInTheDocument();
  });
});
