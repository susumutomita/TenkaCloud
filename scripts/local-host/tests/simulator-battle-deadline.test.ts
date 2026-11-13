import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import { requestBattleDeadline } from "../simulator-battle-deadline";
import { type OwnedSimulatorClock, receiveOwnedSimulatorClock } from "../simulator-clock-bootstrap";

const settings = {
  endpoint: "http://127.0.0.1:12345",
  region: "ap-northeast-1",
  readToken: () => "operator".repeat(8),
};
function fixture(
  options: {
    elapsed?: number;
    ticks?: number;
    validUntil?: number;
    rejectResponse?: boolean;
    rejectSample?: boolean;
  } = {},
) {
  let elapsed = 0;
  let calls = 0;
  let samples = 0;
  const clock: OwnedSimulatorClock = {
    domain: `mono-${"a".repeat(32)}`,
    authenticateResponse() {
      if (options.rejectResponse) throw new Error("invalid response signature");
    },
    authenticateSample(value, nonce) {
      samples++;
      expect(value).toEqual({ nonce });
      expect(nonce).toMatch(/^[a-f0-9]{64}$/u);
      if (options.rejectSample) throw new Error("invalid sample signature");
      return { ticksMs: options.ticks ?? 100_000, validUntilMs: options.validUntil ?? 130_000 };
    },
  };
  return {
    calls: () => calls,
    samples: () => samples,
    request: (budget = 8000) =>
      requestBattleDeadline(settings, clock, budget, {
        now: () => elapsed,
        transport: async (target, init) => {
          calls++;
          expect(target.pathname).toBe("/_simulator/v1/battle-capabilities/clock");
          if (!(init.body instanceof ArrayBuffer)) throw new Error("Expected byte request");
          const body = JSON.parse(new TextDecoder().decode(init.body)) as {
            version: number;
            nonce: string;
          };
          expect(body.version).toBe(2);
          elapsed = options.elapsed ?? 12.5;
          return new Response(JSON.stringify({ nonce: body.nonce }));
        },
      }),
  };
}
test("deadline charges the whole round trip, rounds conservatively and is immutable", async () => {
  const f = fixture();
  const deadline = await f.request();
  expect(deadline).toEqual({ domain: `mono-${"a".repeat(32)}`, ticksMs: 107_987 });
  expect(Object.isFrozen(deadline)).toBe(true);
  expect(f.calls()).toBe(1);
  expect(f.samples()).toBe(1);
});
for (const budget of [0, -1, 8001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`invalid probe budget ${budget} fails before transport`, async () => {
    const f = fixture();
    await expect(f.request(budget)).rejects.toThrow("budget must");
    expect(f.calls()).toBe(0);
  });
}
for (const elapsed of [-1, Number.NaN, Number.POSITIVE_INFINITY, 100, 99.1]) {
  test(`invalid or exhausted sample timing ${elapsed} fails without retry`, async () => {
    const f = fixture({ elapsed });
    await expect(f.request(100)).rejects.toThrow();
    expect(f.calls()).toBe(1);
  });
}
for (const options of [
  { rejectResponse: true },
  { rejectSample: true },
  { ticks: Number.MAX_SAFE_INTEGER },
  { validUntil: 100_001 },
]) {
  test(`untrusted or out-of-range sample ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await expect(f.request()).rejects.toThrow();
    expect(f.calls()).toBe(1);
  });
}
test("tiny valid budget remains possible without extending it", async () => {
  expect(await fixture({ elapsed: 0 }).request(1)).toEqual({
    domain: `mono-${"a".repeat(32)}`,
    ticksMs: 100_001,
  });
});

for (const tamperSample of [false, true]) {
  test(`composed private clock and signed response, tamper=${tamperSample}`, async () => {
    const domain = `mono-${"a".repeat(32)}`;
    const key = Buffer.from("b".repeat(64), "hex");
    const pipe = new PassThrough();
    const pending = receiveOwnedSimulatorClock(pipe);
    pipe.end(
      `{"version":2,"domain":"${domain}","key":"${key.toString("hex")}","clock":"linux-clock-monotonic"}\n`,
    );
    const clock = await pending;
    const mac = (text: string, body: Uint8Array = new Uint8Array()) =>
      createHmac("sha256", key).update(text).update(body).digest("hex");
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const deadline = requestBattleDeadline(settings, clock, 8000, {
      now: () => 0,
      transport: async (target, init) => {
        if (!(init.body instanceof ArrayBuffer)) throw new Error("Expected byte request");
        const request = new Uint8Array(init.body);
        const input = JSON.parse(new TextDecoder().decode(request)) as { nonce: string };
        const headerNonce = new Headers(init.headers).get("X-Simulator-Clock-Nonce");
        expect(input.nonce).not.toBe(headerNonce);
        const body = new TextEncoder().encode(
          JSON.stringify({
            version: 2,
            domain,
            nonce: input.nonce,
            ticksMs: 100_000,
            validUntilMs: 130_000,
            mac: tamperSample
              ? "0".repeat(64)
              : mac(`TCS-CLOCK-2\n${domain}\n${input.nonce}\n100000\n130000\n`),
          }),
        );
        return new Response(body, {
          headers: {
            "X-Simulator-Clock-Domain": domain,
            "X-Simulator-Clock-MAC": mac(
              `TCS-RESPONSE-3\n${domain}\n${headerNonce}\nPOST\n${target.pathname}\n${hash(request)}\n200\n${body.length}\n`,
              body,
            ),
          },
        });
      },
    });
    if (tamperSample)
      await expect(deadline).rejects.toThrow("Unauthenticated Simulator clock sample");
    else expect(await deadline).toEqual({ domain, ticksMs: 108_000 });
  });
}
