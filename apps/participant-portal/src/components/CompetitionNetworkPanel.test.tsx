import type { CompetitionNetworkView } from "@tenkacloud/portal-contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { CompetitionNetworkPanel } from "./CompetitionNetworkPanel";

const initial: CompetitionNetworkView = {
  supported: true,
  declared: [{ id: "web-demo", purpose: "Dedicated Web", published: false }],
  shared: [],
};
function response(view: CompetitionNetworkView = initial) {
  return Response.json(view);
}
function panel(enabled = true, problemId = "fixed-problem") {
  return (
    <I18nProvider>
      <CompetitionNetworkPanel
        enabled={enabled}
        apiBaseUrl="https://host.example.test/api/"
        sessionToken="team-key"
        problemId={problemId}
      />
    </I18nProvider>
  );
}
beforeEach(() => window.localStorage.setItem("tenkacloud.portal.locale", "en"));
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});
it("publishes only declared IDs with team auth, shows internal tuples as text, and withdraws", async () => {
  const published: CompetitionNetworkView = {
    ...initial,
    declared: [{ id: "web-demo", purpose: "Dedicated Web", published: true }],
    shared: [
      {
        teamId: "team-b",
        problemId: "peer",
        serviceId: "web",
        purpose: "Peer Web",
        // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic response tuple, never connected
        addresses: ["10.240.0.18", "fd33:1::2"],
        port: 8080,
        protocol: "tcp",
      },
    ],
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce(response(published))
    .mockResolvedValueOnce(response());
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  const { container } = render(panel());
  await screen.findByText("Dedicated Web");
  await user.click(screen.getByRole("button", { name: "Publish to teams" }));
  await screen.findByText("[fd33:1::2]:8080");
  expect(container.querySelectorAll("a")).toHaveLength(0);
  expect(container.querySelectorAll("input")).toHaveLength(0);
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    new URL("https://host.example.test/api/portal/me/problems/fixed-problem/network"),
    expect.objectContaining({
      method: "POST",
      headers: { authorization: "Bearer team-key", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ serviceId: "web-demo", published: true }),
    }),
  );
  await user.click(screen.getByRole("button", { name: "Stop publishing" }));
  await screen.findByRole("button", { name: "Publish to teams" });
  expect(fetcher).toHaveBeenNthCalledWith(
    3,
    expect.any(URL),
    expect.objectContaining({ body: JSON.stringify({ serviceId: "web-demo", published: false }) }),
  );
});
it("keeps state on failure and disables duplicate mutation and refresh while pending", async () => {
  let resolve: (value: Response) => void = (_value: Response) => {
    throw new Error("Request not started");
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response())
    .mockImplementationOnce(
      () =>
        new Promise<Response>((accept) => {
          resolve = accept;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(panel());
  const publish = await screen.findByRole("button", { name: "Publish to teams" });
  await user.click(publish);
  expect(publish).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  await act(async () => resolve(Response.json({ error: "not_running" }, { status: 409 })));
  await waitFor(() => expect(publish).toBeEnabled());
  expect(screen.queryByRole("button", { name: "Stop publishing" })).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "The network operation failed. Refresh the status; contact the organizer if it persists.",
    ),
  ).toBeInTheDocument();
});
it("reports failed reads, refreshes an empty declaration, and aborts unmounted reads", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(response({ supported: true, declared: [], shared: [] }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  const { unmount } = render(panel());
  await screen.findByText(
    "The network operation failed. Refresh the status; contact the organizer if it persists.",
  );
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(
      screen.queryByText(
        "The network operation failed. Refresh the status; contact the organizer if it persists.",
      ),
    ).not.toBeInTheDocument(),
  );
  expect(screen.queryByRole("button", { name: "Publish to teams" })).not.toBeInTheDocument();
  const [, init] = fetcher.mock.calls[0] ?? [];
  unmount();
  expect((init.signal as AbortSignal).aborted).toBe(true);
});
it("makes no request without the authenticated network capability", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(panel(false));
  expect(fetcher).not.toHaveBeenCalled();
});

it("discards a late publication result after changing the authenticated problem scope", async () => {
  let resolve: (value: Response) => void = (_value: Response) => {
    throw new Error("Request not started");
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response())
    .mockImplementationOnce(
      () =>
        new Promise<Response>((accept) => {
          resolve = accept;
        }),
    )
    .mockResolvedValueOnce(response({ supported: true, declared: [], shared: [] }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  const { rerender } = render(panel());
  await user.click(await screen.findByRole("button", { name: "Publish to teams" }));
  rerender(panel(true, "another-problem"));
  await screen.findByText("This catalog does not declare a public service for your environment.");
  await act(async () =>
    resolve(
      response({
        ...initial,
        declared: [{ id: "web-demo", purpose: "Old context", published: true }],
      }),
    ),
  );
  expect(screen.queryByText("Old context")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Stop publishing" })).not.toBeInTheDocument();
});
