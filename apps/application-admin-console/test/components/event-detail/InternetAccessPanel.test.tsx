/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic addresses are test data and are never contacted. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../../src/api/client";
import type { InternetAccessView } from "../../../src/api/internet-access-client";
import { InternetAccessPanel } from "../../../src/components/event-detail/InternetAccessPanel";
import { I18nProvider, useT } from "../../../src/i18n";

const mocks = vi.hoisted(() => ({
  fetchInternetAccess: vi.fn(),
  approveInternetAccess: vi.fn(),
  revokeInternetAccess: vi.fn(),
}));
vi.mock("../../../src/api/internet-access-client", () => mocks);
const apiClient = createApiClient("http://localhost/api", "a.e30.c");
const view: InternetAccessView = {
  available: true,
  problems: [
    {
      problemId: "problem",
      name: "Example problem",
      requests: [
        { id: "one", service: "app", address: "8.8.8.8", port: 443, purpose: "Fetch example data" },
      ],
      grant: null,
    },
  ],
};
function Panel({ canMutateTenant }: { readonly canMutateTenant: boolean }) {
  const t = useT();
  return (
    <InternetAccessPanel
      apiClient={apiClient}
      eventId="event"
      canMutateTenant={canMutateTenant}
      t={t}
    />
  );
}
const renderPanel = (canMutateTenant = true) =>
  render(
    <I18nProvider>
      <Panel canMutateTenant={canMutateTenant} />
    </I18nProvider>,
  );
beforeEach(() => {
  localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  vi.resetAllMocks();
  mocks.fetchInternetAccess.mockResolvedValue(view);
  mocks.approveInternetAccess.mockResolvedValue({});
  mocks.revokeInternetAccess.mockResolvedValue({});
});

afterEach(() => {
  localStorage.removeItem("tenkacloud.application-admin.locale");
});

it("lists declared service, IP, port and purpose without approving by default", async () => {
  renderPanel();
  expect(await screen.findByText(/app → 8.8.8.8:443/)).toHaveTextContent("Fetch example data");
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "選んだ接続を承認" })).toBeDisabled();
  expect(
    screen.getByText(
      "問題が申請した接続先を、1 件ずつ選んで承認します。承認しない接続は遮断されたままです。許可は IP アドレスと TCP ポートの単位で、URL の単位ではありません。承認は、そのあとに起動した環境から有効になります。取り消すと、稼働中の環境でもすぐに遮断されます。",
    ),
  ).toBeInTheDocument();
  expect(mocks.fetchInternetAccess).toHaveBeenCalledWith(apiClient, "event");
});

it("approves only selected requests and reloads the saved grant", async () => {
  renderPanel();
  fireEvent.click(await screen.findByRole("checkbox"));
  mocks.fetchInternetAccess.mockResolvedValue({
    ...view,
    problems: [
      {
        ...view.problems[0],
        grant: { requestIds: ["one"], grantedAt: new Date(2026, 9, 16, 9, 30).toISOString() },
      },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "選んだ接続を承認" }));
  await waitFor(() =>
    expect(mocks.approveInternetAccess).toHaveBeenCalledWith(apiClient, "event", "problem", [
      "one",
    ]),
  );
  expect(await screen.findByText("2026/10/16 09:30 に承認")).toBeInTheDocument();
});

it("revokes an existing grant and reloads blocked requests", async () => {
  mocks.fetchInternetAccess.mockResolvedValueOnce({
    ...view,
    problems: [
      {
        ...view.problems[0],
        grant: { requestIds: ["one"], grantedAt: new Date(2026, 9, 16, 9, 30).toISOString() },
      },
    ],
  });
  renderPanel();
  expect(await screen.findByRole("checkbox")).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "承認を取り消す" }));
  await waitFor(() =>
    expect(mocks.revokeInternetAccess).toHaveBeenCalledWith(apiClient, "event", "problem"),
  );
  await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
});

