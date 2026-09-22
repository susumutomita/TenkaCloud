import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
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
const httpError = (code: string, status = 409) =>
  new Response(JSON.stringify({ error: code }), { status });
function NextEvent() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/join/tenant/next")}>
      別のイベントへ
    </button>
  );
}
function mount(overrides: Partial<AppConfig> = {}) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/join/tenant/event"]}>
        <Routes>
          <Route
            path="/join/:tenantId/:eventId"
            element={<JoinPage config={{ ...config, ...overrides }} />}
          />
          <Route path="/setup" element={<h1>チーム名を決める</h1>} />
        </Routes>
        <NextEvent />
      </MemoryRouter>
    </I18nProvider>,
  );
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  login.mockReset();
  login.mockResolvedValue(undefined);
  localStorage.setItem("tenkacloud.portal.locale", "ja");
  window.history.replaceState({}, "", `/join/tenant/event#invite=${invitation}`);
});
afterEach(() => {
  vi.useRealTimers();
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

  it.each([
    ["full", "用意した環境がすべて割り当てられました。主催者へ連絡してください。"],
    ["closed", "参加受付は終了しています。"],
  ])("prevents a reservation when registration is %s", async (state, message) => {
    const fetcher = vi.fn().mockResolvedValue(ok({ name: "AWS Battle", state, remaining: 0 }));
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(await screen.findByText(message)).toBeInTheDocument();
    const claim = screen.getByRole("button", { name: "チームの環境を受け取る" });
    expect(claim).toBeDisabled();
    fireEvent.click(claim);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(registrationStorage("tenant", "event").receipt()).toBeNull();
    expect(login).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", "参加リンクを確認できません。主催者から届いた最新のリンクを開いてください。"],
    ["closed", "このイベントの受付または利用期間は終了しました。主催者へ確認してください。"],
  ])("explains unavailable or expired invitations (%s)", async (code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(httpError(code, 410)));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "もう一度確認する" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "チームの環境を受け取る" }),
    ).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("recovers from an initial connection failure without making a reservation", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce("connection unavailable")
      .mockResolvedValueOnce(ok({ name: "AWS Battle", state: "open", remaining: 2 }));
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("通信または保存に失敗しました。");
    fireEvent.click(screen.getByRole("button", { name: "もう一度確認する" }));
    expect(await screen.findByRole("button", { name: "チームの環境を受け取る" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith("/info"))).toBe(true);
    expect(registrationStorage("tenant", "event").receipt()).toBeNull();
  });

  it.each([
    ["full", "満員です。主催者へ追加の環境を確認してください。"],
    ["closed", "このイベントの受付または利用期間は終了しました。主催者へ確認してください。"],
    ["conflict", "申込みが重なりました。もう一度確認してください。枠は二重に割り当てません。"],
    ["rate_limited", "少し待ってから、もう一度確認してください。"],
  ])("reports %s when availability changes during a claim", async (code, message) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok({ name: "AWS Battle", state: "open", remaining: 1 }))
      .mockResolvedValueOnce(httpError(code));
    vi.stubGlobal("fetch", fetcher);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "チームの環境を受け取る" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "もう一度確認する" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "この環境で始める" })).not.toBeInTheDocument();
    expect(registrationStorage("tenant", "event").receipt()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    "failed",
    "unprepared",
  ])("rechecks the reserved environment after the organizer fixes a %s setup", async (state) => {
    const receipt = registrationStorage("tenant", "event").ensureReceipt();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok({ ...progress, state, ready: 0, teamLoginKey: undefined }))
      .mockResolvedValueOnce(ok(progress));
    vi.stubGlobal("fetch", fetcher);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "もう一度確認する" }));
    expect(await screen.findByRole("button", { name: "この環境で始める" })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toContain("/status");
      expect(init.headers.Authorization).toBe(`Bearer ${receipt}`);
    }
    expect(registrationStorage("tenant", "event").receipt()).toBe(receipt);
  });

  it("polls a preparing environment until ready and then stops", async () => {
    vi.useFakeTimers();
    registrationStorage("tenant", "event").ensureReceipt();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        ok({ ...progress, state: "preparing", ready: 0, teamLoginKey: undefined }),
      )
      .mockResolvedValueOnce(ok(progress));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => {
      mount();
    });
    expect(screen.getByRole("heading", { name: "環境を準備しています" })).toBeInTheDocument();
    expect(screen.getByText("準備完了 0 / 1 問")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "この環境で始める" })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("button", { name: "この環境で始める" })).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cancels future status polling when the participant leaves", async () => {
    vi.useFakeTimers();
    registrationStorage("tenant", "event").ensureReceipt();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        ok({ ...progress, state: "preparing", ready: 0, teamLoginKey: undefined }),
      );
    vi.stubGlobal("fetch", fetcher);
    let view: ReturnType<typeof mount> | undefined;
    await act(async () => {
      view = mount();
    });
    expect(screen.getByRole("heading", { name: "環境を準備しています" })).toBeInTheDocument();
    view?.unmount();
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "resolve",
    "reject",
  ])("ignores a stale status response that will %s after switching events", async (completion) => {
    registrationStorage("tenant", "event").ensureReceipt();
    registrationStorage("tenant", "next").ensureReceipt();
    let resolveOld: (value: Response) => void = (_value) => undefined;
    let rejectOld: (reason: Error) => void = (_reason) => undefined;
    const oldRequest = new Promise<Response>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce(ok({ ...progress, eventName: "Next Battle" }));
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("参加先を確認しています…");
    const signal: AbortSignal = fetcher.mock.calls[0]?.[1].signal;
    fireEvent.click(screen.getByRole("button", { name: "別のイベントへ" }));
    expect(await screen.findByRole("heading", { name: "Next Battle" })).toBeInTheDocument();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      if (completion === "resolve") resolveOld(ok(progress));
      else rejectOld(new Error("registration_unavailable"));
    });
    expect(screen.getByRole("heading", { name: "Next Battle" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AWS Battle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("allows login retry after authentication fails without allocating another environment", async () => {
    registrationStorage("tenant", "event").ensureReceipt();
    const fetcher = vi.fn().mockResolvedValue(ok(progress));
    vi.stubGlobal("fetch", fetcher);
    login.mockRejectedValueOnce(new Error("authentication unavailable"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "この環境で始める" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("通信または保存に失敗しました。");
    expect(screen.getByRole("button", { name: "この環境で始める" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "この環境で始める" }));
    expect(await screen.findByRole("heading", { name: "チーム名を決める" })).toBeInTheDocument();
    expect(login).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenNthCalledWith(2, key);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each<Partial<AppConfig>>([
    { mode: "dev-mock" },
    { cloudMode: "local" },
  ])("explains unsupported registration configuration %j without calling the API", async (overrides) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    mount(overrides);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "この参加リンクはAWS版のイベントで使用します。",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "チームの環境を受け取る" }),
    ).not.toBeInTheDocument();
  });
});
