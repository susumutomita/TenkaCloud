import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventCreateAccountsAlerts,
  type EventCreateAccountsAlertsProps,
} from "../../../src/pages/event-create/EventCreateAccountsAlerts";

/**
 * Teams section 上の 3 種 Alert (load error / loading / 0-verified hint) の表示判定と、
 * reload button / Competitor Accounts link の挙動を pin。 useT echo、 useNavigate を mock。
 */
const { mockNav } = vi.hoisted(() => ({ mockNav: vi.fn() }));
vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../../src/i18n", () => ({ useT: () => (k: string) => k }));

const props = (
  over: Partial<EventCreateAccountsAlertsProps> = {},
): EventCreateAccountsAlertsProps => ({
  accountsLoadError: null,
  accountsLoading: false,
  showLoadingHint: false,
  showNoVerifiedAccountsHint: false,
  onReload: vi.fn(),
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("EventCreateAccountsAlerts", () => {
  it("should render nothing when no alert condition is active", () => {
    const { container } = render(<EventCreateAccountsAlerts {...props()} />);
    expect(container.textContent).toBe("");
  });

  it("should show the load-error alert and reload on click", () => {
    const p = props({ accountsLoadError: "boom" });
    render(<EventCreateAccountsAlerts {...p} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "event_create.accounts_reload" }));
    expect(p.onReload).toHaveBeenCalled();
  });

  it("should show the loading hint", () => {
    render(<EventCreateAccountsAlerts {...props({ showLoadingHint: true })} />);
    expect(screen.getByText("event_create.accounts_loading_body")).toBeInTheDocument();
  });

  it("should show the no-verified warning with reload + accounts link", () => {
    const p = props({ showNoVerifiedAccountsHint: true });
    render(<EventCreateAccountsAlerts {...p} />);
    expect(screen.getByText("event_create.no_verified_body")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "event_create.accounts_reload" }));
    expect(p.onReload).toHaveBeenCalled();
    fireEvent.click(screen.getByText("event_create.go_to_competitor_accounts"));
    expect(mockNav).toHaveBeenCalledWith("/competitor-accounts");
  });
});
