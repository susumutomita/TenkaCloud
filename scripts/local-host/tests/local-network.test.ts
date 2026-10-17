import { expect, test } from "bun:test";
import { parse } from "yaml";
import { allocateNetworkSubnets } from "../docker-networks";
import {
  assertNoNetworkOverlap,
  egressComposeSource,
  isolatedCompose,
  localNetworkPlan,
  requiredNetworkValue,
  retainedPublicPlan,
  sharedNetworkPlan,
} from "../local-network";
import { parseOptions } from "../options";

// eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic private network allocation, no connections
const subnet = { default: "10.240.0.0/28" };
const source =
  "services:\n  web:\n    image: sample\n    restart: always\n  db:\n    image: sample\n";
const make = () =>
  localNetworkPlan("tch-job-a", subnet, { composeText: source, definition: "edition-a" });

test("software competition networking requires an explicit pool and cannot enter public mode", () => {
  expect(parseOptions([], "/tmp").competitionNetwork).toBe(false);
  expect(() => parseOptions(["--competition-network"], "/tmp")).toThrow("requires");
  expect(
    parseOptions(
      ["--competition-network", "--docker-network-pool", subnet.default.replace("/28", "/24")],
      "/tmp",
    ).competitionNetwork,
  ).toBe(true);
  expect(() =>
    parseOptions(
      [
        "--competition-network",
        "--docker-network-pool",
        subnet.default.replace("/28", "/24"),
        "--public-admin-origin",
        "https://admin.example.test",
        "--public-participant-origin",
        "https://participant.example.test",
      ],
      "/tmp",
    ),
  ).toThrow("local native");
});
test("shared DMZ permissions bind both team attachments and exact published TCP endpoints", () => {
  const a = localNetworkPlan("tch-team-a", subnet, {
    composeText: source,
    definition: "a",
    eventId: "same-event",
  });
  const b = localNetworkPlan(
    "tch-team-b",
    { default: subnet.default.replace(".0/", ".16/") },
    { composeText: source, definition: "b", eventId: "same-event" },
  );
  const segment = requiredNetworkValue(b.segments[0]);
  const publishers = [
    {
      plan: b,
      endpoints: [
        {
          segment,
          service: "publicweb",
          // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic endpoint, never contacted
          addresses: [segment.ipv4.replace(".16/28", ".18"), segment.ipv6.replace("::/64", "::2")],
          port: 8080,
        },
      ],
    },
  ];
  const from = sharedNetworkPlan(a, publishers, [a, b]);
  const to = sharedNetworkPlan(b, publishers, [a, b]);
  // Native endpoint inspection crosses a Worker structured-clone boundary.
  expect(sharedNetworkPlan(a, structuredClone(publishers), [a, b])).toEqual(from);
  const forged = structuredClone(publishers);
  const forgedEndpoint = requiredNetworkValue(requiredNetworkValue(forged[0]).endpoints[0]);
  forgedEndpoint.segment = { ...forgedEndpoint.segment, bridge: "unowned" };
  expect(() => sharedNetworkPlan(a, forged, [a, b])).toThrow("Invalid owned DMZ endpoint");
  expect(from.publicRoutes).toHaveLength(2);
  expect(to.publicRoutes).toEqual(from.publicRoutes);
  expect(
    from.publicRoutes.every(
      (route) =>
        route.port === 8080 &&
        route.fromProject === a.project &&
        route.publisherProject === b.project,
    ),
  ).toBe(true);
  expect(retainedPublicPlan(a, JSON.parse(JSON.stringify(from.publicRoutes))).publicRoutes).toEqual(
    from.publicRoutes,
  );
  expect(retainedPublicPlan(b, JSON.parse(JSON.stringify(to.publicRoutes))).publicRoutes).toEqual(
    to.publicRoutes,
  );
  expect(
    sharedNetworkPlan({ ...a, eventId: "other-event" }, publishers, [a, b]).publicRoutes,
  ).toHaveLength(0);
  expect(() =>
    sharedNetworkPlan(
      a,
      [
        {
          plan: b,
          endpoints: [{ segment, service: "publicweb", addresses: ["127.0.0.1"], port: 8080 }],
        },
      ],
      [a, b],
    ),
  ).toThrow();
});
test("network identities are stable, generation-bound, compact and detached", () => {
  const plan = make();
  expect(plan).toEqual(make());
  expect(plan.segments[0]?.bridge.length).toBe(15);
  expect(plan.inputChain.length).toBeLessThanOrEqual(28);
  expect(plan.owner).not.toBe(localNetworkPlan("tch-job-b", subnet).owner);
  expect(plan.owner).not.toBe(
    localNetworkPlan("tch-job-a", subnet, { composeText: source, definition: "edition-b" }).owner,
  );
  for (const value of [plan, plan.segments, plan.segments[0], plan.services, plan.services.web])
    expect(Object.isFrozen(value)).toBe(true);
});
test("generated internal dual-stack bridges preserve Web/DB networking and suppress autonomous restart", () => {
  const plan = make();
  const generated = parse(isolatedCompose(source, plan));
  expect(generated.services.web.image).toBe("sample");
  expect(generated.services.db.image).toBe("sample");
  expect(generated.services.web.restart).toBe("no");
  expect(generated.services.db.restart).toBe("no");
  expect(generated.services.web.network_mode).toBeUndefined();
  expect(generated.services.web.labels["tenkacloud.isolation.generation"]).toBe(plan.generation);
  expect(generated.networks.default).toMatchObject({
    driver: "bridge",
    internal: true,
    enable_ipv6: true,
    driver_opts: { "com.docker.network.bridge.name": plan.segments[0]?.bridge },
  });
  expect(
    generated.networks.default.ipam.config.map((entry: { subnet: string }) => entry.subnet),
  ).toEqual([subnet.default, plan.segments[0]?.ipv6]);
});
test("split problem segments remain distinct and list each service's owned attachments", () => {
  const text =
    "services:\n  web:\n    networks: [front, back]\n  db:\n    networks: [back]\nnetworks:\n  front: {}\n  back: {}\n";
  const plan = localNetworkPlan(
    "tch-split",
    { front: subnet.default, back: subnet.default.replace(".0/", ".16/") },
    { composeText: text, definition: "split" },
  );
  expect(plan.services).toEqual({ web: ["back", "front"], db: ["back"] });
  expect(new Set(plan.segments.map((segment) => segment.bridge)).size).toBe(2);
});
test("malformed, overlapping, unowned or empty allocations fail before any host change", () => {
  expect(() => localNetworkPlan("other-project", subnet)).toThrow();
  expect(() => localNetworkPlan("tch-invalid", {})).toThrow();
  expect(() =>
    localNetworkPlan("tch-invalid", { default: subnet.default.replace(".0/", ".1/") }),
  ).toThrow();
  expect(() => localNetworkPlan("tch-invalid", { a: subnet.default, b: subnet.default })).toThrow();
  expect(() =>
    localNetworkPlan("tch-invalid", subnet, {
      composeText: "services:\n  web:\n    networks: [foreign]\n",
      definition: "bad",
    }),
  ).toThrow();
});
test("routed LAN/VPN or any overlapping IPv6 reservation blocks a new plan", () => {
  const plan = make();
  expect(() => assertNoNetworkOverlap(plan, [])).not.toThrow();
  expect(() => assertNoNetworkOverlap(plan, [subnet.default.replace("/28", "/24")])).toThrow(
    "overlaps",
  );
  expect(() => assertNoNetworkOverlap(plan, [requiredNetworkValue(plan.segments[0]).ipv6])).toThrow(
    "overlaps",
  );
  expect(() =>
    assertNoNetworkOverlap(plan, [
      requiredNetworkValue(plan.segments[0]).ipv6.replace("/64", "/48"),
    ]),
  ).toThrow();
});
test("six independently owned plans have distinct bridge, chain and IPv6 identities", () => {
  const plans = Array.from({ length: 6 }, (_, index) =>
    localNetworkPlan(`tch-team-${index}`, {
      default: subnet.default.replace(".0/", `.${index * 16}/`),
    }),
  );
  expect(new Set(plans.map((plan) => plan.segments[0]?.bridge)).size).toBe(6);
  expect(new Set(plans.map((plan) => plan.inputChain)).size).toBe(6);
  expect(new Set(plans.map((plan) => plan.segments[0]?.ipv6)).size).toBe(6);
});

