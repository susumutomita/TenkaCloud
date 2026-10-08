import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../../src/config";
import { CloudConnectionModal } from "../../../src/pages/competitor-accounts/CloudConnectionModal";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  status: vi.fn(),
  revoke: vi.fn(),
  create: vi.fn(),
}));
vi.mock("../../../src/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../../src/api/client", async (original) => ({
  ...(await original<typeof import("../../../src/api/client")>()),
  useApiClient: () => ({
    cloudOrganizerRole: "TenantAdmin",
    tenantAccess: { canMutateTenant: true },
  }),
}));
vi.mock("../../../src/api/team-credentials-client", () => ({
  registerTeamCredential: mocks.register,
  getTeamCredentialStatus: mocks.status,
  revokeTeamCredential: mocks.revoke,
}));
vi.mock("../../../src/api/competitor-accounts-client", () => ({
  createCompetitorAccount: mocks.create,
}));
const config: AppConfig = {
  tenantId: "fixture",
  apiBaseUrl: "https://example.invalid",
  features: {
    nonAwsRuntime: true,
    samlSso: false,
    redTeam: false,
    challengePrerequisiteGate: false,
  },
  tenantName: "Fixture",
  cognitoDomain: "fixture.auth.example.invalid",
  cognitoClientId: "fixture",
  redirectUri: "https://example.invalid/callback",
  scope: "openid",
  isolation: "silo",
  samlIdpDirectory: {},
};
const choose = (name: string) =>
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const setup = (override: Partial<AppConfig> = {}) => {
  const onDismiss = vi.fn();
  const onSuccess = vi.fn();
  render(
    <CloudConnectionModal
      config={{ ...config, ...override }}
      onDismiss={onDismiss}
      onSuccess={onSuccess}
    />,
  );
  return { onDismiss, onSuccess };
};
const fill = (json = '{"dummy":"not-a-secret"}') => {
  fireEvent.change(screen.getByPlaceholderText("team-a"), { target: { value: "team-a" } });
  fireEvent.change(
    screen.getByRole("textbox", { name: /team_cloud_credentials.credential_label/ }),
    { target: { value: json } },
  );
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.register.mockResolvedValue({ registered: true });
  mocks.status.mockResolvedValue({ registered: true });
});

describe("common cloud connection entry", () => {
  it.each(["gcp", "azure", "sakura"] as const)(
    "routes %s to its own registration and storage status",
    async (provider) => {
      setup();
      expect(screen.getAllByRole("radio")).toHaveLength(4);
      expect(screen.getByRole("button", { name: "cloud_connections.continue" })).toBeDisabled();
      choose({ gcp: "Google Cloud", azure: "Azure", sakura: "cloud_connections.sakura" }[provider]);
      click("cloud_connections.continue");
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      expect(
        screen.getAllByText(`team_cloud_credentials.setup_help_${provider}`).length,
      ).toBeGreaterThan(0);
      fill();
      click("team_cloud_credentials.register_button");
      await screen.findByText("team_cloud_credentials.registered");
      expect(mocks.register).toHaveBeenCalledWith(expect.anything(), provider, "team-a", {
        dummy: "not-a-secret",
      });
      expect(
        screen.getByRole("textbox", { name: /team_cloud_credentials.credential_label/ }),
      ).toHaveValue("");
      click("team_cloud_credentials.status_button");
      await screen.findByText("team_cloud_credentials.status_registered");
      expect(mocks.status).toHaveBeenCalledWith(expect.anything(), provider, "team-a");
    },
  );
  it("preserves AWS setup and discards form state when returning to choose another cloud", () => {
    setup();
    choose("AWS");
    click("cloud_connections.continue");
    fireEvent.change(screen.getByPlaceholderText("123456789012"), {
      target: { value: "111122223333" },
    });
    click("cloud_connections.back");
    choose("Google Cloud");
    click("cloud_connections.continue");
    fill();
    click("cloud_connections.back");
    choose("Azure");
    click("cloud_connections.continue");
    expect(screen.getByPlaceholderText("team-a")).toHaveValue("");
    expect(
      screen.getByRole("textbox", { name: /team_cloud_credentials.credential_label/ }),
    ).toHaveValue("");
    expect(screen.queryByText("team_cloud_credentials.registered")).not.toBeInTheDocument();
    click("cloud_connections.back");
    choose("AWS");
    click("cloud_connections.continue");
    expect(screen.getByPlaceholderText("123456789012")).toHaveValue("");
  });
  it.each([
    { features: undefined },
    { mode: "local-host", features: config.features },
  ] as Partial<AppConfig>[])(
    "explains unavailable providers and cannot execute registration",
    (override) => {
      const { onDismiss } = setup(override);
      choose("Google Cloud");
      expect(screen.getByRole("button", { name: "cloud_connections.continue" })).toBeDisabled();
      expect(
        screen.getByText(
          override.mode === "local-host"
            ? "cloud_connections.local_unavailable"
            : "cloud_connections.feature_unavailable",
        ),
      ).toBeInTheDocument();
      expect(mocks.register).not.toHaveBeenCalled();
      click("competitor_accounts.add_modal_cancel");
      expect(onDismiss).toHaveBeenCalledOnce();
    },
  );
  it("shows API failure, retries, and clears the result when switching provider", async () => {
    mocks.register.mockRejectedValueOnce(new Error("fixture rejection"));
    setup();
    choose("Google Cloud");
    click("cloud_connections.continue");
    fill();
    click("team_cloud_credentials.register_button");
    await screen.findByText("fixture rejection");
    click("team_cloud_credentials.register_button");
    await screen.findByText("team_cloud_credentials.registered");
    expect(mocks.register).toHaveBeenCalledTimes(2);
    click("cloud_connections.back");
    choose("Azure");
    click("cloud_connections.continue");
    expect(screen.queryByText("team_cloud_credentials.registered")).not.toBeInTheDocument();
    expect(screen.queryByText("fixture rejection")).not.toBeInTheDocument();
    click("competitor_accounts.bulk_modal_close");
  });
  it("prevents switching or dismissing during an in-flight credential request", async () => {
    let resolve!: () => void;
    mocks.register.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    setup();
    choose("Azure");
    click("cloud_connections.continue");
    fill();
    click("team_cloud_credentials.register_button");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "cloud_connections.back" })).toBeDisabled(),
    );
    expect(
      screen.getByRole("button", { name: "competitor_accounts.bulk_modal_close" }),
    ).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(screen.getByPlaceholderText("team-a")).toBeInTheDocument();
    resolve();
    await screen.findByText("team_cloud_credentials.registered");
  });
});
