import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import { inspectBattleCapability } from "../simulator-battle-capability";
import { receiveOwnedSimulatorClock } from "../simulator-clock-bootstrap";

const domain = `mono-${"a".repeat(32)}`;
const key = "b".repeat(64);
const path = "/_simulator/v1/battle-capabilities/availability";
const token = "operator".repeat(8);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function clock() {
  const pipe = new PassThrough();
  const pending = receiveOwnedSimulatorClock(pipe);
  pipe.end(`{"version":2,"domain":"${domain}","key":"${key}","clock":"linux-clock-monotonic"}\n`);
  return pending;
}
interface Options {
  wrong?: "domain" | "mac" | "nonce" | "body" | "status" | "path";
  protocolVersion?: number;
  configured?: boolean;
  elapsed?: number;
  failTransport?: boolean;
}
function signedResponse(nonce: string, request: Uint8Array, o: Options) {
  const body = new TextEncoder().encode(
    JSON.stringify({
      configured: o.configured ?? true,
      protocolVersion: o.protocolVersion ?? 2,
      clockDomain: domain,
    }),
  );
  const signNonce = o.wrong === "nonce" ? "d".repeat(64) : nonce;
  const signPath = o.wrong === "path" ? `${path}/foreign` : path;
  const mac = createHmac("sha256", Buffer.from(key, "hex"))
    .update(
      `TCS-RESPONSE-3\n${domain}\n${signNonce}\nPOST\n${signPath}\n${hash(request)}\n200\n${body.length}\n`,
    )
    .update(body)
    .digest("hex");
  return new Response(o.wrong === "body" ? new TextEncoder().encode("{}") : body, {
    status: o.wrong === "status" ? 201 : 200,
    headers: {
      "X-Simulator-Clock-Domain": o.wrong === "domain" ? `mono-${"d".repeat(32)}` : domain,
      "X-Simulator-Clock-MAC": o.wrong === "mac" ? "0".repeat(64) : mac,
    },
  });
}
async function fixture(o: Options = {}, endpoint = "http://127.0.0.1:12345") {
  const owned = await clock();
  let calls = 0,
    now = 0;
  const inspect = () =>
    inspectBattleCapability({ endpoint, region: "ap-northeast-1", readToken: () => token }, owned, {
      now: () => now,
      transport: async (target, init) => {
        calls++;
        expect(target.href).toBe(`http://127.0.0.1:12345${path}`);
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        const headers = new Headers(init.headers);
        expect(headers.get("X-Simulator-Token")).toBe(token);
        const nonce = headers.get("X-Simulator-Clock-Nonce") ?? "";
        expect(nonce).toMatch(/^[a-f0-9]{64}$/u);
        if (!(init.body instanceof ArrayBuffer)) throw new Error("Expected byte request");
        const request = new Uint8Array(init.body);
        expect(new TextDecoder().decode(request)).toBe('{"version":1}');
        now = o.elapsed ?? 1;
        if (o.failTransport) throw new Error("transport lost");
        return signedResponse(nonce, request, o);
      },
    });
  return { inspect, calls: () => calls };
}
test("authenticated configured availability does not grant scoring or Battle acceptance", async () => {
  const f = await fixture();
  expect(await f.inspect()).toEqual({
    kind: "authenticated-battle-availability",
    configured: true,
    scoringQualified: false,
    battleAcceptancePassed: false,
  });
  expect(f.calls()).toBe(1);
});
for (const wrong of ["domain", "mac", "nonce", "body", "status", "path"] as const) {
  test(`reject signed response ${wrong} mismatch without retry`, async () => {
    const f = await fixture({ wrong });
    await expect(f.inspect()).rejects.toThrow();
    expect(f.calls()).toBe(1);
  });
}
for (const [label, options] of [
  ["protocol one", { protocolVersion: 1 }],
  ["unconfigured", { configured: false }],
  ["exact 5 second deadline", { elapsed: 5000 }],
  ["late response", { elapsed: 5001 }],
  ["clock reversed", { elapsed: -1 }],
  ["transport failure", { failTransport: true }],
] as const) {
  test(`reject ${label} without retry`, async () => {
    const f = await fixture(options);
    await expect(f.inspect()).rejects.toThrow();
    expect(f.calls()).toBe(1);
  });
}
for (const endpoint of [
  "http://example.com:12345",
  "http://localhost:12345",
  "http://127.0.0.1:12345/foreign",
  "https://127.0.0.1:12345",
]) {
  test(`foreign endpoint rejected before transport: ${endpoint}`, async () => {
    const f = await fixture({}, endpoint);
    await expect(f.inspect()).rejects.toThrow("Owned numeric loopback");
    expect(f.calls()).toBe(0);
  });
}
