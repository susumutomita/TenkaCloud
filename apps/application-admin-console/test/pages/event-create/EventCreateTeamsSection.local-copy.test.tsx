import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EventCreateTeamsSection,
  type EventCreateTeamsSectionProps,
} from "../../../src/pages/event-create/EventCreateTeamsSection";
import type { TeamTableItem } from "../../../src/pages/event-create/helpers";

vi.mock("../../../src/i18n", async () => {
  const en = (await import("../../../src/i18n/locales/en.json")).default as Record<string, unknown>;
  const resolve = (key: string): string => {
    const v = key
      .split(".")
      .reduce<unknown>(
        (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
        en,
      );
    return typeof v === "string" ? v : key;
  };
  return {
    useT: () => (key: string, params?: Record<string, string | number>) => {
      let s = resolve(key);
      if (params)
        for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
      return s;
    },
  };
});

const props = (over: Partial<EventCreateTeamsSectionProps> = {}): EventCreateTeamsSectionProps => ({
  teamTableItems: [
    { idx: 0, internalSlug: "team-1", awsAccountId: "" },
    { idx: 1, internalSlug: "team-2", awsAccountId: "" },
  ] as TeamTableItem[],
  teamCount: 2,
  teamValidation: { allSlugsValid: true, allAccountsValid: true, hasDuplicateSlug: false },
  accountOptions: [],
  accountById: new Map(),
  noVerifiedAccounts: false,
  onUpdateTeamRow: vi.fn(),
  ...over,
});

describe("EventCreateTeamsSection local-hosting copy", () => {
  it("should not mention deploy destinations or Cloud connections when providerMode is local", () => {
    render(
      <EventCreateTeamsSection
        {...props({
          teamValidation: { ...props().teamValidation, providerMode: { kind: "local" } },
        })}
      />,
    );
    expect(
      screen.getByText(
        "Every team plays this event on this computer. Give each team a short internal ID; it cannot be changed after deploy.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Cloud connections/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deploy destination/i)).not.toBeInTheDocument();
  });

  it("should keep the cloud description (deploy destination / Cloud connections) outside local hosting", () => {
    render(<EventCreateTeamsSection {...props()} />);
    expect(
      screen.getByText(
        "Choose each team's deploy destination for every selected problem target. AWS uses a verified account; non-AWS targets use a team credential slug registered under Cloud connections. A team's internal ID cannot be changed after deploy.",
      ),
    ).toBeInTheDocument();
  });

  it("should give each internal-ID input a distinct accessible name instead of the shared 'team-1' placeholder", () => {
    render(<EventCreateTeamsSection {...props()} />);
    expect(screen.getByRole("textbox", { name: "Internal ID, team 1" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Internal ID, team 2" })).toBeInTheDocument();
  });
});
