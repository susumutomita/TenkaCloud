import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PortalAssumeRoleError,
  PortalAuthError,
  PortalValidationError,
} from "../../src/api/portal-client";
import type { AppConfig } from "../../src/config";

/**
 * SsoCredentialsPage の render 分岐 (error / loading / empty / AWS・非 AWS の provider 分岐
 * [#2233]) と AWS Console ワンクリック login (mock blocked / 成功 window.open / 各 error 種別
 * = auth_logout・assume_role・validation・generic Error・非 Error) を pin する。共有 hook と
 * getConsoleSigninUrl を mock し、 Portal*Error クラスと CliCredentialsPanel stub は実物/差し替え。
 */
const { mockAuth, mockTeamView, mockIsMock, mockSignin } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockTeamView: vi.fn(),
  mockIsMock: vi.fn(),
  mockSignin: vi.fn(),
}));

vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: mockTeamView }));
vi.mock("../../src/api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/portal-client")>();
  return { ...actual, getConsoleSigninUrl: mockSignin };
});
vi.mock("../../src/components/CliCredentialsPanel", () => ({
  CliCredentialsPanel: ({ jobId }: { jobId: string }) => <div data-testid={`cli-${jobId}`} />,
}));

const { SsoCredentialsPage } = await import("../../src/pages/SsoCredentials");

const config = {
  apiBaseUrl: "https://api.example.com",
  eventTitle: "Test event",
  eventRegion: "ap-northeast-1",
  mode: "backend",
  cloudMode: "real",
} as AppConfig;

const logout = vi.fn();
const auth = (sessionToken: string | null = "team-key") => ({
  session: sessionToken ? { sessionToken } : null,
  logout,
});

const problem = (over: Record<string, unknown> = {}) => ({
  jobId: "job-1",
  problemId: "hello-world",
  awsAccountId: "111122223333",
  region: "ap-northeast-1",
  ...over,
});

const renderPage = () => render(<SsoCredentialsPage config={config} />);

beforeEach(() => {
  mockAuth.mockReturnValue(auth());
  mockIsMock.mockReturnValue(false);
  mockTeamView.mockReturnValue({ view: undefined, error: undefined });
});

afterEach(() => vi.clearAllMocks());

