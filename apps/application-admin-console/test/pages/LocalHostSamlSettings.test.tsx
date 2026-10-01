import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";
import { LocalHostSamlSettings } from "../../src/pages/LocalHostSamlSettings";

const mocks = vi.hoisted(() => ({ api: vi.fn(), lang: vi.fn() }));
vi.mock("../../src/api/client", () => ({ useApiClient: mocks.api }));
vi.mock("../../src/i18n", () => ({ useLang: mocks.lang }));
const config: AppConfig = {
  cognitoDomain: "https://host.example/api/host",
  cognitoClientId: "local-host",
  redirectUri: "https://host.example/callback",
  scope: "",
  tenantId: "local-host",
  tenantName: "Local host",
  apiBaseUrl: "https://host.example/api",
  samlIdpDirectory: {},
  mode: "local-host",
};
const provider = {
  issuer: "https://idp.example",
  entryPoint: "https://idp.example/login",
  certificate: "public-certificate",
};
const initial = () => ({
  provider: null as typeof provider | null,
  entityId: "https://host.example/api/host/saml/metadata",
  callbackUrl: "https://host.example/api/host/saml/acs",
  identities: [] as { id: string; issuer: string; subject: string; userId: string }[],
});

function fixture() {
  const settings = initial();
  const get = vi.fn(async (path: string) => {
    if (path === "/host/saml/provider")
      return { ...settings, identities: [...settings.identities] };
    if (path === "/host/users")
      return { items: [{ id: "existing-user", username: "viewer", role: "Viewer" }] };
    throw new Error(`Unexpected request: ${path}`);
  });
  const put = vi.fn(async (_path: string, body: typeof provider) => {
    settings.provider = body;
  });
  const post = vi.fn(async (_path: string, body: { userId: string; subject: string }) => {
    settings.identities.push({ id: "identity-id", issuer: provider.issuer, ...body });
  });
  const del = vi.fn(async () => {
    settings.identities = [];
  });
  mocks.api.mockReturnValue({ get, put, post, del });
  return { settings, get, put, post, del };
}

beforeEach(() => {
  mocks.lang.mockReturnValue("en");
  mocks.api.mockReset();
});

it.each([
  {
    lang: "en",
    sp: "SP Entity ID (register with IdP)",
    url: "IdP sign-in URL (HTTP-Redirect)",
    cert: "IdP signing certificate (PEM)",
    save: "Save IdP settings",
    organizer: "Existing organizer",
    link: "Link NameID",
    unlink: "Unlink",
  },
  {
    lang: "ja",
    sp: "SP Entity ID（IdP に登録）",
    url: "IdP ログイン URL（HTTP-Redirect）",
    cert: "IdP 署名証明書（PEM）",
    save: "IdP 設定を保存",
    organizer: "既存の主催者ユーザー",
    link: "NameID を紐付ける",
    unlink: "紐付け解除",
  },
])("configures a provider and explicitly links an existing organizer in $lang", async (copy) => {
  mocks.lang.mockReturnValue(copy.lang);
  const f = fixture();
  render(<LocalHostSamlSettings config={config} />);
  expect(await screen.findByLabelText(copy.sp)).toHaveValue(f.settings.entityId);
  expect(screen.getByLabelText(copy.sp)).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: copy.link })).toBeDisabled();
  for (const [label, value] of [
    ["IdP Entity ID", provider.issuer],
    [copy.url, provider.entryPoint],
    [copy.cert, provider.certificate],
  ] as const) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("button", { name: copy.save }));
  await waitFor(() => expect(f.put).toHaveBeenCalledWith("/host/saml/provider", provider));
  await waitFor(() => expect(screen.getByLabelText(copy.organizer)).toBeEnabled());
  fireEvent.change(screen.getByLabelText(copy.organizer), { target: { value: "existing-user" } });
  fireEvent.change(screen.getByLabelText("Persistent NameID"), {
    target: { value: "persistent-subject" },
  });
  fireEvent.click(screen.getByRole("button", { name: copy.link }));
  expect(await screen.findByText("persistent-subject")).toBeInTheDocument();
  expect(f.post).toHaveBeenCalledWith("/host/saml/identities", {
    userId: "existing-user",
    subject: "persistent-subject",
  });
  expect(screen.getByText("viewer", { selector: "strong" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: copy.unlink }));
  await waitFor(() => expect(screen.queryByText("persistent-subject")).toBeNull());
  expect(f.del).toHaveBeenCalledWith("/host/saml/identities/identity-id");
});

it("shows provider read failures and does not offer a save with no API session", async () => {
  const f = fixture();
  f.get.mockRejectedValue(new Error("Provider unavailable"));
  const page = render(<LocalHostSamlSettings config={config} />);
  expect(await screen.findByText("Provider unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save IdP settings" })).toBeNull();
  page.unmount();
  f.get.mockClear();
  mocks.api.mockReturnValue(null);
  render(<LocalHostSamlSettings config={config} />);
  expect(f.get).not.toHaveBeenCalled();
});

it("preserves displayed settings when a provider mutation fails and labels missing users by ID", async () => {
  const f = fixture();
  f.settings.provider = provider;
  f.settings.identities = [
    { id: "identity-id", issuer: provider.issuer, subject: "old-subject", userId: "removed-user" },
  ];
  f.put.mockRejectedValue(new Error("Configuration rejected"));
  render(<LocalHostSamlSettings config={config} />);
  expect(await screen.findByText("removed-user")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save IdP settings" }));
  expect(await screen.findByText("Configuration rejected")).toBeInTheDocument();
  expect(screen.getByText("old-subject")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save IdP settings" })).toBeEnabled();
});

it("disables every SAML mutation if the API session disappears after loading settings", async () => {
  const f = fixture();
  f.settings.provider = provider;
  f.settings.identities = [
    { id: "identity-id", issuer: provider.issuer, subject: "old-subject", userId: "existing-user" },
  ];
  const view = render(<LocalHostSamlSettings config={config} />);
  await screen.findByText("old-subject");
  fireEvent.change(screen.getByLabelText("Existing organizer"), {
    target: { value: "existing-user" },
  });
  fireEvent.change(screen.getByLabelText("Persistent NameID"), {
    target: { value: "new-subject" },
  });
  for (const name of ["Save IdP settings", "Link NameID", "Unlink"])
    expect(screen.getByRole("button", { name })).toBeEnabled();

  f.get.mockClear();
  mocks.api.mockReturnValue(null);
  view.rerender(<LocalHostSamlSettings config={config} />);
  for (const name of ["Save IdP settings", "Link NameID", "Unlink"]) {
    const button = screen.getByRole("button", { name });
    expect(button).toBeDisabled();
    fireEvent.click(button);
  }
  expect(f.get).not.toHaveBeenCalled();
  expect(f.put).not.toHaveBeenCalled();
  expect(f.post).not.toHaveBeenCalled();
  expect(f.del).not.toHaveBeenCalled();
  expect(screen.getByText("old-subject")).toBeInTheDocument();
});
