/**
 * SSRF defense-in-depth: host blocklist + URL validator shared across the problem-deploy backend.
 *
 * Two call sites:
 *   - `problem-endpoints-handler`: validates participant-registered override URLs at write time.
 *   - `generic-scoring-handler`: re-validates probe URLs at fetch time (metadata-supplied paths
 *     can be absolute, and redirect targets are revalidated) before the scoring engine issues an
 *     outbound request.
 *
 * Phase 3.B fetcher で DNS-rebinding-safe な resolve-then-connect を実装するまでの暫定。host は
 * IPv6 bracket を剥がし lowercase 化した bare form に正規化してから lookup する。
 *
 * Issue #863: IPv6-mapped IPv4 (`::ffff:169.254.169.254`) や IPv4 short form
 * (`0xa9.0xfe.0xa9.0xfe`) で blocklist を bypass される攻撃を防ぐため、 host を normalize して
 * から check する。 私設 IP (RFC 1918 等) は Battle 参加者が自分の AWS account 内 endpoint を
 * 登録するため intentional に許容する (= issue 内 design 判断)。
 */
export const SSRF_BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  "169.254.169.254", // AWS / Azure IMDS v4
  "fd00:ec2::254", // AWS IMDS v6 (canonical)
  "fd00:ec2:0:0:0:0:0:254", // AWS IMDS v6 (expanded)
  "169.254.170.2", // ECS task-role credentials (metadata v2/v3/v4)
  "169.254.170.23", // EKS Pod Identity credentials (IPv4)
  "fd00:ec2::23", // EKS Pod Identity credentials (IPv6)
  "metadata.google.internal", // GCE metadata
  "metadata",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "0:0:0:0:0:0:0:1", // ::1 expanded
  "localhost",
]);

/**
 * IPv6-mapped IPv4 (`::ffff:a.b.c.d` / `::ffff:AABB:CCDD`) を unwrap して IPv4 dotted string を
 * 返す。 IPv4 native や IPv6 non-mapped はそのまま返す。
 *
 * 例:
 *   `::ffff:169.254.169.254` → `169.254.169.254`
 *   `::ffff:a9fe:a9fe`        → `169.254.169.254`
 *   `127.0.0.1`               → `127.0.0.1`
 */
export function unwrapIPv6MappedIPv4(host: string): string {
  const lower = host.toLowerCase();
  // dotted form: ::ffff:X.X.X.X
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  // hex form: ::ffff:AABB:CCDD → IPv4
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    if (high <= 0xffff && low <= 0xffff) {
      return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
    }
  }
  return host;
}

/** URL.hostname を blocklist 照合用に正規化する (IPv6 bracket 除去 + lowercase + mapped unwrap)。 */
function normalizeHost(hostname: string): string {
  const rawHost = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return unwrapIPv6MappedIPv4(rawHost);
}

/**
 * `http(s)://` で host が SSRF blocklist に該当しない URL のみ `true`。
 * 不正な URL / 非 http(s) scheme は `false`。
 */
export function isSsrfSafeUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !SSRF_BLOCKED_HOSTS.has(normalizeHost(u.hostname));
  } catch {
    return false;
  }
}
