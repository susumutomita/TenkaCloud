import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiError } from "../../../src/api/client";
import type { EventDetail } from "../../../src/api/events-client";
import { EventRegistrationPanel } from "../../../src/components/event-detail/EventRegistrationPanel";
import type { AppConfig } from "../../../src/config";

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;
vi.mock("../../../src/i18n", () => ({ useT: () => t }));
const summary = {
  tenantId: "tenant",
  enabled: true,
  capacity: 1,
  claimed: 0,
  claimedTeamIds: [] as string[],
  teamIds: ["t1"],
  closesAt: "2027-01-01T00:00:00.000Z",
};
function makeApi() {
  return {
    get: vi.fn().mockResolvedValue(summary),
    put: vi.fn().mockResolvedValue({ ...summary, invitation: "test-invitation" }),
  };
}
interface FixtureOptions {
  api?: ReturnType<typeof makeApi>;
  apiClient?: ApiClient | null;
  config?: Partial<AppConfig>;
  detail?: Partial<EventDetail>;
  canMutateTenant?: boolean;
}
function fixture(options: FixtureOptions = {}) {
  const api = options.api ?? makeApi();
  const panel = (changes: FixtureOptions = {}) => {
    const props = { ...options, ...changes };
    return (
      <StrictMode>
        <EventRegistrationPanel
          apiClient={
            props.apiClient === undefined ? (api as unknown as ApiClient) : props.apiClient
          }
          config={
            {
              mode: "api",
              participantPortalUrl: "https://portal.example.test/",
              ...props.config,
            } as unknown as AppConfig
          }
          detail={
            {
              eventId: "e1",
              teams: [
                { teamId: "t1", internalSlug: "alpha" },
                { teamId: "t2", internalSlug: "bravo", displayName: "Bravo" },
              ],
              ...props.detail,
            } as unknown as EventDetail
          }
          canMutateTenant={props.canMutateTenant ?? true}
        />
      </StrictMode>
    );
  };
  const view = render(panel());
  return { ...api, ...view, update: (changes: FixtureOptions) => view.rerender(panel(changes)) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function issue() {
  await screen.findByRole("button", { name: "registration.reissue" });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "registration.reissue" }));
  return screen.findByRole("textbox", { name: "registration.link" });
}
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
describe("event invitation settings", () => {
  it("keeps a just-issued link when an earlier refresh resolves after the save", async () => {
    // The invitation is returned only by the PUT. A refresh GET that was already in flight
    // and resolves afterwards used to clear the one-time link and restore the older summary,
    // so the operator had to reissue (revoking the link they had just been shown).
    const api = fixture();
    await screen.findByRole("button", { name: "registration.reissue" });
    const slowRefresh = deferred<typeof summary>();
    api.get.mockReturnValueOnce(slowRefresh.promise);
    fireEvent.click(screen.getByRole("button", { name: "registration.refresh" }));

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "registration.reissue" }));
    const link = "https://portal.example.test/join/tenant/e1#invite=test-invitation";
    expect(await screen.findByDisplayValue(link)).toBeInTheDocument();

    await act(async () => {
      slowRefresh.resolve({ ...summary, claimed: 1, claimedTeamIds: ["t1"] });
      await slowRefresh.promise;
    });
    expect(screen.getByDisplayValue(link)).toBeInTheDocument();
    expect(screen.getByText('registration.open:{"claimed":0,"capacity":1}')).toBeInTheDocument();
    expect(
      screen.queryByText('registration.open:{"claimed":1,"capacity":1}'),
    ).not.toBeInTheDocument();
  });

  it("still shows the first load when a save fails before that load finishes", async () => {
    const slowLoad = deferred<typeof summary>();
    const api = makeApi();
    api.get.mockReturnValue(slowLoad.promise);
    api.put.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "invalid_pool" })));
    fixture({ api });
    const multiselect = createWrapper(document.body).findMultiselect();
    if (!multiselect) throw new Error("Missing pool selector");
    multiselect.openDropdown();
    multiselect.selectOptionByValue("t1");
    multiselect.closeDropdown();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "registration.open_button" }));
    expect(await screen.findByText("registration.error_invalid_pool")).toBeInTheDocument();

    await act(async () => {
      slowLoad.resolve(summary);
      await slowLoad.promise;
    });
    expect(screen.getByText('registration.open:{"claimed":0,"capacity":1}')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "registration.close_button" })).toBeEnabled();
  });

  it("tells the operator to regenerate keys when a slot has none stored", async () => {
    const api = fixture();
    api.put.mockRejectedValueOnce(
      new ApiError(409, JSON.stringify({ error: "login_key_missing" })),
    );
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "registration.reissue" }));
    expect(await screen.findByText("registration.error_login_key_missing")).toBeInTheDocument();
  });

  it("requires explicit confirmation, opens selected capacity with a fragment link, and closes", async () => {
    const api = fixture();
    const save = await screen.findByRole("button", { name: "registration.reissue" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/events/e1/registration", {
        enabled: true,
        teamIds: ["t1"],
        closesAt: summary.closesAt,
      }),
    );
    expect(
      await screen.findByDisplayValue(
        "https://portal.example.test/join/tenant/e1#invite=test-invitation",
      ),
    ).toBeInTheDocument();
    api.put.mockResolvedValue({ ...summary, enabled: false });
    fireEvent.click(screen.getByRole("button", { name: "registration.close_button" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenLastCalledWith("/events/e1/registration", { enabled: false }),
    );
    await waitFor(() =>
      expect(screen.queryByDisplayValue(/test-invitation/)).not.toBeInTheDocument(),
    );
  });
  it("keeps viewers read-only and refreshes allocation status", async () => {
    const api = fixture({ canMutateTenant: false });
    expect(await screen.findByRole("button", { name: "registration.reissue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "registration.close_button" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "registration.refresh" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(api.put).not.toHaveBeenCalled();
  });

  it("recovers from a failed initial load when the organizer refreshes", async () => {
    const api = makeApi();
    api.get.mockRejectedValue(new Error("connection lost"));
    fixture({ api });
    expect(await screen.findByText("registration.error_unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/^registration.open:/)).not.toBeInTheDocument();

    api.get.mockResolvedValue(summary);
    fireEvent.click(screen.getByRole("button", { name: "registration.refresh" }));

    expect(
      await screen.findByText('registration.open:{"claimed":0,"capacity":1}'),
    ).toBeInTheDocument();
    expect(screen.queryByText("registration.error_unavailable")).not.toBeInTheDocument();
    expect(api.get).toHaveBeenLastCalledWith("/events/e1/registration");
    expect(api.put).not.toHaveBeenCalled();
  });

  it.each([
    "invalid_pool",
    "not_ready",
    "closed",
    "conflict",
  ])("shows actionable %s feedback without replacing an existing invitation", async (code) => {
    const api = fixture();
    const link = await issue();
    const original = (link as HTMLInputElement).value;
    api.put.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: code })));

    fireEvent.click(screen.getByRole("button", { name: "registration.reissue" }));

    expect(await screen.findByText(`registration.error_${code}`)).toBeInTheDocument();
    expect(link).toHaveValue(original);
    expect(screen.getByRole("button", { name: "registration.reissue" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "registration.refresh" })).toBeEnabled();
  });

  it.each([
    ["non-JSON gateway error", "Bad Gateway"],
    ["null response", "null"],
    ["string response", '"unavailable"'],
    ["missing error code", '{"message":"unavailable"}'],
    ["non-string error code", '{"error":503}'],
    ["unknown error code", '{"error":"internal_error"}'],
  ])("shows a safe load error for a %s", async (_label, body) => {
    const api = makeApi();
    api.get.mockRejectedValue(new ApiError(503, body));
    fixture({ api });

    expect(await screen.findByText("registration.error_unavailable")).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("selects the pool and deadline before opening, and blocks duplicate saves while pending", async () => {
    const api = makeApi();
    api.get.mockResolvedValue({
      ...summary,
      enabled: false,
      teamIds: [],
      capacity: 0,
      closesAt: undefined,
    });
    const saved = deferred<typeof summary & { invitation: string }>();
    api.put.mockReturnValue(saved.promise);
    fixture({ api, detail: { endsAt: "2027-02-01T09:00:00.000Z" } });
    await screen.findByText('registration.closed:{"claimed":0,"capacity":0}');
    const open = screen.getByRole("button", { name: "registration.open_button" });
    const deadline = screen.getByLabelText("registration.deadline") as HTMLInputElement;
    expect(new Date(deadline.value).toISOString()).toBe("2027-02-01T09:00:00.000Z");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(open).toBeDisabled();

    const multiselect = createWrapper(document.body).findMultiselect();
    if (!multiselect) throw new Error("Missing pool selector");
    multiselect.openDropdown();
    multiselect.selectOptionByValue("t2");
    multiselect.closeDropdown();
    expect(multiselect.findTokens()[0]?.getElement()).toHaveTextContent("Bravo");
    fireEvent.change(deadline, { target: { value: "" } });
    expect(open).toBeDisabled();
    fireEvent.change(deadline, { target: { value: "2027-01-02T15:30" } });
    expect(open).toBeEnabled();
    fireEvent.click(open);

    expect(api.put).toHaveBeenCalledWith("/events/e1/registration", {
      enabled: true,
      teamIds: ["t2"],
      closesAt: new Date("2027-01-02T15:30").toISOString(),
    });
    expect(deadline).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(multiselect.isDisabled()).toBe(true);
    expect(screen.getByRole("button", { name: "registration.refresh" })).toBeDisabled();
    fireEvent.click(open);
    expect(api.put).toHaveBeenCalledTimes(1);

    await act(async () =>
      saved.resolve({ ...summary, teamIds: ["t2"], invitation: "new-invitation" }),
    );
    expect(await screen.findByRole("textbox", { name: "registration.link" })).toHaveValue(
      "https://portal.example.test/join/tenant/e1#invite=new-invitation",
    );
    expect(deadline).toBeEnabled();
  });

  it("refreshes claimed labels, selected slots, and the deadline from the server", async () => {
    const api = fixture();
    await screen.findByRole("button", { name: "registration.reissue" });
    api.get.mockResolvedValue({
      ...summary,
      capacity: 2,
      claimed: 1,
      teamIds: ["t1", "t2"],
      claimedTeamIds: ["t2"],
      closesAt: "2027-01-02T00:00:00.000Z",
    });

    fireEvent.click(screen.getByRole("button", { name: "registration.refresh" }));

    expect(
      await screen.findByText('registration.open:{"claimed":1,"capacity":2}'),
    ).toBeInTheDocument();
    const multiselect = createWrapper(document.body).findMultiselect();
    expect(multiselect?.findTokens()).toHaveLength(2);
    expect(multiselect?.findTokens()[1]?.getElement()).toHaveTextContent("registration.allocated");
    expect(multiselect?.findTokens()[0]?.getElement()).toHaveTextContent(
      "registration.unallocated",
    );
    const deadline = screen.getByLabelText("registration.deadline") as HTMLInputElement;
    expect(new Date(deadline.value).toISOString()).toBe("2027-01-02T00:00:00.000Z");
  });

  it("copies an invitation, replaces it on reissue, and reports clipboard failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const api = fixture({
      config: { participantPortalUrl: "https://portal.example.test/participant" },
    });
    const link = await issue();
    const original =
      "https://portal.example.test/participant/join/tenant/e1#invite=test-invitation";
    expect(link).toHaveValue(original);
    fireEvent.click(screen.getByRole("button", { name: "registration.copy" }));
    expect(await screen.findByRole("button", { name: "registration.copied" })).toBeEnabled();
    expect(writeText).toHaveBeenCalledWith(original);

    api.put.mockResolvedValueOnce({ ...summary, invitation: "replacement" });
    fireEvent.click(screen.getByRole("button", { name: "registration.reissue" }));
    const replacement = "https://portal.example.test/participant/join/tenant/e1#invite=replacement";
    await waitFor(() => expect(link).toHaveValue(replacement));
    expect(screen.queryByRole("button", { name: "registration.copied" })).not.toBeInTheDocument();
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    fireEvent.click(screen.getByRole("button", { name: "registration.copy" }));
    expect(await screen.findByText("registration.copy_failed")).toBeInTheDocument();
    expect(link).toHaveValue(replacement);
    expect(writeText).toHaveBeenLastCalledWith(replacement);
    fireEvent.click(screen.getByRole("button", { name: "registration.copy" }));
    expect(await screen.findByRole("button", { name: "registration.copied" })).toBeEnabled();
  });

  it.each([
    ["reissues the invitation", true],
    ["closes registration", false],
  ])("removes the previous link after refreshing when another operator %s", async (_action, enabled) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const api = fixture();
    const link = await issue();
    fireEvent.click(screen.getByRole("button", { name: "registration.copy" }));
    await screen.findByRole("button", { name: "registration.copied" });
    // GET never returns the one-time invitation, including after another operator reissues it.
    api.get.mockResolvedValueOnce({ ...summary, enabled });

    fireEvent.click(screen.getByRole("button", { name: "registration.refresh" }));

    await waitFor(() => expect(link).not.toBeInTheDocument());
    expect(
      screen.getByText(`registration.${enabled ? "open" : "closed"}:{"claimed":0,"capacity":1}`),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "registration.copy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "registration.copied" })).not.toBeInTheDocument();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("keeps the issued link and copy result when refreshing fails", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const api = fixture();
    const link = await issue();
    fireEvent.click(screen.getByRole("button", { name: "registration.copy" }));
    await screen.findByRole("button", { name: "registration.copied" });
    api.get.mockRejectedValueOnce(new Error("connection lost"));

    fireEvent.click(screen.getByRole("button", { name: "registration.refresh" }));

    expect(await screen.findByText("registration.error_unavailable")).toBeInTheDocument();
    expect(link).toHaveValue("https://portal.example.test/join/tenant/e1#invite=test-invitation");
    expect(screen.getByRole("button", { name: "registration.copied" })).toBeEnabled();
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it("retains the open state if closing fails and allows a retry", async () => {
    const api = fixture();
    const link = await issue();
    api.put.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "registration.close_button" }));
    expect(await screen.findByText("registration.error_unavailable")).toBeInTheDocument();
    expect(link).toHaveValue("https://portal.example.test/join/tenant/e1#invite=test-invitation");
    api.put.mockResolvedValueOnce({ ...summary, enabled: false });
    fireEvent.click(screen.getByRole("button", { name: "registration.close_button" }));

    expect(
      await screen.findByText('registration.closed:{"claimed":0,"capacity":1}'),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "registration.link" })).not.toBeInTheDocument();
    expect(screen.queryByText("registration.error_unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "registration.close_button" })).toBeDisabled();
  });

  it("ignores an older response after the organizer refreshes again", async () => {
    const stale = deferred<typeof summary>();
    const api = makeApi();
    api.get.mockReturnValue(stale.promise);
    fixture({ api });
    api.get.mockResolvedValueOnce({ ...summary, claimed: 1, claimedTeamIds: ["t1"] });
    fireEvent.click(screen.getByRole("button", { name: "registration.refresh" }));
    expect(
      await screen.findByText('registration.open:{"claimed":1,"capacity":1}'),
    ).toBeInTheDocument();

    await act(async () => stale.resolve(summary));

    expect(screen.getByText('registration.open:{"claimed":1,"capacity":1}')).toBeInTheDocument();
    expect(
      screen.queryByText('registration.open:{"claimed":0,"capacity":1}'),
    ).not.toBeInTheDocument();
  });

  it("ignores a superseded load failure after a successful refresh", async () => {
    const stale = deferred<typeof summary>();
    const api = makeApi();
    api.get.mockReturnValue(stale.promise);
    fixture({ api });
    api.get.mockResolvedValueOnce(summary);
    fireEvent.click(screen.getByRole("button", { name: "registration.refresh" }));
    await screen.findByText('registration.open:{"claimed":0,"capacity":1}');

    await act(async () => stale.reject(new Error("old request failed")));

    expect(screen.queryByText("registration.error_unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "registration.reissue" })).toBeInTheDocument();
  });

  it("hides registration and makes no API requests in demo mode", () => {
    const api = fixture({ config: { mode: "demo" } });
    expect(screen.queryByText("registration.title")).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("does not load or save after the authenticated API client disappears", async () => {
    const api = fixture();
    await screen.findByRole("button", { name: "registration.reissue" });
    api.get.mockClear();
    api.update({ apiClient: null });
    fireEvent.click(screen.getByRole("button", { name: "registration.refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "registration.close_button" }));
    expect(api.get).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("prevents issuing a link when the participant portal URL is not configured", async () => {
    const api = fixture({ config: { participantPortalUrl: undefined } });
    await screen.findByRole("button", { name: "registration.reissue" });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "registration.reissue" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "registration.reissue" }));
    expect(api.put).not.toHaveBeenCalled();
  });

  it("closes an existing registration even when the participant portal URL is not configured", async () => {
    const api = fixture({ config: { participantPortalUrl: undefined } });
    await screen.findByRole("button", { name: "registration.reissue" });
    api.put.mockResolvedValueOnce({ ...summary, enabled: false });

    fireEvent.click(screen.getByRole("button", { name: "registration.close_button" }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/events/e1/registration", { enabled: false }),
    );
    expect(
      await screen.findByText('registration.closed:{"claimed":0,"capacity":1}'),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "registration.close_button" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "registration.link" })).not.toBeInTheDocument();
  });
});
