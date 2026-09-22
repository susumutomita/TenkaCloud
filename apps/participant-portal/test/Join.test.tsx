import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registrationStorage } from "../src/api/registration-client";
import type { AppConfig } from "../src/config";
import { I18nProvider } from "../src/i18n";
import { JoinPage } from "../src/pages/Join";

const { login } = vi.hoisted(() => ({ login: vi.fn(async () => undefined) }));
vi.mock("../src/auth/AuthProvider", () => ({ useAuth: () => ({ login }) }));
const config: AppConfig = {
  apiBaseUrl: "https://api.example.com",
  mode: "backend",
  cloudMode: "real",
  eventTitle: "Battle",
  eventRegion: "ap-northeast-1",
};
const invitation = "i".repeat(43);
const key = "k".repeat(43);
const progress = {
  eventName: "AWS Battle",
  teamId: "team-1",
  state: "ready",
  ready: 1,
  total: 1,
  teamLoginKey: key,
};
const ok = (value: unknown) => new Response(JSON.stringify(value));
function mount() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/join/tenant/event"]}>
        <Routes>
          <Route path="/join/:tenantId/:eventId" element={<JoinPage config={config} />} />
          <Route path="/setup" element={<h1>チーム名を決める</h1>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  login.mockClear();
  localStorage.setItem("tenkacloud.portal.locale", "ja");
  window.history.replaceState({}, "", `/join/tenant/event#invite=${invitation}`);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Join participant journey", () => {
  it("makes an explicit reservation then logs in with the returned team credential", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok({ name: "AWS Battle", state: "open", remaining: 2 }))
      .mockResolvedValueOnce(ok(progress));
    vi.stubGlobal("fetch", fetcher);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "チームの環境を受け取る" }));
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const stored = registrationStorage("tenant", "event").receipt();
    expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({ receipt: stored });
    fireEvent.click(await screen.findByRole("button", { name: "この環境で始める" }));
    expect(await screen.findByRole("heading", { name: "チーム名を決める" })).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith(key);
  });

  it("resumes from a receipt after reload without reserving another slot", async () => {
    const receipt = registrationStorage("tenant", "event").ensureReceipt();
    const fetcher = vi.fn().mockResolvedValue(ok(progress));
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(await screen.findByRole("button", { name: "この環境で始める" })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toContain("/status");
    expect(fetcher.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${receipt}`);
  });

  it("shows failure with retry and never offers entry to an unfinished environment", async () => {
    registrationStorage("tenant", "event").ensureReceipt();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(ok({ ...progress, state: "failed", ready: 0, teamLoginKey: undefined })),
    );
    mount();
    expect(await screen.findByRole("button", { name: "もう一度確認する" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "この環境で始める" })).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("keeps a receipt across a lost claim response so retry can recover it", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok({ name: "AWS Battle", state: "open", remaining: 2 }))
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(ok(progress));
    vi.stubGlobal("fetch", fetcher);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "チームの環境を受け取る" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const receipt = registrationStorage("tenant", "event").receipt();
    fireEvent.click(screen.getByRole("button", { name: "もう一度確認する" }));
    expect(await screen.findByRole("button", { name: "この環境で始める" })).toBeEnabled();
    expect(fetcher.mock.calls[2]?.[1].headers.Authorization).toBe(`Bearer ${receipt}`);
  });
});
