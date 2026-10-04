import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantProblemView } from "../api/portal-client";
import { I18nProvider } from "../i18n";
import { HostContainerControls } from "./HostContainerControls";

type Session = NonNullable<ParticipantProblemView["containerSession"]>;
let serverSession: Session;
let requests: { path: string; method: string; body: unknown; authorization: string | null }[];
let refusal: { status: number; code: string } | undefined;
let deferStart: Promise<Response> | undefined;

function deferredResponse() {
  let completeResponse: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((complete) => {
    completeResponse = complete;
  });
  return {
    promise,
    resolve: (response: Response) => {
      if (!completeResponse) throw new Error("Response resolver was not initialized");
      completeResponse(response);
    },
  };
}

function Harness() {
  const [session, setSession] = useState<Session>({ status: "stopped" });
  const refresh = useCallback(async () => {
    const response = await fetch("http://localhost/api/portal/me");
    setSession((await response.json()).containerSession as Session);
  }, []);
  return (
    <HostContainerControls
      session={session}
      problemId="code-lab"
      apiBaseUrl="http://localhost/api"
      sessionToken="synthetic-team-key"
      onScored={refresh}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem("tenkacloud.portal.locale", "en");
  serverSession = { status: "stopped" };
  requests = [];
  refusal = undefined;
  deferStart = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const headers = new Headers(init?.headers);
      requests.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: headers.get("authorization"),
      });
      if (path === "/api/portal/me") return Response.json({ containerSession: serverSession });
      if (refusal) return Response.json({ error: refusal.code }, { status: refusal.status });
      if (path.endsWith("/container/start")) {
        if (deferStart) return deferStart;
        serverSession = { status: "starting" };
      } else if (path.endsWith("/container/stop")) serverSession = { status: "stopped" };
      else throw new Error(`Unexpected synthetic endpoint ${path}`);
      return Response.json({ accepted: true }, { status: 202 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const start = () => screen.getByRole("button", { name: "Start / resume" });
const stop = () => screen.getByRole("button", { name: "Stop (keep data)" });
function open() {
  render(
    <I18nProvider>
      <Harness />
    </I18nProvider>,
  );
}

describe("host container controls", () => {
  it("starts, polls authoritative status, stops and resumes through bounded control endpoints", async () => {
    open();
    await act(async () => {
      fireEvent.click(start());
    });
    expect(start()).toBeDisabled();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(requests[0]).toEqual({
      path: "/api/portal/me/problems/code-lab/container/start",
      method: "POST",
      body: {},
      authorization: "Bearer synthetic-team-key",
    });
    serverSession = { status: "running" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(stop()).toBeEnabled();
    await act(async () => {
      fireEvent.click(stop());
    });
    expect(start()).toBeEnabled();
    await act(async () => {
      fireEvent.click(start());
    });
    serverSession = { status: "running" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(stop()).toBeEnabled();
    expect(
      requests.filter((request) => request.method === "POST").map((request) => request.path),
    ).toEqual([
      "/api/portal/me/problems/code-lab/container/start",
      "/api/portal/me/problems/code-lab/container/stop",
      "/api/portal/me/problems/code-lab/container/start",
    ]);
    expect(
      requests.some((request) => request.path.includes("reset") || request.path.includes("delete")),
    ).toBe(false);
  });

  it.each([
    ["team_container_limit", "Your team has reached its active environment limit"],
    ["host_container_limit", "The host has reached its active environment limit"],
    ["host_container_memory_limit", "The host's container memory budget is full"],
    ["container_busy", "This environment is already changing"],
  ])(
    "shows an admission refusal without retrying or evicting another environment (%s)",
    async (code, message) => {
      refusal = { status: 409, code };
      open();
      await act(async () => {
        fireEvent.click(start());
      });
      expect(screen.getByText((value) => value.startsWith(message))).toBeInTheDocument();
      expect(start()).toBeEnabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(requests.some((request) => request.path.endsWith("/stop"))).toBe(false);
    },
  );

  it("does not duplicate a pending start or invent a successful running state", async () => {
    const pending = deferredResponse();
    deferStart = pending.promise;
    open();
    await act(async () => {
      fireEvent.click(start());
      fireEvent.click(start());
    });
    expect(start()).toBeDisabled();
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Stop (keep data)" })).toBeNull();
    serverSession = { status: "running" };
    await act(async () => {
      pending.resolve(Response.json({ accepted: true }, { status: 202 }));
    });
    expect(stop()).toBeEnabled();
  });
});
