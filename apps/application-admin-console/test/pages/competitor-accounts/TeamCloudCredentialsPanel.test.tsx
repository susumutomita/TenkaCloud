import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../../src/config";

/**
 * TeamCloudCredentialsPanel の provider Select / teamSlug / credential JSON /
 * register (valid→success / invalid JSON→error / API error) / revoke / status (registered/unregistered) /
 * slug invalid disable / apiClient null disable / notice dismiss を網羅する。
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    useApiClient: vi.fn(),
    registerTeamCredential: vi.fn(),
    revokeTeamCredential: vi.fn(),
    getTeamCredentialStatus: vi.fn(),
  },
}));

vi.mock("../../../src/api/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useApiClient: mocks.useApiClient,
}));
vi.mock("../../../src/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../../src/api/team-credentials-client", () => ({
  registerTeamCredential: mocks.registerTeamCredential,
  revokeTeamCredential: mocks.revokeTeamCredential,
  getTeamCredentialStatus: mocks.getTeamCredentialStatus,
}));

const { TeamCloudCredentialsPanel } = await import(
  "../../../src/pages/competitor-accounts/TeamCloudCredentialsPanel"
);

const config = { apiBaseUrl: "https://api.test", tenantId: "t1" } as AppConfig;
const FAKE_CLIENT = { put: vi.fn(), del: vi.fn(), get: vi.fn() };
const READ_ONLY_CLIENT = {
  put: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
  tenantAccess: { role: "viewer", canMutateTenant: false },
};

function renderPanel() {
  const { container } = render(<TeamCloudCredentialsPanel config={config} />);
  return createWrapper(container);
}

function setTeamSlug(w: ReturnType<typeof createWrapper>, value: string) {
  w.findInput()?.setInputValue(value);
}
function setCredential(w: ReturnType<typeof createWrapper>, value: string) {
  w.findTextarea()?.setTextareaValue(value);
}
const btn = (key: string) => screen.getByRole("button", { name: key });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useApiClient.mockReturnValue(FAKE_CLIENT);
  mocks.registerTeamCredential.mockResolvedValue({ registered: true });
  mocks.revokeTeamCredential.mockResolvedValue(undefined);
  mocks.getTeamCredentialStatus.mockResolvedValue({ registered: true });
});
afterEach(() => vi.clearAllMocks());

describe("TeamCloudCredentialsPanel (#1413)", () => {
  it("should register a valid credential and show a success notice", async () => {
    const w = renderPanel();
    setTeamSlug(w, "team-a");
    setCredential(w, '{"accessToken":"x","accessTokenSecret":"y"}');
    btn("team_cloud_credentials.register_button").click();
    await waitFor(() =>
      expect(mocks.registerTeamCredential).toHaveBeenCalledWith(FAKE_CLIENT, "sakura", "team-a", {
        accessToken: "x",
        accessTokenSecret: "y",
      }),
    );
    expect(await screen.findByText("team_cloud_credentials.registered")).toBeInTheDocument();
  });

  it("should reject invalid JSON without calling the API", async () => {
    const w = renderPanel();
    setTeamSlug(w, "team-a");
    setCredential(w, "{not json");
    btn("team_cloud_credentials.register_button").click();
    expect(await screen.findByText("team_cloud_credentials.invalid_json")).toBeInTheDocument();
    expect(mocks.registerTeamCredential).not.toHaveBeenCalled();
  });

  it("should surface an API error as a FriendlyErrorAlert", async () => {
    mocks.registerTeamCredential.mockRejectedValueOnce(new Error("boom"));
    const w = renderPanel();
    setTeamSlug(w, "team-a");
    setCredential(w, "{}");
    btn("team_cloud_credentials.register_button").click();
    // toFriendlyError → FriendlyErrorAlert (Cloudscape Alert type=error)。 test-util で検出する。
    await waitFor(() => expect(w.findAlert()).not.toBeNull());
    expect(mocks.registerTeamCredential).toHaveBeenCalled();
  });

  it("should revoke and show a notice", async () => {
    const w = renderPanel();
    setTeamSlug(w, "team-a");
    btn("team_cloud_credentials.revoke_button").click();
    await waitFor(() =>
      expect(mocks.revokeTeamCredential).toHaveBeenCalledWith(FAKE_CLIENT, "sakura", "team-a"),
    );
    expect(await screen.findByText("team_cloud_credentials.revoked")).toBeInTheDocument();
  });

  it("should report registered / unregistered status", async () => {
    const w = renderPanel();
    setTeamSlug(w, "team-a");
    btn("team_cloud_credentials.status_button").click();
    expect(await screen.findByText("team_cloud_credentials.status_registered")).toBeInTheDocument();

    mocks.getTeamCredentialStatus.mockResolvedValueOnce({ registered: false });
    btn("team_cloud_credentials.status_button").click();
    expect(
      await screen.findByText("team_cloud_credentials.status_unregistered"),
    ).toBeInTheDocument();
  });

  it("should switch provider via the Select and use it on register", async () => {
    const w = renderPanel();
    const select = w.findSelect();
    select?.openDropdown();
    select?.selectOptionByValue("gcp");
    setTeamSlug(w, "team-a");
    setCredential(w, "{}");
    btn("team_cloud_credentials.register_button").click();
    await waitFor(() =>
      expect(mocks.registerTeamCredential).toHaveBeenCalledWith(FAKE_CLIENT, "gcp", "team-a", {}),
    );
  });

  it("should mark an invalid team slug and disable register", () => {
    const w = renderPanel();
    setTeamSlug(w, "BAD slug!");
    setCredential(w, "{}");
    expect(screen.getByText("team_cloud_credentials.team_invalid")).toBeInTheDocument();
    expect(btn("team_cloud_credentials.register_button")).toBeDisabled();
  });

  it("should disable actions when there is no api client (no auth)", () => {
    mocks.useApiClient.mockReturnValue(null);
    renderPanel();
    expect(btn("team_cloud_credentials.status_button")).toBeDisabled();
  });

  it("should disable credential actions for a read-only viewer", () => {
    mocks.useApiClient.mockReturnValue(READ_ONLY_CLIENT);
    const w = renderPanel();
    setTeamSlug(w, "team-a");
    setCredential(w, "{}");
    expect(btn("team_cloud_credentials.register_button")).toBeDisabled();
    expect(btn("team_cloud_credentials.status_button")).toBeDisabled();
    expect(btn("team_cloud_credentials.revoke_button")).toBeDisabled();
  });

  it("should dismiss the success notice", async () => {
    const w = renderPanel();
    setTeamSlug(w, "team-a");
    btn("team_cloud_credentials.revoke_button").click();
    const notice = await screen.findByText("team_cloud_credentials.revoked");
    expect(notice).toBeInTheDocument();
    // Cloudscape Alert dismiss button
    createWrapper(document.body).findAlert()?.findDismissButton()?.click();
    await waitFor(() =>
      expect(screen.queryByText("team_cloud_credentials.revoked")).not.toBeInTheDocument(),
    );
  });
});