/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic addresses are test data and are never contacted. */
test("egress Compose attaches only the named service to an owned non-internal default gateway", () => {
  const services = ["web"];
  const document = parse(source);
  const request = {
    id: "upstream",
    service: "web",
    destination: "8.8.8.8",
    port: 443,
    purpose: "Synthetic upstream",
  };
  const authored = egressComposeSource(source, services);
  const subnets = allocateNetworkSubnets(authored, "10.240.0.0/24", []);
  const plan = localNetworkPlan("tch-egress-compose", subnets, {
    composeText: authored,
    definition: "pinned",
    egress: [request],
  });
  const actual = parse(isolatedCompose(source, plan));
  const segment = requiredNetworkValue(plan.egressSegments[0]);
  expect(segment.bridge).toMatch(/^tce[a-f0-9]{12}$/u);
  expect(actual.networks[segment.name].internal).toBe(false);
  expect(actual.networks[segment.name].labels["tenkacloud.isolation.owner"]).toBe(plan.owner);
  expect(actual.networks[segment.name].driver_opts["com.docker.network.bridge.name"]).toBe(
    segment.bridge,
  );
  expect(
    actual.networks[segment.name].ipam.config.map((entry: { subnet: string }) => entry.subnet),
  ).toEqual([segment.ipv4, segment.ipv6]);
  expect(actual.services.web.dns).toEqual(["10.240.0.17"]);
  expect(actual.services.db.dns).toBeUndefined();
  const authoredDns = source.replace("image: sample", "image: sample\n    dns: [8.8.8.8]");
  expect(() => isolatedCompose(authoredDns, plan)).toThrow(
    "services.web.dns is not in the reviewed allowlist",
  );
  expect(actual.services.web.networks[segment.name]).toEqual({ gw_priority: 1 });
  expect(
    Object.entries(actual.services.web.networks).filter(
      ([, value]) => (value as { gw_priority?: number })?.gw_priority === 1,
    ),
  ).toHaveLength(1);
  expect(actual.services.db.networks).toBeUndefined();
  expect(plan.services.db).not.toContain(segment.name);
  expect(plan.services.web).toContain(segment.name);
  expect(document.services.web.networks).toBeUndefined();
  const denied = make();
  expect(denied.egressSegments).toEqual([]);
  const deniedCompose = parse(isolatedCompose(source, denied));
  expect(deniedCompose.services.web.dns).toBeUndefined();
  expect(deniedCompose.services.db.dns).toBeUndefined();
  expect(
    Object.values(parse(isolatedCompose(source, denied)).networks).every(
      (network) => (network as { internal: boolean }).internal,
    ),
  ).toBe(true);
});

/* eslint-enable sonarjs/no-hardcoded-ip */

for (const source of [
  "services: {app: {image: synthetic}}\nnetworks: {egress-authored: null}",
  "services: {app: {image: synthetic}, db: {image: synthetic, networks: [egress-authored]}}",
  "services: {app: {image: synthetic}, db: {image: synthetic, networks: {egress-authored: {}}}}",
])
  for (const services of [[], ["app"]])
    test("egress composition refuses authored reserved networks before Docker even without grants", () => {
      expect(() => egressComposeSource(source, services)).toThrow(
        "Authored networks cannot use the reserved egress- prefix.",
      );
    });
