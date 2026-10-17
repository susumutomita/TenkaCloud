import { connect, createServer, type Server, type Socket } from "node:net";
import { parse, stringify } from "yaml";
import type { LocalNetworkPlan } from "../local-network";
import type { RelayBinding, RelayTarget } from "./relay-target";

/** Docker does not program published ports for internal-only bridges. Keep those bridges internal. */
export function relayCompose(
  text: string,
  plan?: LocalNetworkPlan,
): { text: string; bindings: RelayBinding[] } {
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
      !networks.every(
        (network) =>
          document.networks?.[network]?.internal === true ||
          plan?.egressSegments.some(
            (segment) => segment.name === network && segment.service === name,
          ),
      )
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
  private readonly admissions = new Map<Socket, ReturnType<typeof setTimeout>>();
  private readonly nextCheck = new Map<RelayBinding, Socket[]>();
  private readonly checking = new Set<RelayBinding>();
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
      this.sockets.size + this.admissions.size > 62 ||
      this.admissions.size >= 32
    ) {
      client.destroy();
      return;
    }
    this.track(client);
    const deadline = setTimeout(() => client.destroy(), 20_000);
    deadline.unref();
    this.admissions.set(client, deadline);
    client.once("close", () => this.admitted(client));
    this.nextCheck.set(binding, [...(this.nextCheck.get(binding) ?? []), client]);
    this.check(binding);
  }
  private admitted(client: Socket): void {
    clearTimeout(this.admissions.get(client));
    this.admissions.delete(client);
  }
  /**
   * Ownership checks share the audit workers with guard proofs, so connection churn may hold at
   * most one check per binding. Each client is admitted only by a check that started after it
   * connected; clients that expired while waiting start no check.
   */
  private check(binding: RelayBinding): void {
    if (this.stopped || this.checking.has(binding)) return;
    const clients = (this.nextCheck.get(binding) ?? []).filter((client) => !client.destroyed);
    this.nextCheck.delete(binding);
    if (!clients.length) return;
    this.checking.add(binding);
    void this.resolve(binding, this.targets.get(binding))
      .then((target) => {
        for (const client of clients) this.forward(client, target);
      })
      .catch((error) => this.fail(error))
      .finally(() => {
        this.checking.delete(binding);
        this.check(binding);
      });
  }
  private forward(client: Socket, target: RelayTarget): void {
    this.admitted(client);
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
