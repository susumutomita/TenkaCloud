import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../../src/api/client";
import type { EventDetail } from "../../../src/api/events-client";
import { EventRegistrationPanel } from "../../../src/components/event-detail/EventRegistrationPanel";
import type { AppConfig } from "../../../src/config";

const t = (key: string) => key;
vi.mock("../../../src/i18n", () => ({ useT: () => t }));
const summary = {
  tenantId: "tenant",
  enabled: true,
  capacity: 1,
  claimed: 0,
  claimedTeamIds: [],
  teamIds: ["t1"],
  closesAt: "2027-01-01T00:00:00.000Z",
};
function fixture(canMutateTenant = true) {
  const api = {
    get: vi.fn().mockResolvedValue(summary),
    put: vi.fn().mockResolvedValue({ ...summary, invitation: "test-invitation" }),
  };
  render(
    <StrictMode>
      <EventRegistrationPanel
        apiClient={api as unknown as ApiClient}
        config={
          {
            mode: "api",
            participantPortalUrl: "https://portal.example.test/",
          } as unknown as AppConfig
        }
        detail={
          {
            eventId: "e1",
            teams: [{ teamId: "t1", internalSlug: "alpha" }],
          } as unknown as EventDetail
        }
        canMutateTenant={canMutateTenant}
      />
    </StrictMode>,
  );
  return api;
}
afterEach(() => vi.clearAllMocks());
describe("event invitation settings", () => {
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
    const api = fixture(false);
    expect(await screen.findByRole("button", { name: "registration.reissue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "registration.close_button" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "registration.refresh" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(api.put).not.toHaveBeenCalled();
  });
});
