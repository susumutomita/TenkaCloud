import { expect, mock, test } from "bun:test";
import { HostError } from "../model";
import { connectSimulatorConsole } from "../simulator-console";

const endpoint = "http://127.0.0.1:4566";
const code = "h".repeat(64);
const input = {
  credentials: {
    accessKeyId: "TCSIMASIA-synthetic-viewer",
    secretAccessKey: "synthetic-viewer-secret",
    sessionToken: "synthetic-viewer-session",
    expiration: new Date(Date.now() + 3600_000),
  },
  parameterName: "/tc-hello-world-alpha/hello",
  region: "ap-northeast-1",
};

function fixture(reply?: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const guard = mock(() => undefined);
  const http = mock(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/capabilities"))
      return Response.json({ consoleHandoff: { version: 1, services: ["ssm-parameter"] } });
    return (
      reply?.() ??
      Response.json({ Code: code, ExpiresAt: new Date(Date.now() + 30_000).toISOString() })
    );
  });
  return { calls, guard, http };
}

test("native handoff signs only the retained parameter with viewer credentials and returns a local fragment URL", async () => {
  const f = fixture();
  const issue = await connectSimulatorConsole(
    endpoint,
    "synthetic-operator-token",
    f.guard,
    f.http,
  );
  expect(issue).toBeDefined();
  const current = mock(() => undefined);
  expect(await issue?.(input, current)).toBe(`${endpoint}/_simulator/login#handoff=${code}`);
  expect(f.calls).toHaveLength(2);
  const handoff = f.calls[1];
  expect(handoff?.url).toBe(`${endpoint}/_simulator/v1/console-handoffs`);
  expect(handoff?.init.method).toBe("POST");
  expect(handoff?.init.redirect).toBe("error");
  expect(handoff?.init.body).toBe(
    JSON.stringify({ ParameterName: input.parameterName, Region: input.region }),
  );
  const headers = new Headers(handoff?.init.headers);
  expect(headers.get("authorization")).toContain("Credential=TCSIMASIA-synthetic-viewer/");
  expect(headers.get("authorization")).toContain("/ap-northeast-1/sts/aws4_request");
  expect(headers.get("x-amz-security-token")).toBe(input.credentials.sessionToken);
  expect(headers.has("x-simulator-token")).toBe(false);
  expect(JSON.stringify(handoff)).not.toContain("synthetic-operator-token");
  expect(current).toHaveBeenCalledTimes(3);
});

test("older Simulator keeps CLI available without advertising an unimplemented console", async () => {
  const http = mock(async () => Response.json({ protocolVersion: "2026-11-03" }));
  expect(
    await connectSimulatorConsole(endpoint, "synthetic", () => undefined, http),
  ).toBeUndefined();
  expect(http).toHaveBeenCalledTimes(1);
});

test("native RFC3339 expiry accepts local timezone offsets without changing the lifetime bound", async () => {
  const localExpiry = new Date(Date.now() + 30_000 + 9 * 3600_000)
    .toISOString()
    .replace(/Z$/u, "+09:00");
  const f = fixture(() => Response.json({ Code: code, ExpiresAt: localExpiry }));
  const issue = await connectSimulatorConsole(endpoint, "synthetic", f.guard, f.http);
  expect(await issue?.(input, () => undefined)).toBe(
    `${endpoint}/_simulator/login#handoff=${code}`,
  );
});

test("capability lookup never follows redirects or accepts arbitrary destinations", async () => {
  const f = fixture();
  await expect(
    connectSimulatorConsole("https://evil.example", "synthetic", f.guard, f.http),
  ).rejects.toThrow("numeric loopback");
  expect(f.http).not.toHaveBeenCalled();
  const redirect = mock(
    async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
  );
  await expect(connectSimulatorConsole(endpoint, "synthetic", f.guard, redirect)).rejects.toThrow(
    "Could not verify",
  );
  expect(redirect).toHaveBeenCalledTimes(1);
});

for (const [name, reply] of Object.entries({
  failure: () => new Response("SECRET_SERVER_DIAGNOSTIC", { status: 403 }),
  malformed: () =>
    Response.json({
      Code: "https://evil.example",
      ExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    }),
  expired: () => Response.json({ Code: code, ExpiresAt: new Date(0).toISOString() }),
  unbounded: () =>
    Response.json({ Code: code, ExpiresAt: new Date(Date.now() + 3600_000).toISOString() }),
  oversized: () => new Response("x".repeat(5000)),
})) {
  test(`invalid handoff is rejected without reflecting secret diagnostics: ${name}`, async () => {
    const f = fixture(reply);
    const issue = await connectSimulatorConsole(endpoint, "synthetic", f.guard, f.http);
    await expect(issue?.(input, () => undefined)).rejects.toMatchObject({
      status: 502,
      kind: "simulator_console_failed",
    });
  });
}

test("event withdrawal and late proxy changes stop handoff without publishing the code", async () => {
  const f = fixture();
  const issue = await connectSimulatorConsole(endpoint, "synthetic", f.guard, f.http);
  let checks = 0;
  await expect(
    issue?.(input, () => {
      if (++checks === 3) throw new HostError(409, "Event ended.", "scoring_ended");
    }),
  ).rejects.toMatchObject({ kind: "scoring_ended" });
  f.guard.mockImplementation(() => {
    throw new Error("Proxy settings changed; no request was sent.");
  });
  await expect(issue?.(input, () => undefined)).rejects.toThrow("no request was sent");
  expect(f.calls).toHaveLength(2);
});
