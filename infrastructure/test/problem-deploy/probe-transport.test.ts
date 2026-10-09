/* eslint-disable sonarjs/no-hardcoded-ip, sonarjs/no-clear-text-protocols -- DNS/IP and HTTP-policy fixtures use mocked lookup/request only; no network or credentials. */
import * as dns from "node:dns";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pinnedProbeLookup,
  probeTransport,
} from "../../lib/problem-deploy/runtime-clients/probe-transport";

function answerDns(answers: dns.LookupAddress[], error: NodeJS.ErrnoException | null = null) {
  return vi.spyOn(dns, "lookup").mockImplementation(((_host, _options, callback) => {
    callback(error, answers);
  }) as typeof dns.lookup);
}
function resolvePinned(all = false, family = 0): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pinnedProbeLookup("team.example.com", { all, family }, (error, address, resolvedFamily) => {
      if (error) reject(error);
      else resolve({ address, family: resolvedFamily });
    });
  });
}
afterEach(() => vi.restoreAllMocks());

describe("socket DNS answers", () => {
  it.each([
    "127.2.3.4",
    "::1",
    "::ffff:7f02:304",
    "0:0:0:0:0:ffff:7f02:0304",
    "0:0:0:0:0:0:0:1",
    "169.254.169.254",
    "169.254.170.2",
    "fd00:ec2::254",
  ])("rejects %s", async (address) => {
    answerDns([{ address, family: address.includes(":") ? 6 : 4 }]);
    await expect(resolvePinned()).rejects.toThrow("Unsafe probe DNS answer");
  });
  it("rejects mixed safe and forbidden answers before returning any address", async () => {
    answerDns([
      { address: "10.1.2.3", family: 4 },
      { address: "127.0.0.2", family: 4 },
    ]);
    await expect(resolvePinned(true)).rejects.toThrow("Unsafe probe DNS answer");
  });
  it("hands checked IPv4/IPv6 answers directly to connect without another DNS lookup", async () => {
    const answers = [
      { address: "10.1.2.3", family: 4 },
      { address: "2001:db8::1", family: 6 },
    ];
    const dnsSpy = answerDns(answers);
    expect(await resolvePinned(true)).toEqual({ address: answers, family: undefined });
    expect(dnsSpy).toHaveBeenCalledTimes(1);
  });
  it.each(["10.1.2.3", "172.16.0.2", "192.168.1.2"])(
    "retains private target %s",
    async (address) => {
      answerDns([{ address, family: 4 }]);
      expect(await resolvePinned()).toEqual({ address, family: 4 });
    },
  );
  it("does not silently fall back on resolver error or missing family", async () => {
    answerDns([], new Error("DNS failure"));
    await expect(resolvePinned()).rejects.toThrow("DNS failure");
    vi.restoreAllMocks();
    answerDns([{ address: "10.1.2.3", family: 4 }]);
    await expect(resolvePinned(false, 6)).rejects.toThrow("No matching probe DNS answer");
  });
  it.each(
    [[], [{ address: "not-an-address", family: 4 }], [{ address: "10.1.2.3", family: 6 }]].map(
      (answers) => [answers],
    ),
  )("rejects invalid resolution %#", async (answers) => {
    answerDns(answers);
    await expect(resolvePinned()).rejects.toThrow("Unsafe probe DNS answer");
  });
});

function fakeHttp(
  body: string | Buffer = "ok",
  status = 200,
  headers: Record<string, string> = {},
) {
  const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  const response = Object.assign(Readable.from([Buffer.from(body)]), {
    statusCode: status,
    headers,
  });
  const impl = ((_url, _options, callback) => {
    queueMicrotask(() => callback(response));
    return req;
  }) as typeof http.request;
  return { req, response, impl };
}

