import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeUrl } from "../../lib/problem-deploy/runtime-clients/http-probe-client";

describe("probe redirect を通信前に検査する", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(fetchMock, { preconnect: () => undefined }),
    );
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const redirect = (location: string, status = 302) =>
    new Response("redirect", { status, headers: { location } });

  it.each([
    "https://localhost./",
    "https://169.254.169.254/",
    "https://[::ffff:127.0.0.1]/",
    "file:///etc/passwd",
    "https://[",
  ])("redirect先 %s へfetchしないべき", async (location) => {
    fetchMock.mockResolvedValueOnce(redirect(location));
    const result = await probeUrl("https://team.example.com/", {
      readBody: true,
      expectStatus: [302],
    });
    expect(result.ok).toBe(false);
    expect(result.body).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });
  it("許可先を経由した後の禁止先も通信前に拒否するべき", async () => {
    fetchMock.mockResolvedValueOnce(redirect("/second"));
    fetchMock.mockResolvedValueOnce(redirect("https://metadata.google.internal./"));
    const result = await probeUrl("https://team.example.com/first");
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://team.example.com/second");
  });
  it("相対redirectとprivate教材先を許可しbody制限を保つべき", async () => {
    fetchMock.mockResolvedValueOnce(redirect("/second"));
    fetchMock.mockResolvedValueOnce(redirect("https://10.0.1.5/health"));
    fetchMock.mockResolvedValueOnce(new Response("a".repeat(5000)));
    const result = await probeUrl("https://team.example.com/first", { readBody: true });
    expect(result.ok).toBe(true);
    expect(result.body?.length).toBe(4096);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://10.0.1.5/health");
  });
  it.each([301, 302, 303])("POSTの%d redirectはGETへ変更するべき", async (status) => {
    fetchMock.mockResolvedValueOnce(redirect("/next", status));
    fetchMock.mockResolvedValueOnce(new Response("ok"));
    expect((await probeUrl("https://team.example.com/", { method: "POST", body: "data" })).ok).toBe(
      true,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: "data" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
    expect(fetchMock.mock.calls[1]?.[1].body).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[1].headers).toBeUndefined();
  });
  it.each([307, 308])("POSTの%d redirectはmethodとbodyを維持するべき", async (status) => {
    fetchMock.mockResolvedValueOnce(redirect("/next", status));
    fetchMock.mockResolvedValueOnce(new Response("ok"));
    expect((await probeUrl("https://team.example.com/", { method: "POST", body: "data" })).ok).toBe(
      true,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: "data" });
  });
  it("redirectのbodyは次hopの前にcancelするべき", async () => {
    const intermediate = redirect("/next");
    if (!intermediate.body) throw new Error("missing response body");
    const cancel = vi.spyOn(intermediate.body, "cancel");
    fetchMock.mockResolvedValueOnce(intermediate);
    fetchMock.mockImplementationOnce(async () => {
      expect(cancel).toHaveBeenCalledTimes(1);
      return new Response("ok");
    });
    expect((await probeUrl("https://team.example.com/")).ok).toBe(true);
  });
  it("redirect loopは上限で停止するべき", async () => {
    fetchMock.mockImplementation(async () => redirect("/loop"));
    expect((await probeUrl("https://team.example.com/")).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(21);
  });
  it("Locationなしredirectは通常のexpectStatus契約に従うべき", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no location", { status: 302 }));
    expect((await probeUrl("https://team.example.com/", { expectStatus: [302] })).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("途中の通信失敗で成功を返さないべき", async () => {
    fetchMock.mockResolvedValueOnce(redirect("/next"));
    fetchMock.mockRejectedValueOnce(new Error("connection failed"));
    expect((await probeUrl("https://team.example.com/")).ok).toBe(false);
  });
  it("timeout budgetとAbortSignalをhop全体で共有するべき", async () => {
    fetchMock.mockResolvedValueOnce(redirect("/next"));
    fetchMock.mockImplementationOnce(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    expect((await probeUrl("https://team.example.com/", { timeoutMs: 20 })).ok).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1].signal).toBe(fetchMock.mock.calls[1]?.[1].signal);
  });
});
