import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadRegistration,
  registrationInfoSchema,
  registrationProgressSchema,
  registrationRequest,
  registrationStorage,
} from "../src/api/registration-client";

const base = "https://api.example.com/";
const invitation = "i".repeat(43);
const teamLoginKey = "k".repeat(43);
const info = { name: "AWS Battle", state: "open", remaining: 2 };
const progress = {
  eventName: "AWS Battle",
  teamId: "team-1",
  state: "ready",
  ready: 1,
  total: 1,
  teamLoginKey,
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/join/tenant/event");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("registrationRequest", () => {
  it("keeps credentials out of URLs and forwards the receipt and cancellation signal", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(progress));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const receipt = registrationStorage("tenant", "event").ensureReceipt();

    await expect(
      registrationRequest(
        base,
        "tenant/one",
        "event?two",
        "claim",
        invitation,
        registrationProgressSchema,
        receipt,
        controller.signal,
      ),
    ).resolves.toEqual(progress);

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.com/portal/registration/tenant%2Fone/event%3Ftwo/claim",
      {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${invitation}`, "Content-Type": "application/json" },
        body: JSON.stringify({ receipt }),
      },
    );
  });

  it.each([
    [404, { error: "not_found" }, "not_found"],
    [410, { error: "closed" }, "closed"],
    [409, { error: "full" }, "full"],
    [429, { error: "rate_limited" }, "rate_limited"],
    [503, { message: "unavailable" }, "registration_unavailable"],
    [500, { error: 123 }, "registration_unavailable"],
  ])("rejects HTTP %s without returning a successful registration", async (status, body, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body, status)));
    await expect(
      registrationRequest(base, "tenant", "event", "info", invitation, registrationInfoSchema),
    ).rejects.toThrow(code);
  });

  it("rejects malformed successful responses instead of inventing ready credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ ...progress, teamLoginKey: undefined })),
    );
    await expect(
      registrationRequest(
        base,
        "tenant",
        "event",
        "status",
        invitation,
        registrationProgressSchema,
      ),
    ).rejects.toThrow();
    expect(registrationInfoSchema.safeParse({ ...info, remaining: -1 }).success).toBe(false);
  });

  it("propagates connection and unreadable-response failures", async () => {
    const disconnected = new Error("connection lost");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(disconnected));
    await expect(
      registrationRequest(base, "tenant", "event", "info", invitation, registrationInfoSchema),
    ).rejects.toBe(disconnected);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("upstream unavailable", { status: 502 })),
    );
    await expect(
      registrationRequest(base, "tenant", "event", "info", invitation, registrationInfoSchema),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("registrationStorage", () => {
  it("consumes the invitation fragment once, preserves the query and restores it in the same tab", () => {
    window.history.replaceState({}, "", `/join/tenant/event?source=event#invite=${invitation}`);
    expect(registrationStorage("tenant", "event").invitation()).toBe(invitation);
    expect(window.location.pathname + window.location.search).toBe(
      "/join/tenant/event?source=event",
    );
    expect(window.location.hash).toBe("");
    expect(registrationStorage("tenant", "event").invitation()).toBe(invitation);
    expect(registrationStorage("tenant", "another-event").invitation()).toBeNull();
    expect(registrationStorage("another-tenant", "event").invitation()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("rejects an invalid invitation without replacing a previously saved one", () => {
    const storage = registrationStorage("tenant", "event");
    window.history.replaceState({}, "", `/join/tenant/event#invite=${invitation}`);
    expect(storage.invitation()).toBe(invitation);
    window.history.replaceState({}, "", "/join/tenant/event#invite=invalid");
    expect(() => storage.invitation()).toThrow("not_found");
    window.history.replaceState({}, "", "/join/tenant/event");
    expect(storage.invitation()).toBe(invitation);
  });

  it("reuses a durable receipt after tab storage is cleared, scoped to the same tenant and event", () => {
    const receipt = registrationStorage("tenant", "event").ensureReceipt();
    expect(receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    sessionStorage.clear();
    const reloaded = registrationStorage("tenant", "event");
    expect(reloaded.receipt()).toBe(receipt);
    expect(reloaded.ensureReceipt()).toBe(receipt);
    expect(reloaded.invitation()).toBeNull();
    expect(registrationStorage("tenant", "another-event").receipt()).toBeNull();
    expect(registrationStorage("another-tenant", "event").receipt()).toBeNull();
  });

  it("discards a corrupt saved receipt and generates a recoverable replacement", () => {
    localStorage.setItem("tenkacloud.registration.tenant.event.receipt", "corrupted");
    const storage = registrationStorage("tenant", "event");
    expect(storage.receipt()).toBeNull();
    const receipt = storage.ensureReceipt();
    expect(receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(registrationStorage("tenant", "event").receipt()).toBe(receipt);
    expect(storage.ensureReceipt()).toBe(receipt);
  });
});

describe("loadRegistration", () => {
  it("restores an existing reservation with its receipt even without an invitation", async () => {
    const receipt = registrationStorage("tenant", "event").ensureReceipt();
    const fetcher = vi.fn().mockResolvedValue(response(progress));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    await expect(loadRegistration(base, "tenant", "event", controller.signal)).resolves.toEqual({
      invitation: null,
      progress,
      info: null,
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://api.example.com/portal/registration/tenant/event/status",
      expect.objectContaining({
        signal: controller.signal,
        headers: { Authorization: `Bearer ${receipt}`, "Content-Type": "application/json" },
        body: "{}",
      }),
    );
  });

  it("falls back to invitation info for an unclaimed receipt and keeps it for the next claim", async () => {
    window.history.replaceState({}, "", `/join/tenant/event#invite=${invitation}`);
    const receipt = registrationStorage("tenant", "event").ensureReceipt();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ error: "not_found" }, 404))
      .mockResolvedValueOnce(response(info));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    await expect(loadRegistration(base, "tenant", "event", controller.signal)).resolves.toEqual({
      invitation,
      info,
      progress: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://api.example.com/portal/registration/tenant/event/info",
      expect.objectContaining({
        signal: controller.signal,
        headers: { Authorization: `Bearer ${invitation}`, "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(registrationStorage("tenant", "event").ensureReceipt()).toBe(receipt);
  });

  it.each([
    new Error("registration_unavailable"),
    "connection interrupted",
  ])("preserves a reservation on a status failure instead of attempting a new signup: %s", async (cause) => {
    window.history.replaceState({}, "", `/join/tenant/event#invite=${invitation}`);
    const receipt = registrationStorage("tenant", "event").ensureReceipt();
    const fetcher = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("fetch", fetcher);
    await expect(
      loadRegistration(base, "tenant", "event", new AbortController().signal),
    ).rejects.toBe(cause);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(registrationStorage("tenant", "event").receipt()).toBe(receipt);
  });

  it("rejects a missing invitation before making an unauthenticated request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      loadRegistration(base, "tenant", "event", new AbortController().signal),
    ).rejects.toThrow("not_found");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
