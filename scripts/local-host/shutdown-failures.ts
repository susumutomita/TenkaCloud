/** Report every retained cleanup obligation; one category must not hide another. */
export function throwShutdownFailures(
  battle: readonly unknown[],
  local: readonly string[],
  vpn: readonly unknown[],
): void {
  const failures: Error[] = [];
  if (battle.length)
    failures.push(
      new AggregateError(
        battle,
        "Battle cleanup unconfirmed; owned deployment records are retained.",
      ),
    );
  if (local.length)
    failures.push(
      new Error(
        `${String(local.length)} owned Docker jobs are not confirmed stopped (including earlier failed deployments, not a container count); ownership and data are retained.\n${local.join("\n")}`,
      ),
    );
  if (vpn.length)
    failures.push(new AggregateError(vpn, "VPN closure failed; remaining cleanup was attempted."));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, failures.map((error) => error.message).join("\n"));
}
