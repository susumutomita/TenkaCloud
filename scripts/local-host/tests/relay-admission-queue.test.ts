import { expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import { LoopbackRelays } from "../container/loopback-relay";
import type { RelayTarget } from "../container/relay-target";

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return address.port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await Bun.sleep(5);
  }
}

/** The single FIFO worker queue that relay checks share with guard audits. */
function workerQueue() {
  const order: string[] = [];
  const waiting: (() => void)[] = [];
  let busy = false;
  return {
    order,
    async run<T>(label: string, work: () => Promise<T>): Promise<T> {
      if (busy) await new Promise<void>((resolve) => waiting.push(resolve));
      busy = true;
      order.push(label);
      try {
        return await work();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else busy = false;
      }
    },
  };
}

test("connection churn queues at most one ownership check per binding ahead of a guard audit", async () => {
  const peers = new Set<Socket>();
  const echo = createServer((socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    socket.pipe(socket);
  });
  const target: RelayTarget = { host: "127.0.0.1", port: await listen(echo), identity: "owned" };
  const hostPort = await freePort();
  const queue = workerQueue();
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let accepted = 0;
  const relay = new LoopbackRelays(
    [{ service: "web", hostPort, port: 8080, networks: ["default"] }],
    (_, expected) =>
      queue.run("relay", async () => {
        if (expected) await gate;
        return target;
      }),
    () => {
      accepted++;
      return true;
    },
    (error) => {
      throw error;
    },
  );
  const clients: Socket[] = [];
  let echoed: Promise<string>[] = [];
  try {
    await relay.listen();
    accepted = 0;
    echoed = Array.from({ length: 30 }, (_, index) => {
      const socket = connect({ host: "127.0.0.1", port: hostPort });
      clients.push(socket);
      socket.write(`client-${String(index)}`);
      return new Promise<string>((resolve, reject) => {
        socket.once("data", (data) => resolve(String(data)));
        socket.once("close", () => reject(new Error(`client-${String(index)} closed`)));
      });
    });
    await until(() => accepted === 30, "every connection to be accepted");

    const audit = queue.run("guard-audit", async () => undefined);
    open();
    await audit;
    expect(queue.order.slice(1)).toEqual(["relay", "guard-audit"]);
    expect(await Promise.all(echoed)).toEqual(
      Array.from({ length: 30 }, (_, index) => `client-${String(index)}`),
    );
    expect(queue.order.slice(1)).toEqual(["relay", "guard-audit", "relay"]);
  } finally {
    for (const socket of clients) socket.destroy();
    await Promise.allSettled(echoed);
    await relay.close();
    for (const peer of peers) peer.destroy();
    await close(echo);
  }
});
