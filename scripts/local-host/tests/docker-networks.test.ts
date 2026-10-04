import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadDockerCatalog } from "../docker-catalog";
import {
  allocateNetworkSubnets,
  applyNetworkSubnets,
  DockerNetworkInventoryError,
  occupiedDockerSubnets,
  parseDockerNetworkPool,
} from "../docker-networks";
import { parseOptions } from "../options";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- RFC1918 synthetic allocation vectors; no network calls
const POOL = "10.240.0.0/16";
const DEFAULT = "services:\n  app:\n    image: sample\n";
const SPLIT =
  "services:\n  app:\n    image: sample\n    networks: [front, back]\n  db:\n    image: sample\n    networks: [back]\nnetworks:\n  front: {}\n  back:\n    internal: true\n";

test("compact pools require an explicit aligned private range; default startup changes no IPAM", () => {
  expect(parseDockerNetworkPool(POOL)).toBe(POOL);
  expect(parseOptions([], root)).not.toHaveProperty("dockerNetworkPool");
  expect(parseOptions(["--docker-network-pool", POOL], root).dockerNetworkPool).toBe(POOL);
  /* eslint-disable sonarjs/no-hardcoded-ip -- negative CIDR parser vectors; no connections */
  for (const value of [
    "0.0.0.0/0",
    "8.8.8.0/24",
    "10.240.0.1/16",
    "10.240.0.0/8",
    "10.240.0.0/28",
    "10.999.0.0/16",
    "::/64",
  ])
    expect(() => parseDockerNetworkPool(value)).toThrow();
  /* eslint-enable sonarjs/no-hardcoded-ip */
});

test("stopped-project reservations and observed networks are never reused", () => {
  const first = allocateNetworkSubnets(SPLIT, POOL, []);
  const second = allocateNetworkSubnets(DEFAULT, POOL, Object.values(first));
  expect(new Set([...Object.values(first), ...Object.values(second)]).size).toBe(3);
  expect(applyNetworkSubnets(SPLIT, first)).toBe(
    applyNetworkSubnets(SPLIT, JSON.parse(JSON.stringify(first))),
  );
  const plan = parse(applyNetworkSubnets(SPLIT, first));
  expect(plan.services).toEqual(parse(SPLIT).services);
  expect(plan.networks.back.internal).toBe(true);
  expect(plan.networks.front.ipam.config[0].subnet).toBe(first.front);
});

test("a LAN/VPN or Docker allocation covering the pool fails without evicting anything", () => {
  expect(() => allocateNetworkSubnets(DEFAULT, POOL, [POOL])).toThrow("no free compact subnets");
  const allocations: string[] = [];
  const small = POOL.replace("/16", "/24");
  for (let i = 0; i < 16; i++)
    allocations.push(...Object.values(allocateNetworkSubnets(DEFAULT, small, allocations)));
  expect(() => allocateNetworkSubnets(DEFAULT, small, allocations)).toThrow(
    "Retained work was not removed",
  );
  expect(allocations).toHaveLength(16);
});

test("retained allocations cannot change network names, overlap, use public addresses or external names", () => {
  const subnets = allocateNetworkSubnets(SPLIT, POOL, []);
  expect(() => applyNetworkSubnets(SPLIT, { extra: subnets.front ?? "" })).toThrow(
    "does not match",
  );
  expect(() =>
    applyNetworkSubnets(SPLIT, { front: subnets.front ?? "", back: subnets.front ?? "" }),
  ).toThrow("overlapping");
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- rejected public allocation vector
  expect(() => applyNetworkSubnets(DEFAULT, { default: "8.8.8.0/28" })).toThrow("Invalid");
  expect(() =>
    applyNetworkSubnets(
      `${DEFAULT}networks:\n  default:\n    name: shared\n`,
      allocateNetworkSubnets(DEFAULT, POOL, []),
    ),
  ).toThrow("project-owned");
});

test("all 106 catalog definitions fit compact networks without changing service configuration", () => {
  const catalog = loadDockerCatalog(root);
  expect(catalog).toHaveLength(106);
  const retained: string[] = [];
  for (const problem of catalog) {
    const { composeText } = JSON.parse(problem.definition);
    const subnets = allocateNetworkSubnets(composeText, POOL, retained);
    retained.push(...Object.values(subnets));
    const planned = parse(applyNetworkSubnets(composeText, subnets));
    expect(planned.services).toEqual(parse(composeText, { merge: true }).services);
    for (const [name, value] of Object.entries(subnets))
      expect(planned.networks[name].ipam.config[0].subnet).toBe(value);
  }
  expect(new Set(retained).size).toBe(retained.length);
});

test("20 problems × 5 teams can retain every private network without launching containers", () => {
  const catalog = loadDockerCatalog(root).slice(0, 20);
  const retained: string[] = [];
  for (let team = 0; team < 5; team++)
    for (const problem of catalog) {
      const { composeText } = JSON.parse(problem.definition);
      retained.push(...Object.values(allocateNetworkSubnets(composeText, POOL, retained)));
    }
  expect(retained.length).toBeGreaterThanOrEqual(100);
  expect(new Set(retained).size).toBe(retained.length);
});

test("inventory reads only network IDs and IPAM, and never performs cleanup", () => {
  const calls: string[][] = [];
  const result = occupiedDockerSubnets((args) => {
    calls.push(args);
    return args[1] === "ls" ? "0123456789ab" : JSON.stringify([{ Subnet: POOL }]);
  }, {});
  expect(result).toEqual([POOL]);
  expect(calls).toEqual([
    ["network", "ls", "--quiet"],
    ["network", "inspect", "--format", "{{json .IPAM.Config}}", "0123456789ab"],
  ]);
  expect(occupiedDockerSubnets(() => "", {})).toEqual([]);
  expect(() => occupiedDockerSubnets(() => "bad-id", {})).toThrow("invalid");
  expect(() =>
    occupiedDockerSubnets(() => {
      throw new Error("inspection unavailable");
    }, {}),
  ).toThrow("inspection unavailable");
});

test("daemon diagnostics never expose the command's stderr", () => {
  const failure = new DockerNetworkInventoryError({
    stderr: Buffer.from("Cannot connect to the Docker daemon: private test detail"),
  });
  expect(failure.daemonUnavailable).toBe(true);
  expect(failure.message).not.toContain("private test detail");
  expect(new DockerNetworkInventoryError(null).daemonUnavailable).toBe(false);
});
