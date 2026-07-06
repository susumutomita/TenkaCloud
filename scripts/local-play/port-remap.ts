/**
 * [#2392] Per-problem host-port remapping for simultaneous local play.
 *
 * Every local-play problem's docker-compose hard-codes the same loopback host
 * ports (e.g. `127.0.0.1:18080:8080`, `127.0.0.1:18081:8081`), so running
 * several at once collides. To play N problems in one session we give each
 * problem index a distinct host-port block: problem i offsets every *published
 * host* port by `i * PORT_STRIDE`. The container-internal port is untouched, so
 * only the host binding moves.
 *
 * The transform is a targeted text rewrite (not a YAML round-trip): it only
 * rewrites the 3-part published-port form `127.0.0.1:<host>:<container>`, which
 * is the exact shape every catalog compose uses. This preserves the rest of the
 * file byte-for-byte (comments, build contexts, volumes, healthchecks) — in
 * particular healthcheck URLs like `http://127.0.0.1:8080/healthz` are the
 * 2-part `ip:port` form and are deliberately NOT matched.
 */

/** Host-port block width per problem. A single problem never publishes this many ports. */
export const PORT_STRIDE = 100;

/** `127.0.0.1:<hostPort>:<containerPort>` — the only published-port form we rewrite. */
const LOOPBACK_PUBLISH_RE = /127\.0\.0\.1:(\d+):(\d+)/g;
/** `127.0.0.1:<port>` inside a loopback URL (host side only). */
const LOOPBACK_URL_PORT_RE = /127\.0\.0\.1:(\d+)/g;

export interface ComposePortRemap {
  /** The rewritten compose text (identical to the input when offset is 0). */
  readonly text: string;
  /** base host port → offset host port, for rewriting the problem's URLs. */
  readonly portMap: ReadonlyMap<number, number>;
}

/** The host-port offset for the problem at index `i` (0 → no change). */
export function portOffsetForIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`problem index must be a non-negative integer (got ${index})`);
  }
  return index * PORT_STRIDE;
}

/**
 * Rewrite every published host port in `composeText` by `offset`, returning the
 * new text and the base→new host-port map. `offset === 0` is the identity (the
 * first problem keeps its declared ports); the map still records each host port
 * so URL rewriting is uniform across problems.
 */
export function remapComposeHostPorts(composeText: string, offset: number): ComposePortRemap {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`port offset must be a non-negative integer (got ${offset})`);
  }
  const portMap = new Map<number, number>();
  const text = composeText.replace(
    LOOPBACK_PUBLISH_RE,
    (_match, host: string, container: string) => {
      const hostPort = Number(host);
      const newHost = hostPort + offset;
      if (newHost > 65_535) {
        throw new Error(
          `remapped host port ${newHost} exceeds 65535 (base ${hostPort} + ${offset})`,
        );
      }
      portMap.set(hostPort, newHost);
      return `127.0.0.1:${newHost}:${container}`;
    },
  );
  return { text, portMap };
}

/**
 * Rewrite the host port of loopback URLs (`http://127.0.0.1:<port>/…`) using a
 * base→new port map. Ports not in the map are left as-is (e.g. an internal port
 * a problem might reference). Used to move `challengeEndpoints` / `verifyUrl`
 * onto a problem's assigned host-port block.
 */
export function offsetLoopbackUrl(url: string, portMap: ReadonlyMap<number, number>): string {
  return url.replace(LOOPBACK_URL_PORT_RE, (match, port: string) => {
    const mapped = portMap.get(Number(port));
    return mapped === undefined ? match : `127.0.0.1:${mapped}`;
  });
}

/** Apply a port map to every value of a loopback endpoint record. */
export function offsetLoopbackEndpoints(
  endpoints: Readonly<Record<string, string>>,
  portMap: ReadonlyMap<number, number>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [label, url] of Object.entries(endpoints)) {
    out[label] = offsetLoopbackUrl(url, portMap);
  }
  return out;
}
