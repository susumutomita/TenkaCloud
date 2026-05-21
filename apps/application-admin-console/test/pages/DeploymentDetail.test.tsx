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

    // all 5 phases should be displayed
    for (const id of ["enqueued", "building", "cfn-deploy", "health-check", "complete"]) {
      expect(screen.getByTestId(`phase-${id}`)).toBeInTheDocument();
    }

    // それぞれの phase に Complete または Skipped status が出る
    const enqueued = within(screen.getByTestId("phase-enqueued"));
    expect(enqueued.getByText("Complete")).toBeInTheDocument();

    const building = within(screen.getByTestId("phase-building"));
    expect(building.getByText("Complete")).toBeInTheDocument();

    const cfn = within(screen.getByTestId("phase-cfn-deploy"));
    expect(cfn.getByText("Complete")).toBeInTheDocument();

    const health = within(screen.getByTestId("phase-health-check"));
    expect(health.getByText("Skipped")).toBeInTheDocument();

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
    await screen.findByText(/CFn Stack が stuck の可能性があります/);

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

  it("should show CodeBuild console link inside Building phase when consoleUrl is present", async () => {
    mocks.getDeployment.mockResolvedValue({ ...baseDeployment, status: "IN_PROGRESS" });
    mocks.getStackProgress.mockResolvedValue({
      ...emptyProgress,
      consoleUrl: "https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1",
    });
    renderPage();
    await screen.findByTestId("phase-building");

    // ExpandableSection の body は collapsed でも DOM には存在する (Cloudscape spec)。
    // Building phase body 内の link を text で拾う。
    expect(screen.getByText(/Open CodeBuild \/ CloudFormation logs/)).toBeInTheDocument();
  });
});