it("shows unavailable enforcement and disables approval", async () => {
  mocks.fetchInternetAccess.mockResolvedValue({
    ...view,
    available: false,
    reason: "Native adapter unavailable",
  });
  renderPanel();
  expect(await screen.findByText("このホストでは承認できません")).toBeInTheDocument();
  expect(
    screen.getByText(
      "インターネット接続の許可には、Linux のチーム別ネットワーク隔離が必要です。このホストでは使えないため、申請された接続はすべて遮断されます。",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Native adapter unavailable")).toBeInTheDocument();
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.getByRole("button", { name: "選んだ接続を承認" })).toBeDisabled();
});

it("keeps viewer controls disabled", async () => {
  renderPanel(false);
  expect(await screen.findByRole("checkbox")).toBeDisabled();
  expect(screen.getByRole("button", { name: "承認を取り消す" })).toBeDisabled();
});

it("reports read and mutation failures without pretending approval succeeded", async () => {
  mocks.fetchInternetAccess.mockRejectedValueOnce(new Error("Catalog unavailable"));
  const first = renderPanel();
  expect(await screen.findByText("Catalog unavailable")).toBeInTheDocument();
  first.unmount();
  mocks.fetchInternetAccess.mockResolvedValue(view);
  mocks.approveInternetAccess.mockRejectedValue(new Error("Protected host destination"));
  renderPanel();
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "選んだ接続を承認" }));
  expect(await screen.findByText("Protected host destination")).toBeInTheDocument();
  expect(screen.queryByText("2026/10/16 09:30 に承認")).not.toBeInTheDocument();
});

it("hides the panel when no problem requests Internet access", async () => {
  mocks.fetchInternetAccess.mockResolvedValue({ available: false, problems: [] });
  const { container } = renderPanel();
  await waitFor(() => expect(mocks.fetchInternetAccess).toHaveResolved());
  expect(container).toBeEmptyDOMElement();
});

/* eslint-enable sonarjs/no-hardcoded-ip */

for (const revoke of [false, true])
  it(`keeps other problems' unsaved selections after ${revoke ? "revocation" : "approval"} and resets only the saved problem`, async () => {
    const first = view.problems[0];
    if (!first) throw new Error("Missing problem fixture");
    const initial = {
      ...view,
      problems: [
        {
          ...first,
          grant: revoke ? { requestIds: ["one"], grantedAt: "2026-10-16T00:00:00Z" } : null,
        },
        { ...first, problemId: "other", name: "Other problem" },
      ],
    };
    mocks.fetchInternetAccess.mockResolvedValueOnce(initial).mockResolvedValue({
      ...initial,
      problems: [
        {
          ...first,
          grant: revoke ? null : { requestIds: ["one"], grantedAt: "2026-10-16T00:00:00Z" },
        },
        initial.problems[1],
      ],
    });
    renderPanel();
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);
    if (!revoke) fireEvent.click(checkboxes[0]);
    fireEvent.click(
      screen.getAllByRole("button", { name: revoke ? "承認を取り消す" : "選んだ接続を承認" })[0],
    );
    await waitFor(() => expect(mocks.fetchInternetAccess).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      if (revoke) expect(checkboxes[0]).not.toBeChecked();
      else expect(checkboxes[0]).toBeChecked();
    });
    expect(checkboxes[1]).toBeChecked();
  });

for (const revoke of [false, true])
  it(`refreshes the server grant after a 409 on ${revoke ? "DELETE" : "PUT"} and keeps the error`, async () => {
    const first = view.problems[0];
    if (!first) throw new Error("Missing problem fixture");
    const grant = { requestIds: ["one"], grantedAt: new Date(2026, 9, 16, 9, 30).toISOString() };
    mocks.fetchInternetAccess
      .mockResolvedValueOnce({
        ...view,
        problems: [{ ...first, grant: revoke ? grant : null }],
      })
      .mockResolvedValue({ ...view, problems: [{ ...first, grant: revoke ? null : grant }] });
    const failure = new Error(
      `409: approval was ${revoke ? "revoked" : "saved"}; environments halted`,
    );
    (revoke ? mocks.revokeInternetAccess : mocks.approveInternetAccess).mockRejectedValue(failure);
    renderPanel();
    const checkbox = await screen.findByRole("checkbox");
    if (!revoke) fireEvent.click(checkbox);
    fireEvent.click(
      screen.getByRole("button", { name: revoke ? "承認を取り消す" : "選んだ接続を承認" }),
    );
    expect(await screen.findByText(failure.message)).toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchInternetAccess).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      if (revoke) {
        expect(checkbox).not.toBeChecked();
        expect(screen.queryByText("2026/10/16 09:30 に承認")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "承認を取り消す" })).toBeDisabled();
      } else {
        expect(checkbox).toBeChecked();
        expect(screen.getByText("2026/10/16 09:30 に承認")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "承認を取り消す" })).toBeEnabled();
      }
    });
    expect(screen.getByText(failure.message)).toBeInTheDocument();
  });
