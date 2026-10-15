import { connect, createServer, type Server, type Socket } from "node:net";
import { parse, stringify } from "yaml";
import type { RelayBinding, RelayTarget } from "./relay-target";

/** Docker does not program published ports for internal-only bridges. Keep those bridges internal. */
export function relayCompose(text: string): { text: string; bindings: RelayBinding[] } {
  const document = parse(text, { merge: true });
  const bindings: RelayBinding[] = [];
  // Preserve ordinary Compose validation/rollback; only internal networks need a transport rewrite.
  if (
    !document?.networks ||
    !Object.values(document.networks).some(
      (network) =>
        network &&
        typeof network === "object" &&
        "internal" in network &&
        network.internal === true,
    )
  )
    return { text, bindings };
  for (const [name, service] of Object.entries(document.services) as [
    string,
    {
      networks?: string[] | Record<string, unknown>;
      ports?: string[];
    },
  ][]) {
    let networks = ["default"];
    if (Array.isArray(service.networks)) networks = service.networks;
    else if (service.networks) networks = Object.keys(service.networks);
    if (
      !networks.length ||
      !networks.every((network) => document.networks?.[network]?.internal === true)
    )
      continue;
    for (const port of service.ports ?? []) {
      bindings.push(relayBinding(name, port, networks, bindings));
    }
    delete service.ports;
  }
  return { text: bindings.length ? stringify(document) : text, bindings };
}

/** Controller-owned raw TCP transports, preserving HTTP, TLS and WebSocket bytes. */
export class LoopbackRelays {
  private readonly servers: Server[] = [];
  private readonly starts: Promise<void>[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly targets = new Map<RelayBinding, RelayTarget>();
  private stopped = false;
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private auditing = false;
  private pending = 0;
  private verifiedAt = Date.now();
  constructor(
    private readonly bindings: readonly RelayBinding[],
    private readonly resolve: (
      binding: RelayBinding,
      expected?: RelayTarget,
    ) => Promise<RelayTarget>,
    private readonly current: () => boolean,
    private readonly failed: (error: unknown) => void,
  ) {}
  async listen(): Promise<void> {
    try {
      for (const binding of this.bindings) {
        const target = await this.resolve(binding);
        if (this.stopped || !this.current())
          throw new Error("Internal transport admission revoked.");
        this.targets.set(binding, target);
        const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) =>
          this.accept(binding, socket),
        );
        this.servers.push(server);
        const starting = new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(binding.hostPort, "127.0.0.1", () => {
            server.removeListener("error", reject);
            server.on("error", (error) => this.fail(error));
            resolve();
          });
        });
        this.starts.push(starting);
        await starting;
        if (this.stopped) throw new Error("Internal transport admission revoked.");
      }
      this.verifiedAt = Date.now();
      this.timer = setInterval(() => {
        if (Date.now() - this.verifiedAt > 60_000)
          this.fail(new Error("Internal transport ownership proof expired."));
        if (!this.auditing && !this.stopped) {
          this.auditing = true;
          void this.audit()
            .catch((error) => this.fail(error))
            .finally(() => {
              this.auditing = false;
            });
        }
      }, 10_000);
      this.timer.unref();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private async audit(): Promise<void> {
    for (const [binding, target] of this.targets) await this.resolve(binding, target);
    if (!this.stopped) this.verifiedAt = Date.now();
  }
  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }
  private accept(binding: RelayBinding, client: Socket): void {
    // Includes pending clients and upstreams; overload drops only this connection.
    if (
      this.stopped ||
      !this.current() ||
      this.sockets.size + this.pending > 62 ||
      this.pending >= 32
    ) {
      client.destroy();
      return;
    }
    this.pending++;
    this.track(client);
    const deadline = setTimeout(() => client.destroy(), 20_000);
    deadline.unref();
    void this.resolve(binding, this.targets.get(binding))
      .then((target) => {
        clearTimeout(deadline);
        if (client.destroyed || this.stopped || !this.current()) {
          client.destroy();
          return;
        }
        const upstream = connect({ host: target.host, port: target.port, allowHalfOpen: true });
        this.track(upstream);
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
        upstream.once("connect", () => {
          if (this.stopped || !this.current()) {
            upstream.destroy();
            client.destroy();
            return;
          }
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
        });
      })
      .catch((error) => {
        clearTimeout(deadline);
        this.fail(error);
      })
      .finally(() => {
        this.pending--;
      });
  }
  private fail(error: unknown): void {
    if (this.stopped) return;
    void this.close();
    this.failed(error);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const socket of this.sockets) socket.destroy();
    this.closing = Promise.allSettled(this.starts)
      .then(() => Promise.all(this.servers.map(closeRelayServer)))
      .then(() => undefined);
    return this.closing;
  }
}

function relayBinding(
  name: string,
  port: string,
  networks: readonly string[],
  bindings: readonly RelayBinding[],
): RelayBinding {
  const match = /^(?:127\.0\.0\.1|localhost):(\d+):(\d+)(?:\/tcp)?$/u.exec(String(port));
  if (!match) throw new Error("Internal transport requires a static loopback TCP binding.");
  const hostPort = Number(match[1]);
  const targetPort = Number(match[2]);
  if (
    ![hostPort, targetPort].every(
      (value) => Number.isInteger(value) && value > 0 && value < 65536,
    ) ||
    bindings.some((binding) => binding.hostPort === hostPort)
  )
    throw new Error("Invalid internal transport ports.");
  return {
    service: name,
    hostPort,
    port: targetPort,
    networks: [...networks].sort((left, right) => left.localeCompare(right)),
  };
}

function closeRelayServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
