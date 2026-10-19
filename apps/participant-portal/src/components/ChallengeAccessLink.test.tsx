import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ChallengeAccessLink } from "./ChallengeAccessLink";

const stale = "https://exercise.example.test/__join?ticket=synthetic-stale";
const fresh = "https://exercise.example.test/__join?ticket=synthetic-fresh";
const props = {
  value: stale,
  label: "Web",
  jobId: "job-a",
  apiBaseUrl: "https://host.example.test/api/",
  sessionToken: "synthetic-team-key",
};
function panel(overrides: Partial<typeof props> = {}) {
  return (
    <I18nProvider>
      <ChallengeAccessLink {...props} {...overrides} />
    </I18nProvider>
  );
}
function teamView(url: string | undefined = fresh) {
  return Response.json({
    problems: [
      { jobId: "other-job", stackOutputs: { Web: stale } },
      { jobId: props.jobId, stackOutputs: url ? { Web: url } : {} },
    ],
  });
}
function popup() {
  const tab = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  return { tab, open };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("fetches a new authenticated handoff on each click without exposing the displayed ticket", async () => {
  const next = fresh.replace("synthetic-fresh", "synthetic-next");
  const fetcher = vi.fn().mockResolvedValueOnce(teamView()).mockResolvedValueOnce(teamView(next));
  vi.stubGlobal("fetch", fetcher);
  const { tab, open } = popup();
  const { container } = render(panel());
  const button = screen.getByRole("button", { name: "Open environment" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(container.innerHTML).not.toContain("synthetic-stale");
  expect(container.querySelector("a")).toBeNull();
  fireEvent.click(button);
  expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  expect(tab.opener).toBeNull();
  await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(fresh));
  expect(fetcher).toHaveBeenCalledWith(
    new URL("https://host.example.test/api/portal/me"),
    expect.objectContaining({
      headers: { authorization: "Bearer synthetic-team-key" },
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }),
  );
  fireEvent.click(button);
  await waitFor(() => expect(tab.location.replace).toHaveBeenLastCalledWith(next));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each(["network", "missing", "unsupported", "ordinary"])(
  "closes the blank tab and offers retry when the fresh handoff is %s",
  async (failure) => {
    const fetcher = vi.fn();
    if (failure === "network") fetcher.mockRejectedValue(new Error("synthetic failure"));
    else {
      const urls: Record<string, string> = {
        missing: "",
        unsupported: "data:text/plain,synthetic",
        ordinary: "https://exercise.example.test/",
      };
      fetcher.mockResolvedValue(teamView(urls[failure]));
    }
    vi.stubGlobal("fetch", fetcher);
    const { tab } = popup();
    render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Open environment" }));
    await screen.findByText(/Could not open the environment/);
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open environment" })).toBeEnabled();
  },
);

it("does not issue a ticket if the browser blocks the popup", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(window, "open").mockReturnValue(null);
  render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Open environment" }));
  await screen.findByText(/Could not open the environment/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("suppresses duplicate clicks and aborts and closes an unfinished handoff on unmount", async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn().mockReturnValue(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const { tab, open } = popup();
  const { unmount } = render(panel());
  const button = screen.getByRole("button", { name: "Open environment" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(open).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  expect(tab.close).toHaveBeenCalled();
  await act(async () => resolve(teamView()));
  expect(tab.location.replace).not.toHaveBeenCalled();
});

it("keeps fixed URLs as ordinary links without requesting the team view", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const url = "https://app.example.test/";
  render(panel({ value: url }));
  expect(screen.getByRole("link")).toHaveAttribute("href", url);
  expect(screen.getByRole("link")).toHaveAttribute("rel", "noreferrer noopener");
  expect(fetcher).not.toHaveBeenCalled();
});

it("cancels the previous authenticated scope when the session changes", async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn().mockReturnValue(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const { tab } = popup();
  const { rerender } = render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Open environment" }));
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  rerender(panel({ sessionToken: "synthetic-other-team-key" }));
  expect(signal.aborted).toBe(true);
  expect(tab.close).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Open environment" })).toBeEnabled();
  await act(async () => resolve(teamView()));
  expect(tab.location.replace).not.toHaveBeenCalled();
});
