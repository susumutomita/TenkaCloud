/** Only syntactically owned native VPN hooks may precede workload admission. */
export function vpnSealHook(line: string): boolean {
  const match =
    /^-A (INPUT|FORWARD) (.+) -m comment --comment "?tc-vpn-seal-v1:[a-f0-9]{64}"? -j DROP$/u.exec(
      line,
    );
  const scope = match?.[2] ?? "";
  return (
    /^-[io] tcwg[0-9a-z_-]{1,10}$/u.test(scope) ||
    /^! -i tcwg[0-9a-z_-]{1,10} -s [a-fA-F0-9:./]+$/u.test(scope) ||
    /^-s [a-fA-F0-9:./]+ ! -i tcwg[0-9a-z_-]{1,10}$/u.test(scope)
  );
}
export function vpnAdmissionHook(line: string): boolean {
  return /^-A (INPUT|FORWARD|DOCKER-USER) -[io] tcwg[0-9a-z_-]{1,10} -j TCV_[a-f0-9]{16}_[IF]$/u.test(
    line,
  );
}

/** Only exact workload bridge DROP hooks may be treated as a closure prefix. */
export function workloadQuarantineHook(line: string): boolean {
  return /^-A (INPUT|FORWARD|DOCKER-USER) -[io] tci[a-f0-9]{12} -m comment --comment "?tc-quarantine-v1:[a-f0-9]{64}"? -j DROP$/u.test(
    line,
  );
}
