import { expect, test } from "bun:test";
import {
  acceptanceSealUnit,
  acceptanceWgUnit,
  acceptanceWgUnitContent,
  acceptanceWgUnitPath,
  afterAcceptanceTransportRemoved,
  assertAcceptanceUnitAvailable,
  cleanupAcceptanceUnits,
} from "./vpn-acceptance-units";

test("uncertain WireGuard teardown retains every packet guard", () => {
  let removed = false;
  const removeGuards = () => {
    removed = true;
  };
  expect(() =>
    afterAcceptanceTransportRemoved(() => [{ ifname: "tcwgac" }], removeGuards),
  ).toThrow();
  expect(removed).toBe(false);
  expect(() =>
    afterAcceptanceTransportRemoved(() => {
      throw new Error("link inventory unavailable");
    }, removeGuards),
  ).toThrow();
  expect(removed).toBe(false);
  afterAcceptanceTransportRemoved(() => [{ ifname: "lo" }], removeGuards);
  expect(removed).toBe(true);
});

const directory = "/run/tc-vpn-acceptance-regression";
const absent = {
  LoadState: "not-found",
  ActiveState: "inactive",
  SubState: "dead",
  FragmentPath: "",
  DropInPaths: "",
  UnitFileState: "",
  Transient: "no",
  Description: "",
};
const vendor = {
  ...absent,
  LoadState: "loaded",
  FragmentPath: "/usr/lib/systemd/system/wg-quick@.service",
  UnitFileState: "disabled",
};

test("a standard loaded WireGuard template is not an occupied inactive instance", () => {
  expect(() => assertAcceptanceUnitAvailable(acceptanceWgUnit, vendor, false)).not.toThrow();
  expect(() => assertAcceptanceUnitAvailable(acceptanceSealUnit, absent, false)).not.toThrow();
  expect(acceptanceWgUnitContent(directory)).toContain(
    `Requires=${acceptanceSealUnit}\nAfter=${acceptanceSealUnit}`,
  );
});
test("configured, enabled, active, overridden and foreign instances remain collisions", () => {
  for (const changes of [
    { ActiveState: "active" },
    { ActiveState: "activating" },
    { SubState: "failed" },
    { UnitFileState: "enabled" },
    { UnitFileState: "masked" },
    { Transient: "yes" },
    { DropInPaths: "/etc/systemd/system/wg-quick@.service.d/existing.conf" },
    { FragmentPath: "/etc/systemd/system/wg-quick@.service" },
    { FragmentPath: acceptanceWgUnitPath },
    { LoadState: "error" },
  ])
    expect(() =>
      assertAcceptanceUnitAvailable(acceptanceWgUnit, { ...vendor, ...changes }, false),
    ).toThrow();
  expect(() => assertAcceptanceUnitAvailable(acceptanceWgUnit, vendor, true)).toThrow();
  expect(() => assertAcceptanceUnitAvailable(acceptanceSealUnit, vendor, false)).toThrow();
});
function fixture(owned: boolean) {
  const calls: string[][] = [];
  const removed: string[] = [];
  let content = acceptanceWgUnitContent(directory);
  return {
    calls,
    removed,
    foreign: () => {
      content += "# foreign change\n";
    },
    io: {
      exists: () => owned,
      read: () => content,
      remove: (path: string) => {
        removed.push(path);
      },
      run: (_program: string, args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] !== "show") return "";
        let state: Record<string, string> = args[1] === acceptanceWgUnit ? vendor : absent;
        if (owned)
          state = {
            ...state,
            LoadState: "loaded",
            Description: `TenkaCloud acceptance ${directory}`,
            FragmentPath:
              args[1] === acceptanceWgUnit
                ? acceptanceWgUnitPath
                : `/run/systemd/transient/${acceptanceSealUnit}`,
            Transient: args[1] === acceptanceWgUnit ? "no" : "yes",
            ActiveState: "active",
          };
        return Object.entries(state)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n");
      },
    },
  };
}
test("cleanup before instance creation never stops the standard template", () => {
  const f = fixture(false);
  cleanupAcceptanceUnits(directory, f.io);
  expect(f.calls.filter((args) => args[0] === "stop")).toEqual([]);
  expect(f.removed).toEqual([]);
});
test("cleanup stops exact journal-owned units and removes only their instance override", () => {
  const f = fixture(true);
  cleanupAcceptanceUnits(directory, f.io);
  expect(f.calls.filter((args) => args[0] === "stop")).toEqual([
    ["stop", acceptanceWgUnit],
    ["stop", acceptanceSealUnit],
  ]);
  expect(f.removed).toEqual([acceptanceWgUnitPath]);
  expect(f.calls.at(-1)).toEqual(["daemon-reload"]);
});
test("cleanup refuses a changed or foreign runtime instance file", () => {
  const f = fixture(true);
  f.foreign();
  expect(() => cleanupAcceptanceUnits(directory, f.io)).toThrow();
  expect(f.calls).toEqual([]);
  expect(f.removed).toEqual([]);
});
