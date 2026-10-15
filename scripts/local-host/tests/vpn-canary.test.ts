import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { createConnection } from "node:net";
import { awaitSyntheticCanary, canaryDatagramOptions, syntheticCanaryScript } from "./vpn-canary";

const children: ChildProcess[] = [];
function start(script: string): ChildProcess {
  const child = spawn(process.execPath, ["--eval", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  return child;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  }
});
async function httpBody(host: string, port: number): Promise<string> {
  // Literal loopback sockets keep these owned-listener checks out of HTTP proxy routing.
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let response = "";
    socket.setTimeout(1000, () => socket.destroy(new Error("HTTP canary deadline")));
    socket.once("connect", () =>
      socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
    );
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.length > 8192) socket.destroy(new Error("Unexpected canary response size"));
    });
    socket.once("end", () => resolve(response.split("\r\n\r\n").slice(1).join("\r\n\r\n")));
    socket.once("error", reject);
  });
}
async function echo(kind: "udp4" | "udp6", address: string, port: number): Promise<string> {
  const socket = createSocket(kind);
  try {
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Echo deadline")), 1000);
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.once("message", (message) => {
        clearTimeout(timeout);
        resolve(message.toString());
      });
      socket.send(Buffer.from(`echo-${kind}`), port, address);
    });
  } finally {
    socket.close();
  }
}

test.each(["127.0.0.1", "::1"] as const)(
  "actual canary on %s readies all listeners and echoes both UDP families on one high port",
  async (loopbackHttpHost) => {
    const child = start(
      syntheticCanaryScript({
        httpPort: 0,
        dnsPort: 0,
        marker: "high-port-canary",
        loopbackHttpHost,
      }),
    );
    const ready = await awaitSyntheticCanary(child);
    expect(ready.httpPort).toBeGreaterThan(1024);
    expect(ready.dnsPort).toBeGreaterThan(1024);
    expect(ready.listeners.toSorted()).toEqual(["dns-tcp", "http", "udp4", "udp6"]);
    for (const address of [loopbackHttpHost]) {
      expect(await httpBody(address, ready.httpPort)).toBe("high-port-canary");
      expect(await httpBody(address, ready.dnsPort)).toBe("owned-dns-canary");
    }
    expect(await echo("udp4", "127.0.0.1", ready.dnsPort)).toBe("echo-udp4");
    expect(await echo("udp6", "::1", ready.dnsPort)).toBe("echo-udp6");
  },
);
test("an occupied UDP listener fails readiness even when HTTP already started", async () => {
  const occupied = createSocket({ type: "udp6", ipv6Only: true });
  await new Promise<void>((resolve) => occupied.bind(0, "::1", resolve));
  try {
    const child = start(
      syntheticCanaryScript({
        httpPort: 0,
        dnsPort: occupied.address().port,
        marker: "not-ready",
        loopbackHttpHost: "127.0.0.1",
      }),
    );
    await expect(awaitSyntheticCanary(child)).rejects.toThrow(
      "Synthetic canary listener failed (EADDRINUSE)",
    );
  } finally {
    occupied.close();
  }
});
test("early child exit reports only its status and never arbitrary stderr", async () => {
  const child = start("console.error('private-canary-diagnostic');process.exit(23)");
  await expect(awaitSyntheticCanary(child)).rejects.toMatchObject({
    message: "Synthetic canary exited before readiness (code=23, signal=none)",
  });
});
test("readiness rejects missing listeners and bounds child output", async () => {
  await expect(
    awaitSyntheticCanary(
      start(
        "console.log(JSON.stringify({kind:'canary-ready',httpPort:12345,dnsPort:12346,listeners:['http']}));setInterval(()=>{},1000)",
      ),
    ),
  ).rejects.toThrow("invalid readiness");
  await expect(
    awaitSyntheticCanary(start("console.log('x'.repeat(5000));setInterval(()=>{},1000)")),
  ).rejects.toThrow("output limit");
});

test("a live child that never readies fails within the readiness deadline", async () => {
  await expect(awaitSyntheticCanary(start("setInterval(()=>{},1000)"), 100)).rejects.toThrow(
    "listener readiness timed out",
  );
});

test("datagram creation receives the IPv6-only option before binding", () => {
  expect(canaryDatagramOptions("udp6")).toEqual({ type: "udp6", ipv6Only: true });
  expect(canaryDatagramOptions("udp4")).toEqual({ type: "udp4", ipv6Only: false });
});
