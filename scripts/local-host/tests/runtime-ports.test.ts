import { beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { assertComposePolicy } from "../container/compose-policy";
import { remapComposeHostPorts, remapContainerProblem } from "../container/port-remap";
import { type DockerDefinition, loadDockerCatalog } from "../docker-catalog";
import {
  allocateRuntimePorts,
  DEFAULT_RUNTIME_PORTS,
  publishedComposePorts,
  type RuntimePortRequest,
  type RuntimePorts,
  remapRuntimeComposePorts,
  validateRuntimePorts,
} from "../runtime-ports";

const COMPOSE = [
  "services:",
  "  app:",
  "    ports:",
  '      - "127.0.0.1:18080:8080" # challenge',
  '      - "localhost:18081:8081" # verifier',
  "    healthcheck:",
  '      test: ["CMD", "curl", "http://127.0.0.1:8080/healthz"]',
].join("\n");
const root = fileURLToPath(new URL("../../../", import.meta.url));
let catalog: DockerDefinition[];
beforeAll(() => {
  catalog = loadDockerCatalog(root).map(
    (problem) => JSON.parse(problem.definition) as DockerDefinition,
  );
});

function request(jobId: string, composeText = COMPOSE): RuntimePortRequest {
  return { jobId, composeText };
}

function targets(plan: ReadonlyMap<string, RuntimePorts>): number[] {
  return [...plan.values()].flatMap((ports) => Object.values(ports));
}

function assignment(plan: ReadonlyMap<string, RuntimePorts>, jobId: string): RuntimePorts {
  const value = plan.get(jobId);
  if (!value) throw new Error(`Missing plan for ${jobId}`);
  return value;
}

function twentyProblemBatch(): RuntimePortRequest[] {
  return catalog.slice(0, 20).flatMap((definition) =>
    Array.from({ length: 5 }, (_, team) => ({
      jobId: `${definition.problem.problemId}:team-${team}`,
      composeText: definition.composeText,
    })),
  );
}

function requiredPorts(requests: readonly RuntimePortRequest[]): number {
  return requests.reduce(
    (total, item) => total + publishedComposePorts(item.composeText).length,
    0,
  );
}

test("all 106 real catalog problems use exact dense maps and remain Compose-policy compliant", async () => {
  expect(catalog).toHaveLength(106);
  const requests = catalog.map((definition) =>
    request(definition.problem.problemId, definition.composeText),
  );
  const plan = await allocateRuntimePorts(requests, { isAvailable: () => true });
  expect(plan.size).toBe(106);
  expect(targets(plan)).toHaveLength(requiredPorts(requests));
  expect(new Set(targets(plan)).size).toBe(targets(plan).length);
  for (const definition of catalog) {
    const map = assignment(plan, definition.problem.problemId);
    const moved = remapRuntimeComposePorts(definition.composeText, 0, map);
    expect([...remapComposeHostPorts(moved.text, 0).portMap.keys()].sort((a, b) => a - b)).toEqual(
      Object.values(map).sort((a, b) => a - b),
    );
    assertComposePolicy(moved.text, {
      problemDir: definition.problem.problemDir,
      composePath: definition.problem.composePath,
    });
    const problem = remapContainerProblem(definition.problem, moved.portMap);
    const originalVerifier = new URL(definition.problem.verifyUrl);
    const verifierPort = map[originalVerifier.port];
    if (verifierPort === undefined)
      throw new Error("Catalog verifier must be explicitly published.");
    expect(Number(new URL(problem.verifyUrl).port)).toBe(verifierPort);
    expect(problem.problemId).toBe(definition.problem.problemId);
    expect(problem.composePath).toBe(definition.problem.composePath);
  }
});

test("20 real problems × 5 teams fit a deterministic 100-job plan without 1000-port blocks", async () => {
  const requests = twentyProblemBatch();
  expect(requests).toHaveLength(100);
  const needed = requiredPorts(requests);
  const options = {
    reservedPorts: [20_000, 20_001],
    gatewayPorts: { start: 20_002, end: 20_004 },
    listenerPorts: [20_005, 20_006],
    range: { start: 20_000, end: 20_006 + needed },
    isAvailable: () => true,
  };
  const plan = await allocateRuntimePorts(requests, options);
  expect(plan.size).toBe(100);
  expect(targets(plan)).toHaveLength(needed);
  expect(targets(plan)).toEqual(Array.from({ length: needed }, (_, index) => 20_007 + index));
  expect(await allocateRuntimePorts([...requests].reverse(), options)).toEqual(plan);
  expect(needed).toBeLessThan(300);
});

test("repeated base declarations allocate once; empty declarations need no ports", async () => {
  const repeated = COMPOSE.replace(
    '      - "localhost:18081:8081"',
    '      - "127.0.0.1:18080:8080/tcp"\n      - "localhost:18081:8081"',
  );
  const probes: number[] = [];
  const plan = await allocateRuntimePorts(
    [request("repeated", repeated), request("empty", "services: {}")],
    {
      isAvailable: (port) => {
        probes.push(port);
        return true;
      },
    },
  );
  expect(assignment(plan, "repeated")).toEqual({ 18080: 20_000, 18081: 20_001 });
  expect(assignment(plan, "empty")).toEqual({});
  expect(probes).toEqual([20_000, 20_001]);
  expect(remapRuntimeComposePorts(repeated, 0, assignment(plan, "repeated")).text).toContain(
    '"127.0.0.1:20000:8080/tcp"',
  );
});

test("legacy jobs without maps preserve offset validation, text and all ContainerProblem strings", () => {
  for (const definition of catalog) {
    for (const offset of [0, 1000, 40_000]) {
      const previous = remapComposeHostPorts(definition.composeText, offset);
      const current = remapRuntimeComposePorts(definition.composeText, offset);
      expect(current).toEqual(previous);
      expect(remapContainerProblem(definition.problem, current.portMap)).toEqual(
        remapContainerProblem(definition.problem, previous.portMap),
      );
    }
  }
  expect(() => remapRuntimeComposePorts(COMPOSE, -1)).toThrow("non-negative integer");
  expect(() => remapRuntimeComposePorts(COMPOSE, 60_000)).toThrow("exceeds 65535");
});

test("explicit maps move only published host bindings and every mapped problem string", () => {
  const map = { 18080: 20_008, 18081: 20_009 };
  const moved = remapRuntimeComposePorts(COMPOSE, 100_000, map);
  expect(moved.text).toContain('"127.0.0.1:20008:8080" # challenge');
  expect(moved.text).toContain('"localhost:20009:8081" # verifier');
  expect(moved.text).toContain("http://127.0.0.1:8080/healthz");
  const problem = {
    verifyUrl: "http://localhost:18081/verify",
    challengeEndpoints: { Web: "http://127.0.0.1:18080/" },
    instructions: "curl http://localhost:18080/task",
    scoring: { hints: [{ content: "See http://127.0.0.1:18080/hint", points: 5 }] },
    i18n: { en: { instructions: "curl http://localhost:18080/task" } },
    unmapped: "http://127.0.0.1:8080/healthz",
  };
  const updated = remapContainerProblem(problem, moved.portMap);
  expect(updated.verifyUrl).toBe("http://localhost:20009/verify");
  expect(updated.challengeEndpoints.Web).toBe("http://127.0.0.1:20008/");
  expect(updated.instructions).toBe("curl http://localhost:20008/task");
  expect(updated.i18n.en.instructions).toBe(updated.instructions);
  expect(updated.scoring.hints[0]?.content).toBe("See http://127.0.0.1:20008/hint");
  expect(updated.unmapped).toBe(problem.unmapped);
  expect(problem.verifyUrl).toBe("http://localhost:18081/verify");
});

test("persisted stop/resume maps stay byte-stable and reserve ports against later jobs", async () => {
  const original = await allocateRuntimePorts([request("stopped")], { isAvailable: () => true });
  const map = assignment(original, "stopped");
  const durable = JSON.stringify({ runtimePorts: map, offset: 0, status: "STOPPED" });
  const restored = JSON.parse(durable) as {
    runtimePorts: RuntimePorts;
    offset: number;
    status: string;
  };
  const before = remapRuntimeComposePorts(COMPOSE, 0, map);
  expect(remapRuntimeComposePorts(COMPOSE, restored.offset, restored.runtimePorts)).toEqual(before);
  const next = await allocateRuntimePorts([request("new")], {
    reservedPorts: Object.values(restored.runtimePorts),
    isAvailable: () => true,
  });
  expect(assignment(next, "new")).toEqual({ 18080: 20_002, 18081: 20_003 });
  expect(JSON.stringify(restored)).toBe(durable);
});

test("external occupied ports are skipped, but existing owner/listener/gateway ports are never probed", async () => {
  const probes: number[] = [];
  const owned = new Set([20_000]);
  const plan = await allocateRuntimePorts([request("new")], {
    reservedPorts: owned,
    listenerPorts: [20_001, 20_002],
    gatewayPorts: { start: 20_003, end: 20_005 },
    isAvailable: async (port) => {
      probes.push(port);
      await Promise.resolve();
      return port !== 20_006;
    },
  });
  expect(assignment(plan, "new")).toEqual({ 18080: 20_007, 18081: 20_008 });
  expect(probes).toEqual([20_006, 20_007, 20_008]);
  expect([...owned]).toEqual([20_000]);
});

test("exhaustion and probe failure expose no partial plan and do not mutate inputs or reservations", async () => {
  const requests = [request("a"), request("b")];
  const input = JSON.stringify(requests);
  const owned = new Set([20_000]);
  const committed = new Map<string, RuntimePorts>();
  async function planAndCommit(isAvailable: (port: number) => boolean | Promise<boolean>) {
    const plan = await allocateRuntimePorts(requests, {
      reservedPorts: owned,
      range: { start: 20_000, end: 20_003 },
      isAvailable,
    });
    for (const [id, ports] of plan) committed.set(id, ports);
  }
  await expect(planAndCommit(() => true)).rejects.toThrow("exhausted");
  await expect(
    planAndCommit((port) => {
      if (port === 20_002) throw new Error("external probe failed");
      return true;
    }),
  ).rejects.toThrow("external probe failed");
  expect(committed.size).toBe(0);
  expect([...owned]).toEqual([20_000]);
  expect(JSON.stringify(requests)).toBe(input);
});

test("host-wide caller serialization covers allocation and durable reservation across concurrent batches", async () => {
  const owned = new Set<number>();
  const durable = new Map<string, RuntimePorts>();
  let queue = Promise.resolve();
  function serialized(batch: readonly RuntimePortRequest[]) {
    const operation = queue.then(async () => {
      const plan = await allocateRuntimePorts(batch, {
        reservedPorts: owned,
        isAvailable: async () => {
          await Promise.resolve();
          return true;
        },
      });
      // Same critical section: in the host these job updates are one store transaction.
      for (const [id, ports] of plan) durable.set(id, ports);
      for (const port of targets(plan)) owned.add(port);
    });
    queue = operation.catch(() => undefined);
    return operation;
  }
  await Promise.all(
    Array.from({ length: 10 }, (_, batch) =>
      serialized(Array.from({ length: 10 }, (_, job) => request(`batch-${batch}:job-${job}`))),
    ),
  );
  expect(durable.size).toBe(100);
  expect(targets(durable)).toHaveLength(200);
  expect(new Set(targets(durable)).size).toBe(200);
  expect(owned.size).toBe(200);
});

test("explicitly documents that stale concurrent snapshots are not an OS reservation or host lock", async () => {
  const [one, two] = await Promise.all([
    allocateRuntimePorts([request("one")], { isAvailable: () => true }),
    allocateRuntimePorts([request("two")], { isAvailable: () => true }),
  ]);
  expect(targets(one)).toEqual(targets(two));
});

for (const [label, invalid] of [
  ["missing", { 18080: 20_000 }],
  ["extra", { 18080: 20_000, 18081: 20_001, 19000: 20_002 }],
  ["noncanonical", { "018080": 20_000, 18081: 20_001 }],
  ["duplicate", { 18080: 20_000, 18081: 20_000 }],
  ["null", null],
  ["array", [20_000, 20_001]],
  ["string", "18080:20000"],
] as const)
  test(`invalid ${label} durable map fails closed`, () => {
    expect(() => validateRuntimePorts(COMPOSE, invalid)).toThrow();
  });

for (const target of [
  0,
  1023,
  19_999,
  61_000,
  65_536,
  20_000.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "20000",
  null,
])
  test(`invalid target ${String(target)} fails closed`, () => {
    expect(() => validateRuntimePorts(COMPOSE, { 18080: target, 18081: 20_001 })).toThrow(
      "outside",
    );
  });

test("foreign ownership, gateway and listener targets cannot be adopted by an explicit map", () => {
  const map = { 18080: 20_000, 18081: 20_001 };
  for (const constraints of [
    { reservedPorts: [20_000] },
    { gatewayPorts: { start: 20_000, end: 20_040 } },
    { listenerPorts: [20_001] },
  ])
    expect(() => validateRuntimePorts(COMPOSE, map, constraints)).toThrow("another listener/job");
});

test("invalid allocation input is rejected before availability checks", async () => {
  let probes = 0;
  const isAvailable = () => {
    probes++;
    return true;
  };
  await expect(
    allocateRuntimePorts([request("same"), request("same")], { isAvailable }),
  ).rejects.toThrow("unique");
  await expect(allocateRuntimePorts([request("")], { isAvailable })).rejects.toThrow("nonempty");
  await expect(
    allocateRuntimePorts([request("bad", 'services: {app: {ports: ["127.0.0.1:0:8080"]}}')], {
      isAvailable,
    }),
  ).rejects.toThrow("concrete");
  for (const range of [
    { start: 1023, end: 2000 },
    { start: 3000, end: 2000 },
    { start: 2000, end: 65_536 },
  ])
    await expect(allocateRuntimePorts([request("bad")], { range, isAvailable })).rejects.toThrow(
      "range",
    );
  await expect(
    allocateRuntimePorts([request("bad")], { reservedPorts: [Number.NaN], isAvailable }),
  ).rejects.toThrow("Reserved");
  expect(probes).toBe(0);
  expect(DEFAULT_RUNTIME_PORTS).toEqual({ start: 20_000, end: 60_999 });
});

test("interpolated port defaults are pinned while comments, healthchecks and unrelated env defaults stay unchanged", async () => {
  const compose = [
    "services:",
    "  app:",
    `    image: "\${IMAGE:-example:local}"`,
    "    ports:",
    `      - "\${HOST_BIND:-127.0.0.1}:\${HOST_PORT:-18080}:8080" # keep comment`,
    `      - '\${VERIFY_BINDING:-localhost:18081:8081/tcp}'`,
    '    environment: {EXAMPLE: "127.0.0.1:19999:9999"}',
    '    healthcheck: {test: ["CMD", "curl", "http://127.0.0.1:8080/healthz"]}',
    '# commented: "127.0.0.1:19998:9998"',
  ].join("\n");
  expect(publishedComposePorts(compose)).toEqual([18080, 18081]);
  const plan = await allocateRuntimePorts([request("defaults", compose)], {
    isAvailable: () => true,
  });
  const mapped = remapRuntimeComposePorts(compose, 0, assignment(plan, "defaults"));
  expect(mapped.text).toBe(
    compose
      .replace(`"\${HOST_BIND:-127.0.0.1}:\${HOST_PORT:-18080}:8080"`, '"127.0.0.1:20000:8080"')
      .replace(`'\${VERIFY_BINDING:-localhost:18081:8081/tcp}'`, "'localhost:20001:8081/tcp'"),
  );
  expect(publishedComposePorts(mapped.text)).toEqual([20_000, 20_001]);
});

test("YAML port aliases and service inheritance reuse one rewritten scalar without losing formatting", async () => {
  const compose = [
    "services:",
    "  base: &base",
    "    ports: &ports",
    '      - &publish "127.0.0.1:18080:8080" # retained',
    "  inherited:",
    "    <<: *base",
    "  sequence:",
    "    ports: *ports",
    "  scalar:",
    "    ports: [*publish]",
  ].join("\n");
  const plan = await allocateRuntimePorts([request("aliased", compose)], {
    isAvailable: () => true,
  });
  expect(assignment(plan, "aliased")).toEqual({ 18080: 20_000 });
  const mapped = remapRuntimeComposePorts(compose, 0, assignment(plan, "aliased"));
  expect(mapped.text).toBe(compose.replace("127.0.0.1:18080:8080", "127.0.0.1:20000:8080"));
  expect(publishedComposePorts(mapped.text)).toEqual([20_000]);
});

test("unresolvable, wildcard, malformed and cyclic published bindings fail closed", () => {
  for (const entry of [
    `"127.0.0.1:\${UNKNOWN}:8080"`,
    '"0.0.0.0:18080:8080"',
    '"127.0.0.1:18080:0"',
    "{target: 8080, published: 18080}",
  ])
    expect(() => publishedComposePorts(`services: {app: {ports: [${entry}]}}`)).toThrow();
  expect(() => publishedComposePorts("services: {app: &app {<<: *app}}")).toThrow("non-cyclic");
  expect(() => publishedComposePorts("services: [")).toThrow("Invalid Compose YAML");
});
