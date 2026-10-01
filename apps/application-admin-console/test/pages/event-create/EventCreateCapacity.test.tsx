import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EventCreateCapacityNotice,
  eventCapacity,
  type HostCatalog,
} from "../../../src/pages/event-create/LocalHostEventCreate";

vi.mock("../../../src/i18n", () => ({
  useT: () => (key: string, values?: unknown) => `${key}:${JSON.stringify(values)}`,
}));
const catalog: HostCatalog = {
  supported: new Set(),
  cloud: new Set(),
  error: null,
  limits: { maxTeams: 40, maxEventJobs: 512 },
};
const limits = { maxTeams: 49, maxProblems: 50 };
describe("cloud creation capacity", () => {
  it("uses 49/50 backend bounds and admits the target 25-team event", () => {
    expect(eventCapacity(false, catalog, 25, 20, limits)).toMatchObject({
      available: true,
      teamCountInvalid: false,
      problemCountInvalid: false,
      maxTeams: 49,
    });
    expect(eventCapacity(false, catalog, 49, 50, limits)).toMatchObject({
      teamCountInvalid: false,
      problemCountInvalid: false,
    });
    expect(eventCapacity(false, catalog, 50, 50, limits).teamCountInvalid).toBe(true);
    expect(eventCapacity(false, catalog, 49, 51, limits).problemCountInvalid).toBe(true);
  });
  it("blocks creation when cloud limits are absent and shows a configuration error", () => {
    const capacity = eventCapacity(false, catalog, 1, 1, undefined);
    expect(capacity).toMatchObject({ available: false, teamCountInvalid: true });
    render(<EventCreateCapacityNotice local={false} catalog={catalog} capacity={capacity} />);
    expect(screen.getByText(/event_create.limits_unavailable/u)).toBeInTheDocument();
    expect(screen.queryByText(/local_host.create_header/u)).toBeNull();
  });
  it("explains the actual maximum when too many problems are selected", () => {
    render(
      <EventCreateCapacityNotice
        local={false}
        catalog={catalog}
        capacity={eventCapacity(false, catalog, 1, 51, limits)}
      />,
    );
    expect(screen.getByText('event_create.problem_count_invalid:{"max":50}')).toBeInTheDocument();
  });
});
