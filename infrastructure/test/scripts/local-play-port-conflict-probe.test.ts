import { describe, expect, it } from "vitest";
import { createPortConflictProbe } from "../../../scripts/local-play/docker-adapter";

/**
 * [#2927] The probe that answers "is this offset actually usable", built from the catalog's
 * compose files plus the daemon's view of published ports.
 *
 * Both halves have to be right for the fix to work, and both fail quietly if not: read the
 * wrong ports and it clears an offset that is really blocked; treat a probe outage as a
 * conflict and it refuses to start problems on a healthy machine. Docker is injected so
 * this runs with no daemon.
 */

const COMPOSE = `services:
  web:
    image: demo
    ports:
      - "127.0.0.1:18080:8080"
      - "127.0.0.1:18081:8081"
`;

/** `compose: null` models a problem with no compose file. The sentinel has to be a real
 *  value because JS default parameters treat an explicit `undefined` as "argument absent". */
function probeFor(holders: Readonly<Record<number, string>>, compose: string | null = COMPOSE) {
  return createPortConflictProbe(() => (compose === null ? undefined : "/problems/demo.yml"), {
    readCompose: () => {
      if (compose === null) throw new Error("unreadable");
      return compose;
    },
    holderOf: (port) => holders[port],
  });
}

describe("createPortConflictProbe (#2927)", () => {
  it("should report nothing when every port the offset needs is free", () => {
    expect(probeFor({})("demo", 0)).toEqual([]);
  });

  it("should name the container holding a port at offset 0", () => {
    // The exact shape of the reported outage: two catalog problems hardcode 18080, and a
    // previous session's container was still on it.
    expect(probeFor({ 18080: "tc-local-stackstack-onboarding-web-1" })("demo", 0)).toEqual([
      { port: 18080, heldBy: "tc-local-stackstack-onboarding-web-1" },
    ]);
  });

  it("should follow the offset when deciding which ports to check", () => {
    // At offset 1000 the problem publishes 19080/19081, so a holder of 18080 is irrelevant.
    const probe = probeFor({ 18080: "tc-local-old", 19081: "tc-local-other" });
    expect(probe("demo", 1000)).toEqual([{ port: 19081, heldBy: "tc-local-other" }]);
  });

  it("should report every blocked port, not just the first", () => {
    const probe = probeFor({ 18080: "holder-a", 18081: "holder-b" });
    expect(probe("demo", 0)).toEqual([
      { port: 18080, heldBy: "holder-a" },
      { port: 18081, heldBy: "holder-b" },
    ]);
  });

  it("should clear a problem it cannot locate a compose file for", () => {
    // Simulator-backed and AWS-only problems publish no host ports through this path.
    expect(probeFor({ 18080: "holder" }, null)("demo", 0)).toEqual([]);
  });

  it("should clear rather than block when the compose file cannot be read", () => {
    // An unreadable compose is that problem's own failure to surface at start time; turning
    // it into a port verdict would refuse the start for the wrong stated reason.
    const probe = createPortConflictProbe(() => "/problems/demo.yml", {
      readCompose: () => {
        throw new Error("ENOENT");
      },
      holderOf: () => "holder",
    });
    expect(probe("demo", 0)).toEqual([]);
  });

  it("should clear when the daemon cannot be asked, so a probe outage cannot block starts", () => {
    // `describePortHolder` returns undefined on a non-zero exit; that must read as "free"
    // and let compose report the real failure, not as "everything is blocked".
    expect(probeFor({})("demo", 0)).toEqual([]);
  });
});
