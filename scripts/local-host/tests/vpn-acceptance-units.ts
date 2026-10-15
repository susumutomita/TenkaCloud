import assert from "node:assert/strict";

export const acceptanceSealUnit = "tenkacloud-vpn-seal@tcwgac.service";
export const acceptanceWgUnit = "wg-quick@tcwgac.service";
const properties = [
  "LoadState",
  "ActiveState",
  "SubState",
  "FragmentPath",
  "DropInPaths",
  "UnitFileState",
  "Transient",
  "Description",
];
type Run = (program: string, args: readonly string[]) => string;
export function afterAcceptanceTransportRemoved(
  readLinks: () => readonly { ifname: string }[],
  cleanup: () => void,
): void {
  assert.ok(
    !readLinks().some((link) => link.ifname === "tcwgac"),
    "Keep packet protection until the owned WireGuard interface is absent",
  );
  cleanup();
}
export function acceptanceUnitState(run: Run, unit: string): Record<string, string> {
  return Object.fromEntries(
    run("systemctl", ["show", unit, ...properties.map((key) => `--property=${key}`)])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const position = line.indexOf("=");
        assert.ok(position > 0, "Invalid unit inventory");
        return [line.slice(0, position), line.slice(position + 1)];
      }),
  );
}
export function assertAcceptanceUnitAvailable(
  unit: string,
  state: Record<string, string>,
  occupied: boolean,
): void {
  assert.ok(!occupied, "Acceptance unit/configuration path already exists");
  assert.equal(state.ActiveState, "inactive", "Acceptance unit is already active");
  assert.equal(state.SubState, "dead", "Acceptance unit has retained state");
  assert.equal(state.DropInPaths, "", "Acceptance unit has existing overrides");
  assert.equal(state.Transient, "no", "Acceptance unit is already transient");
  if (state.LoadState === "not-found") {
    assert.equal(state.FragmentPath, "");
    assert.equal(state.UnitFileState, "");
    return;
  }
  assert.equal(unit, acceptanceWgUnit, "Temporary unit name already exists");
  assert.equal(state.LoadState, "loaded");
  assert.ok(
    ["/usr/lib/systemd/system/wg-quick@.service", "/lib/systemd/system/wg-quick@.service"].includes(
      state.FragmentPath ?? "",
    ),
    "Only the standard unused WireGuard template is permitted",
  );
  assert.ok(
    ["disabled", "indirect"].includes(state.UnitFileState ?? ""),
    "WireGuard instance is enabled or masked",
  );
}
export function acceptanceUnitDescription(directory: string): string {
  assert.match(directory, /^\/run\/tc-vpn-acceptance-[A-Za-z0-9]+$/u);
  return `TenkaCloud acceptance ${directory}`;
}
export const acceptanceWgUnitPath = `/run/systemd/system/${acceptanceWgUnit}`;
export function acceptanceWgUnitContent(directory: string): string {
  return `[Unit]\nDescription=${acceptanceUnitDescription(directory)}\nRequires=${acceptanceSealUnit}\nAfter=${acceptanceSealUnit}\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/true\n`;
}
export function cleanupAcceptanceUnits(
  directory: string,
  io: {
    run: Run;
    exists: (path: string) => boolean;
    read: (path: string) => string;
    remove: (path: string) => void;
  },
): void {
  const description = acceptanceUnitDescription(directory);
  const ownedFile = io.exists(acceptanceWgUnitPath);
  if (ownedFile)
    assert.equal(
      io.read(acceptanceWgUnitPath),
      acceptanceWgUnitContent(directory),
      "Refusing to remove a foreign WireGuard instance file",
    );
  for (const unit of [acceptanceWgUnit, acceptanceSealUnit]) {
    const state = acceptanceUnitState(io.run, unit);
    if (state.LoadState === "not-found") continue;
    const fragment =
      unit === acceptanceWgUnit ? acceptanceWgUnitPath : `/run/systemd/transient/${unit}`;
    if (state.Description === description && state.FragmentPath === fragment) {
      assert.equal(state.Transient, unit === acceptanceWgUnit ? "no" : "yes");
      io.run("systemctl", ["stop", unit]);
    } else {
      // A vendor template is never ours to stop, including before instance creation.
      assertAcceptanceUnitAvailable(unit, state, false);
    }
  }
  if (ownedFile) {
    assert.equal(io.read(acceptanceWgUnitPath), acceptanceWgUnitContent(directory));
    io.remove(acceptanceWgUnitPath);
    io.run("systemctl", ["daemon-reload"]);
  }
}
