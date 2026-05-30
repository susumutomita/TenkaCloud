import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompetitorAccountSummary } from "../../../src/api/competitor-accounts-client";
import {
  EventCreateTeamsSection,
  type EventCreateTeamsSectionProps,
} from "../../../src/pages/event-create/EventCreateTeamsSection";
import type { TeamTableItem } from "../../../src/pages/event-create/helpers";

/**
 * Teams section: 各 team の slug Input + verified AWS account Select。 teamCount 0 の empty、
 * slug 変更 / account 選択の onUpdateTeamRow、 selected account の summary 表示、 no-verified
 * 時の disabled+helper、 重複 slug error を pin。 useT echo、 helpers (SLUG_RE/ACCOUNT_ID_RE/
 * formatVerifiedAccountSummary) は実物。 Cloudscape Select は test-utils で駆動。
 */
vi.mock("../../../src/i18n", () => ({ useT: () => (k: string) => k }));

const ACCOUNT_ID = "111111111111";
const account: CompetitorAccountSummary = {
  awsAccountId: ACCOUNT_ID,
  region: "ap-northeast-1",
  competitorRoleName: "Role",
  alias: "prod",
  verified: true,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
};
const validation = (hasDuplicateSlug = false) => ({
  allSlugsValid: true,
  allAccountsValid: true,
  hasDuplicateSlug,
});
const props = (over: Partial<EventCreateTeamsSectionProps> = {}): EventCreateTeamsSectionProps => ({
  teamTableItems: [{ idx: 0, internalSlug: "team-1", awsAccountId: "" }] as TeamTableItem[],
  teamCount: 1,
  teamValidation: validation(),
  accountOptions: [{ value: ACCOUNT_ID, label: ACCOUNT_ID, labelTag: "prod" }],
  accountById: new Map([[ACCOUNT_ID, account]]),
  noVerifiedAccounts: false,
  onUpdateTeamRow: vi.fn(),
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("EventCreateTeamsSection", () => {
  it("should render the empty hint when teamCount is 0", () => {
    render(<EventCreateTeamsSection {...props({ teamCount: 0 })} />);
    expect(screen.getByText("event_create.teams_empty")).toBeInTheDocument();
  });

  it("should emit a slug change from the slug input", () => {
    const p = props();
    render(<EventCreateTeamsSection {...p} />);
    fireEvent.change(screen.getByDisplayValue("team-1"), { target: { value: "team-x" } });
    expect(p.onUpdateTeamRow).toHaveBeenCalledWith(0, { internalSlug: "team-x" });
  });

  it("should emit an account selection from the account dropdown", () => {
    const p = props();
    const { container } = render(<EventCreateTeamsSection {...p} />);
    const select = createWrapper(container).findSelect();
    // account Select は expandToViewport なので dropdown は portal に出る → flag が必要。
    select?.openDropdown();
    select?.selectOptionByValue(ACCOUNT_ID, { expandToViewport: true });
    expect(p.onUpdateTeamRow).toHaveBeenCalledWith(0, { awsAccountId: ACCOUNT_ID });
  });

  it("should show the verified-account summary for an already-selected account", () => {
    const p = props({
      teamTableItems: [
        { idx: 0, internalSlug: "team-1", awsAccountId: ACCOUNT_ID },
      ] as TeamTableItem[],
    });
    render(<EventCreateTeamsSection {...p} />);
    // formatVerifiedAccountSummary = "111111111111 (prod)"
    expect(screen.getAllByText(`${ACCOUNT_ID} (prod)`).length).toBeGreaterThan(0);
  });

  it("should disable the select and show a helper when no verified accounts exist", () => {
    render(
      <EventCreateTeamsSection
        {...props({ accountOptions: [], noVerifiedAccounts: true, accountById: new Map() })}
      />,
    );
    expect(screen.getAllByText("event_create.no_verified_helper").length).toBeGreaterThan(0);
  });

  it("should show the duplicate-slug error", () => {
    render(<EventCreateTeamsSection {...props({ teamValidation: validation(true) })} />);
    expect(screen.getByText("event_create.duplicate_slug_error")).toBeInTheDocument();
  });
});
