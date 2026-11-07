/** A simulator credential must never redirect CLI traffic to an arbitrary host. */
export function normalizeSimulatorEndpointUrl(value: string): string {
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d+)\/?$/u.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw new Error(
      "Simulator endpoint must be a numeric loopback HTTP address with an explicit port.",
    );
  return `http://${match[1]}:${Number(match[2])}`;
}