describe("pinned HTTP transport", () => {
  it("native HTTP request rejects a forbidden DNS answer before connect", async () => {
    const native = await vi.importActual<typeof import("node:http")>("node:http");
    vi.spyOn(http, "request").mockImplementation(native.request);
    const dnsSpy = answerDns([{ address: "127.0.0.2", family: 4 }]);
    await expect(probeTransport.fetch("http://team.example.invalid/", {})).rejects.toThrow(
      "Unsafe probe DNS answer",
    );
    expect(dnsSpy).toHaveBeenCalledTimes(1);
  });
  it("uses a per-request checked lookup and retains the original hostname", async () => {
    const fixture = fakeHttp();
    const request = vi.spyOn(http, "request").mockImplementation(fixture.impl);
    const signal = new AbortController().signal;
    const response = await probeTransport.fetch("http://team.example.com:8080/health", {
      signal,
      method: "GET",
    });
    expect(await response.text()).toBe("ok");
    expect(request.mock.calls[0]?.[0]).toEqual(new URL("http://team.example.com:8080/health"));
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      agent: false,
      lookup: pinnedProbeLookup,
      signal,
      method: "GET",
    });
    expect(fixture.req.end).toHaveBeenCalledWith(undefined);
  });
  it("retains hostname for HTTPS certificate/SNI checks and forwards POST body", async () => {
    const fixture = fakeHttp("redirect", 307, { location: "/next" });
    const request = vi.spyOn(https, "request").mockImplementation(fixture.impl);
    const response = await probeTransport.fetch("https://team.example.com/submit", {
      method: "POST",
      body: "data",
      headers: { "content-type": "application/json" },
    });
    expect(request.mock.calls[0]?.[0]).toEqual(new URL("https://team.example.com/submit"));
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("rejectUnauthorized", false);
    expect(response.headers.get("location")).toBe("/next");
    expect(fixture.req.end).toHaveBeenCalledWith("data");
    await response.body?.cancel();
  });
  it.each([
    "http://127.0.0.2/",
    "http://[::ffff:127.2.3.4]/",
    "file:///secret",
    "https://user:pass@team.example.com/",
  ])("does not request %s", async (url) => {
    const request = vi.spyOn(http, "request");
    const secure = vi.spyOn(https, "request");
    await expect(probeTransport.fetch(url, {})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(secure).not.toHaveBeenCalled();
  });
  it.each([204, 205, 304])("handles bodyless status %s", async (status) => {
    const fixture = fakeHttp("", status);
    vi.spyOn(http, "request").mockImplementation(fixture.impl);
    const response = await probeTransport.fetch("http://team.example.com/", {});
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(fixture.response.destroyed).toBe(true);
  });
  it("decompresses forced gzip and cancels the underlying HTTP response", async () => {
    const fixture = fakeHttp(gzipSync("compressed"), 200, { "content-encoding": "gzip" });
    vi.spyOn(http, "request").mockImplementation(fixture.impl);
    const response = await probeTransport.fetch("http://team.example.com/", {});
    expect(await response.text()).toBe("compressed");
    expect(fixture.response.destroyed).toBe(true);
  });
  it.each([600, 999])(
    "rejects non-Fetch status %s without an uncaught exception",
    async (status) => {
      const fixture = fakeHttp("", status);
      vi.spyOn(http, "request").mockImplementation(fixture.impl);
      await expect(probeTransport.fetch("http://team.example.com/", {})).rejects.toThrow();
      expect(fixture.response.destroyed).toBe(true);
    },
  );
  it("propagates request failure", async () => {
    const fixture = fakeHttp();
    vi.spyOn(http, "request").mockImplementation((() => {
      queueMicrotask(() => fixture.req.emit("error", new Error("connection failed")));
      return fixture.req;
    }) as typeof http.request);
    await expect(probeTransport.fetch("http://team.example.com/", {})).rejects.toThrow(
      "connection failed",
    );
  });
});

vi.mock("node:dns", async (original) => ({
  ...(await original<typeof import("node:dns")>()),
  lookup: vi.fn(),
}));
vi.mock("node:http", async (original) => ({
  ...(await original<typeof import("node:http")>()),
  request: vi.fn(),
}));
vi.mock("node:https", async (original) => ({
  ...(await original<typeof import("node:https")>()),
  request: vi.fn(),
}));
