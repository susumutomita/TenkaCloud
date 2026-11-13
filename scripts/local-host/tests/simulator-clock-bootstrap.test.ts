import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import { receiveOwnedSimulatorClock } from "../simulator-clock-bootstrap";

const domain = `mono-${"a".repeat(32)}`;
const key = "b".repeat(64);
const nonce = "c".repeat(64);
const envelope = `{"version":2,"domain":"${domain}","key":"${key}","clock":"linux-clock-monotonic"}\n`;
function sample() {
  const ticksMs = 123456,
    validUntilMs = ticksMs + 30_000;
  const mac = createHmac("sha256", Buffer.from(key, "hex"))
    .update(`TCS-CLOCK-2\n${domain}\n${nonce}\n${ticksMs}\n${validUntilMs}\n`)
    .digest("hex");
  return { version: 2, domain, nonce, ticksMs, validUntilMs, mac };
}
async function receive(text = envelope) {
  const pipe = new PassThrough();
  const result = receiveOwnedSimulatorClock(pipe);
  pipe.end(Buffer.from(text));
  return result;
}
test("exact Go bootstrap authenticates a challenged HMAC sample without claiming clock calibration", async () => {
  const pipe = new PassThrough();
  const result = receiveOwnedSimulatorClock(pipe);
  pipe.write(Buffer.from(envelope.slice(0, 37)));
  pipe.end(Buffer.from(envelope.slice(37)));
  const clock = await result;
  expect(clock.domain).toBe(domain);
  expect(Object.isFrozen(clock)).toBe(true);
  expect(Object.keys(clock).sort()).toEqual([
    "authenticateResponse",
    "authenticateSample",
    "domain",
  ]);
  expect(clock.authenticateSample(sample(), nonce)).toEqual({
    ticksMs: 123456,
    validUntilMs: 153456,
  });
  expect(pipe.destroyed).toBe(true);
});
const invalidSamples: [string, Record<string, unknown>][] = [
  ["foreign domain", { domain: `mono-${"d".repeat(32)}` }],
  ["foreign nonce", { nonce: "d".repeat(64) }],
  ["tampered ticks", { ticksMs: 123457, validUntilMs: 153457 }],
  ["tampered MAC", { mac: "0".repeat(64) }],
  ["wrong interval", { validUntilMs: 153455 }],
  ["extra field", { key }],
  ["unsafe integer", { ticksMs: Number.MAX_SAFE_INTEGER + 1 }],
];
for (const [label, override] of invalidSamples) {
  test(`reject ${label}`, async () => {
    const clock = await receive();
    expect(() => clock.authenticateSample({ ...sample(), ...override }, nonce)).toThrow();
  });
}
test("malformed challenge is rejected", async () => {
  const clock = await receive();
  expect(() => clock.authenticateSample(sample(), "bad")).toThrow("Invalid Simulator clock sample");
});
for (const [label, text] of [
  ["duplicate JSON field", envelope.replace('"version":2,', '"version":2,"version":2,')],
  ["extra object", envelope + envelope],
  ["extra trailing newline", `${envelope}\n`],
  ["trailing garbage", `${envelope}garbage`],
  ["wrong clock", envelope.replace("linux-clock-monotonic", "wall-clock")],
  ["missing Go newline", envelope.trimEnd()],
] as const) {
  test(`reject bootstrap ${label}`, async () => {
    await expect(receive(text)).rejects.toThrow("Invalid private Simulator clock bootstrap");
  });
}
test("overflow destroys pipe and rejects without exposing bytes", async () => {
  const pipe = new PassThrough();
  const result = receiveOwnedSimulatorClock(pipe);
  pipe.write(Buffer.alloc(513, "x"));
  await expect(result).rejects.toThrow("exceeds bound");
  expect(pipe.destroyed).toBe(true);
});
test("complete data without EOF times out", async () => {
  const pipe = new PassThrough();
  const result = receiveOwnedSimulatorClock(pipe, undefined, 10);
  pipe.write(Buffer.from(envelope));
  await expect(result).rejects.toThrow("timed out");
  expect(pipe.destroyed).toBe(true);
});
test("premature close is not treated as EOF", async () => {
  const pipe = new PassThrough();
  const result = receiveOwnedSimulatorClock(pipe);
  pipe.write(Buffer.from(envelope));
  pipe.destroy();
  await expect(result).rejects.toThrow("closed before EOF");
});
test("abort cancels pending and already-aborted streams", async () => {
  for (const preAborted of [false, true]) {
    const pipe = new PassThrough();
    const controller = new AbortController();
    if (preAborted) controller.abort();
    const result = receiveOwnedSimulatorClock(pipe, controller.signal);
    if (!preAborted) controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    expect(pipe.destroyed).toBe(true);
  }
});
test("transport diagnostics are redacted", async () => {
  const pipe = new PassThrough();
  const result = receiveOwnedSimulatorClock(pipe);
  pipe.destroy(new Error(`secret ${key}`));
  await expect(result).rejects.toThrow("Simulator clock bootstrap transport failed.");
});

const responsePath = "/_simulator/v1/battle-capabilities/availability";
function responseSignature(
  body: Uint8Array,
  length = body.length,
  old = false,
  appendNewline = false,
) {
  const request = new TextEncoder().encode("{}");
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const mac = createHmac("sha256", Buffer.from(key, "hex"));
  if (old)
    mac.update(
      `TCS-RESPONSE-2\n${domain}\n${nonce}\nPOST\n${responsePath}\n${hash(request)}\n200\n${hash(body)}\n`,
    );
  else {
    mac
      .update(
        `TCS-RESPONSE-3\n${domain}\n${nonce}\nPOST\n${responsePath}\n${hash(request)}\n200\n${length}\n`,
      )
      .update(body);
    if (appendNewline) mac.update("\n");
  }
  return { domain, nonce, path: responsePath, request, status: 200, body, mac: mac.digest("hex") };
}
test.each(["", "\n", "line\n", "日本語🙂"])(
  "response3 authenticates exact raw bytes: %j",
  async (text) => {
    const clock = await receive();
    const body = new TextEncoder().encode(text);
    expect(() => clock.authenticateResponse(responseSignature(body))).not.toThrow();
    expect(() => clock.authenticateResponse(responseSignature(body, body.length, true))).toThrow(
      "Unauthenticated",
    );
    expect(() =>
      clock.authenticateResponse(responseSignature(body, body.length, false, true)),
    ).toThrow("Unauthenticated");
  },
);
test("response3 rejects character length and same-length raw body tampering", async () => {
  const clock = await receive();
  const text = "日本語🙂";
  const body = new TextEncoder().encode(text);
  expect(() => clock.authenticateResponse(responseSignature(body, text.length))).toThrow(
    "Unauthenticated",
  );
  const signed = responseSignature(body);
  const changed = body.slice();
  changed[0] = (changed[0] ?? 0) ^ 1;
  expect(() => clock.authenticateResponse({ ...signed, body: changed })).toThrow("Unauthenticated");
});
