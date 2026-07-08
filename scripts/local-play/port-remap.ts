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
 * Rewrite the host port of every loopback URL embedded in `text`
 * (`http://127.0.0.1:<port>/…`) using a base→new port map. Ports not in the map
 * are left as-is (e.g. an internal port a problem might reference). Used both on
 * a single value (`challengeEndpoints` / `verifyUrl`) and on free prose (a
 * problem's markdown `instructions`, hints, and i18n overlays, which reference
 * the challenge surface by absolute loopback URL) — the global regex rewrites
 * each occurrence, so any number of URLs in one string all move together.
 */
export function offsetLoopbackUrl(text: string, portMap: ReadonlyMap<number, number>): string {
  return text.replace(LOOPBACK_URL_PORT_RE, (match, port: string) => {
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

/** Deep-map every string in `value`, preserving its structure (arrays / objects). */
function mapStrings<T>(value: T, mapString: (text: string) => string): T {
  if (typeof value === "string") return mapString(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, mapString)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, mapString);
    return out as T;
  }
  return value;
}

/**
 * Move a problem onto an assigned host-port block: rewrite every loopback URL it
 * mentions — `challengeEndpoints`, `verifyUrl`, AND the competitor-facing prose
 * (`instructions` / `description` / `writeup` / hints / the `i18n.en` overlay) —
 * using the compose remap's base→new port map.
 *
 * The prose must move with the endpoints: a catalog problem hard-codes the base
 * port (`http://127.0.0.1:18080/…`) in its instructions and hints, so a problem
 * running on a later block (e.g. the third problem, offset 200 → 18280) would
 * otherwise tell the player to curl 18080 while its surface is on 18280 (#2392).
 * A single deep string walk covers every text field at once, so a newly added
 * prose field cannot silently miss the remap. Only ports present in `portMap`
 * change; every other string (paths, ids, non-loopback text) is byte-for-byte
 * identical, so the identity map (offset 0) is a true no-op.
 */
export function remapContainerProblem<T>(problem: T, portMap: ReadonlyMap<number, number>): T {
  return mapStrings(problem, (text) => offsetLoopbackUrl(text, portMap));
}