describe("SsoCredentialsPage render branches", () => {
  it("should always show the how-to alert", () => {
    renderPage();
    expect(screen.getByText("sso_credentials.howto_body")).toBeInTheDocument();
  });

  it("should show a team-view error alert", () => {
    mockTeamView.mockReturnValue({ view: undefined, error: "boom" });
    renderPage();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("should show the loading box in backend mode but not in mock mode", () => {
    const a = renderPage();
    expect(a.getByText("app.loading")).toBeInTheDocument();
    a.unmount();

    mockIsMock.mockReturnValue(true);
    const b = renderPage();
    expect(b.queryByText("app.loading")).not.toBeInTheDocument();
  });

  it("should show the empty state when there are no problems", () => {
    mockTeamView.mockReturnValue({ view: { problems: [] }, error: undefined });
    renderPage();
    expect(screen.getByText("sso_credentials.empty_problems")).toBeInTheDocument();
  });

  it("should treat a legacy problem without provider as AWS", () => {
    // 旧 backend 応答 (provider 欠落) は行契約どおり aws 扱い — 表示・導線は従来どおり。
    mockTeamView.mockReturnValue({ view: { problems: [problem()] }, error: undefined });
    renderPage();
    expect(screen.getByText("hello-world")).toBeInTheDocument();
    expect(screen.getByText("111122223333")).toBeInTheDocument();
    expect(screen.getByText("sso_credentials.open_console_button")).toBeInTheDocument();
    expect(screen.getByTestId("cli-job-1")).toBeInTheDocument();
  });

  it("should render a non-AWS problem with its provider instead of dropping it", () => {
    // #2233: 非 AWS 問題は SSO ページから消さない。provider 名と説明を出し、
    // AWS Console ボタン / CLI panel は出さない (external-portal 導線は RC-32 第3弾)。
    mockTeamView.mockReturnValue({
      view: {
        problems: [problem({ jobId: "job-2", problemId: "sakura-quest", provider: "sakura" })],
      },
      error: undefined,
    });
    renderPage();
    expect(screen.getByText("sakura-quest")).toBeInTheDocument();
    expect(screen.getByText("Sakura Cloud")).toBeInTheDocument();
    expect(
      screen.getByText('sso_credentials.non_aws_body|{"provider":"Sakura Cloud"}'),
    ).toBeInTheDocument();
    expect(screen.queryByText("sso_credentials.open_console_button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cli-job-2")).not.toBeInTheDocument();
    // AWS アカウント行は非 AWS 問題では出さない (deploy request 由来の値で誤解を招くため)。
    expect(screen.queryByText("111122223333")).not.toBeInTheDocument();
  });

  it("should render mixed AWS and non-AWS problems side by side", () => {
    mockTeamView.mockReturnValue({
      view: {
        problems: [
          problem({ jobId: "job-1", problemId: "aws-quest", provider: "aws" }),
          problem({ jobId: "job-2", problemId: "gcp-quest", provider: "gcp" }),
        ],
      },
      error: undefined,
    });
    renderPage();
    expect(screen.getByText("aws-quest")).toBeInTheDocument();
    expect(screen.getByText("gcp-quest")).toBeInTheDocument();
    expect(screen.getByText("Google Cloud")).toBeInTheDocument();
    // Console ボタンと CLI panel は AWS 側だけ。
    expect(screen.getAllByText("sso_credentials.open_console_button")).toHaveLength(1);
    expect(screen.getByTestId("cli-job-1")).toBeInTheDocument();
    expect(screen.queryByTestId("cli-job-2")).not.toBeInTheDocument();
  });

  it("should render an unknown provider with its raw value", () => {
    // 未知 provider は raw 値 fallback (新 provider 追加時の安全側表示)。
    mockTeamView.mockReturnValue({
      view: {
        problems: [problem({ jobId: "job-9", problemId: "mystery", provider: "oraclecloud" })],
      },
      error: undefined,
    });
    renderPage();
    expect(screen.getByText("mystery")).toBeInTheDocument();
    expect(screen.getByText("oraclecloud")).toBeInTheDocument();
  });

  it("should link the external portal for a non-AWS problem with the capability", () => {
    // [#2235] backend が external-portal capability を配信したら、プラットフォーム定数の
    // プロバイダポータル URL への導線と手順を出す (宛先は participant 入力から供給しない)。
    mockTeamView.mockReturnValue({
      view: {
        problems: [
          problem({
            jobId: "job-2",
            problemId: "gcp-quest",
            provider: "gcp",
            accessCapabilities: ["external-portal"],
          }),
        ],
      },
      error: undefined,
    });
    renderPage();
    const link = screen.getByRole("link", {
      name: 'sso_credentials.external_portal_aria|{"problemId":"gcp-quest"}',
    });
    expect(link).toHaveAttribute("href", "https://console.cloud.google.com/");
    expect(
      screen.getByText('sso_credentials.external_portal_hint|{"provider":"Google Cloud"}'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('sso_credentials.non_aws_body|{"provider":"Google Cloud"}'),
    ).not.toBeInTheDocument();
  });

  it("should keep the host-guidance text when the capability is absent (older backend)", () => {
    // 旧 backend 応答 (accessCapabilities 不在) では導線を追加しない — 従来の案内文のまま。
    mockTeamView.mockReturnValue({
      view: {
        problems: [problem({ jobId: "job-2", problemId: "sakura-quest", provider: "sakura" })],
      },
      error: undefined,
    });
    renderPage();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.getByText('sso_credentials.non_aws_body|{"provider":"Sakura Cloud"}'),
    ).toBeInTheDocument();
  });

  it("should not link a portal for an unsupported provider", () => {
    // 未知 provider は capability=unsupported かつ定数マップ外 — 導線を出さない。
    mockTeamView.mockReturnValue({
      view: {
        problems: [
          problem({
            jobId: "job-9",
            problemId: "mystery",
            provider: "oraclecloud",
            accessCapabilities: ["unsupported"],
          }),
        ],
      },
      error: undefined,
    });
    renderPage();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.getByText('sso_credentials.non_aws_body|{"provider":"oraclecloud"}'),
    ).toBeInTheDocument();
  });

  it("should keep the AWS problem flow unchanged when capabilities are present", () => {
    mockTeamView.mockReturnValue({
      view: {
        problems: [
          problem({ provider: "aws", accessCapabilities: ["console", "cli-credentials"] }),
        ],
      },
      error: undefined,
    });
    renderPage();
    expect(screen.getByText("sso_credentials.open_console_button")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("should keep the page populated when the team has only non-AWS problems", () => {
    // 全問非 AWS でも空白ページにしない (以前は filter で全滅 → 空 state も出ない不具合形)。
    mockTeamView.mockReturnValue({
      view: {
        problems: [
          problem({ jobId: "job-2", problemId: "sakura-quest", provider: "sakura" }),
          problem({ jobId: "job-3", problemId: "azure-quest", provider: "azure" }),
        ],
      },
      error: undefined,
    });
    renderPage();
    expect(screen.getByText("sakura-quest")).toBeInTheDocument();
    expect(screen.getByText("azure-quest")).toBeInTheDocument();
    expect(screen.getByText("Azure")).toBeInTheDocument();
    expect(screen.queryByText("sso_credentials.empty_problems")).not.toBeInTheDocument();
  });

  it("should not render the CLI panel when there is no session token", () => {
    mockAuth.mockReturnValue(auth(null));
    mockTeamView.mockReturnValue({ view: { problems: [problem()] }, error: undefined });
    renderPage();
    expect(screen.queryByTestId("cli-job-1")).not.toBeInTheDocument();
  });
});

describe("SsoCredentialsPage open-console flow", () => {
  const oneProblem = { view: { problems: [problem()] }, error: undefined };
  const openButton = () =>
    screen.getByRole("button", {
      name: 'sso_credentials.open_console_aria|{"problemId":"hello-world"}',
    });

  it("should block opening the console in mock mode with an info alert", async () => {
    const user = userEvent.setup();
    mockIsMock.mockReturnValue(true);
    mockTeamView.mockReturnValue(oneProblem);
    renderPage();
    await user.click(openButton());
    expect(screen.getByText("sso_credentials.mock_open_blocked")).toBeInTheDocument();
    expect(screen.getByText("sso_credentials.mock_open_header")).toBeInTheDocument();
    expect(mockSignin).not.toHaveBeenCalled();
  });

  it("should open the federation URL in a new tab on success", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    mockSignin.mockResolvedValue("https://signin.aws.amazon.com/federation?Action=login");
    mockTeamView.mockReturnValue(oneProblem);
    renderPage();
    await user.click(openButton());
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        "https://signin.aws.amazon.com/federation?Action=login",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(mockSignin).toHaveBeenCalledWith("https://api.example.com", "team-key", "job-1");
    openSpy.mockRestore();
  });

  it("should log out on a PortalAuthError without showing an alert", async () => {
    const user = userEvent.setup();
    mockSignin.mockRejectedValue(new PortalAuthError());
    mockTeamView.mockReturnValue(oneProblem);
    renderPage();
    await user.click(openButton());
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(screen.queryByText("sso_credentials.open_failed_header")).not.toBeInTheDocument();
  });

  it("should show a stage-aware message on a PortalAssumeRoleError", async () => {
    const user = userEvent.setup();
    mockSignin.mockRejectedValue(new PortalAssumeRoleError("participant_viewer", "denied"));
    mockTeamView.mockReturnValue(oneProblem);
    renderPage();
    await user.click(openButton());
    expect(await screen.findByText(/sso_credentials\.cli\.assume_role_failed/)).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });

  it("should show a validation message on a PortalValidationError", async () => {
    const user = userEvent.setup();
    mockSignin.mockRejectedValue(new PortalValidationError("bad_input"));
    mockTeamView.mockReturnValue(oneProblem);
    renderPage();
    await user.click(openButton());
    expect(await screen.findByText(/sso_credentials\.validation_error/)).toBeInTheDocument();
  });

  it("should surface a generic error message and allow dismissing it", async () => {
    const user = userEvent.setup();
    mockSignin.mockRejectedValue(new Error("network down"));
    mockTeamView.mockReturnValue(oneProblem);
    renderPage();
    await user.click(openButton());
    expect(await screen.findByText("network down")).toBeInTheDocument();
    // dismissible Alert の閉じるボタンは aria-label を持たないので class で引く → onDismiss 発火。
    const dismiss = document.querySelector<HTMLButtonElement>('button[class*="dismiss-button"]');
    expect(dismiss).not.toBeNull();
    await user.click(dismiss as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByText("network down")).not.toBeInTheDocument());
  });

  it("should stringify a non-Error rejection", async () => {
    const user = userEvent.setup();
    mockSignin.mockRejectedValue("plain failure");
    mockTeamView.mockReturnValue(oneProblem);
    renderPage();
    await user.click(openButton());
    expect(await screen.findByText("plain failure")).toBeInTheDocument();
  });

  it("should ignore clicks while there is no session token", async () => {
    const user = userEvent.setup();
    mockAuth.mockReturnValue(auth(null));
    mockTeamView.mockReturnValue(oneProblem);
    renderPage();
    await user.click(openButton());
    expect(mockSignin).not.toHaveBeenCalled();
  });

  it("should mark the active problem loading and disable the others while opening", async () => {
    const user = userEvent.setup();
    let resolveSignin: (url: string) => void = () => undefined;
    mockSignin.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSignin = resolve;
      }),
    );
    mockTeamView.mockReturnValue({
      view: {
        problems: [
          problem({ jobId: "job-1", problemId: "p-a" }),
          problem({ jobId: "job-2", problemId: "p-b" }),
        ],
      },
      error: undefined,
    });
    renderPage();
    const buttonA = screen.getByRole("button", {
      name: 'sso_credentials.open_console_aria|{"problemId":"p-a"}',
    });
    const buttonB = screen.getByRole("button", {
      name: 'sso_credentials.open_console_aria|{"problemId":"p-b"}',
    });
    await user.click(buttonA);
    // pending="job-1" → 他の problem は disabled、 再 click しても二重起動しない。
    await waitFor(() => expect(buttonB).toBeDisabled());
    await user.click(buttonB);
    expect(mockSignin).toHaveBeenCalledTimes(1);
    resolveSignin("https://signin.example/x");
    await waitFor(() => expect(buttonB).toBeEnabled());
  });
});
