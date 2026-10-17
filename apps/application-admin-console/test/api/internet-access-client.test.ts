import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client";
import {
  approveInternetAccess,
  fetchInternetAccess,
  revokeInternetAccess,
} from "../../src/api/internet-access-client";

afterEach(() => vi.unstubAllGlobals());
it("sends literal Internet access GET, PUT requestIds and DELETE requests", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  vi.stubGlobal("fetch", fetch);
  const api = createApiClient("http://localhost/api", "a.e30.c");
  await fetchInternetAccess(api, "event");
  await approveInternetAccess(api, "event", "problem", ["one", "two"]);
  await revokeInternetAccess(api, "event", "problem");
  expect(
    fetch.mock.calls.map(([url, options]) => ({
      url: String(url),
      method: options.method ?? "GET",
      body: options.body,
    })),
  ).toEqual([
    { url: "http://localhost/api/events/event/internet-access", method: "GET", body: undefined },
    {
      url: "http://localhost/api/events/event/internet-access/problem",
      method: "PUT",
      body: '{"requestIds":["one","two"]}',
    },
    {
      url: "http://localhost/api/events/event/internet-access/problem",
      method: "DELETE",
      body: undefined,
    },
  ]);
});
