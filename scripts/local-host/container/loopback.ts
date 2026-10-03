/**
 * Loopback-only URL guard shared by the local-play harness.
 *
 * Every URL the harness touches (the problem container's challenge surface and
 * its `/verify` admin endpoint) must stay on the local machine. Refusing
 * anything but `http(s)://localhost|127.0.0.1|[::1]` keeps the harness from
 * (a) forwarding a participant submission to an attacker-controlled host and
 * (b) letting a problem container's `/verify` be reached from off-box.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackUrl(value: string): boolean {
  try {
    parseLoopbackUrl(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `value` and fail loudly unless it is an `http(s)` URL on a loopback
 * host. Returns the parsed {@link URL} so callers can reuse the origin/port.
 */
export function parseLoopbackUrl(value: string, label = "URL"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} is not a valid URL: ${value}`, { cause: error });
  }
  const loopbackHost = LOOPBACK_HOSTS.has(url.hostname);
  const httpProtocol = url.protocol === "http:" || url.protocol === "https:";
  if (!loopbackHost || !httpProtocol) {
    throw new Error(`Refusing non-loopback ${label}: ${url.origin}`);
  }
  return url;
}
