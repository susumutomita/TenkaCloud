import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import schema from "../../problem-pack/catalog-schema.json";
import { publicMetadata } from "../browser-public-metadata";
import { loadContainerProblem } from "../container/manifest";
import { DockerHostingEngine } from "../docker-engine";
import { normalizeInternetAccess } from "../internet-access";
import type { LocalNetworkGuard } from "../linux-network-guard";
import type { Job } from "../model";
import { networkEngineFixture } from "./network-engine-fixture";

/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic parser inputs and rejected boundary addresses, never contacted. */
const request = {
  id: "upstream",
  service: "app",
  destination: "8.8.8.8",
  port: 443,
  purpose: "Synthetic author-declared endpoint; never contacted",
};

test("catalog requests are bounded, immutable and do not imply approval", () => {
  expect(normalizeInternetAccess(undefined)).toBeUndefined();
  const raw = [{ ...request, purpose: "  Reviewed use  " }];
  const normalized = normalizeInternetAccess(raw);
  expect(normalized).toEqual([{ ...request, purpose: "Reviewed use" }]);
  expect(Object.isFrozen(normalized)).toBe(true);
  expect(Object.isFrozen(normalized?.[0])).toBe(true);
  expect(raw[0]?.purpose).toBe("  Reviewed use  ");
  expect(
    normalizeInternetAccess([{ ...request, destination: "2606:4700:4700:0:0:0:0:1111" }]),
  ).toEqual([{ ...request, destination: "2606:4700:4700::1111" }]);
  for (const invalid of [null, [], true, {}, Array(9).fill(request), [request, request]])
    expect(() => normalizeInternetAccess(invalid)).toThrow();
  expect(() => normalizeInternetAccess([request, { ...request, id: "duplicate-tuple" }])).toThrow();
});

test("requests cannot encode broad grants, protected literals or ambiguous destinations", () => {
  for (const destination of [
    "localhost",
    "example.org",
    "https://example.org/path",
    "*.example.org",
    "8.8.8.8/32",
    "8.8.8.8:443",
    " 8.8.8.8",
    "8.8.8.8 ",
    "0x08080808",
    "127.1",
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "::ffff:127.0.0.1",
    "64:ff9b::808:808",
    "2001::1",
    "2001:db8::1",
    "2002:808:808::1",
    "3fff::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2606:4700:4700::1111%eth0",
    "[2606:4700:4700::1111]",
  ])
    expect(() => normalizeInternetAccess([{ ...request, destination }])).toThrow();
  for (const patch of [
    { approved: true },
    { protocol: "udp" },
    { port: 0 },
    { port: 65536 },
    { port: "443" },
    { port: 443.5 },
    { purpose: " " },
    { purpose: "あ".repeat(171) },
    { service: "*" },
    { id: "-flag" },
    { destination: undefined },
  ])
    expect(() => normalizeInternetAccess([{ ...request, ...patch }])).toThrow();
});

/* eslint-enable sonarjs/no-hardcoded-ip */
test("schema and manifest retain private pinned review material without exposing it to participants", () => {
  const metadata = JSON.parse(
    readFileSync(
      new URL("../../../problems/challenges/sqli-demo/metadata.json", import.meta.url),
      "utf8",
    ),
  );
  metadata.runtime.internetAccess = [request];
  const ajv = new Ajv({ strict: false });
  ajv.addFormat("uri", () => true);
  const validate = ajv.compile(schema);
  expect(validate(metadata)).toBe(true);
  const load = () =>
    loadContainerProblem("/catalog/synthetic", {
      existsSync: () => true,
      readFileSync: () => JSON.stringify(metadata),
    });
  expect(JSON.parse(JSON.stringify(load())).internetAccess).toEqual([request]);
  const projected = publicMetadata(
    JSON.stringify(metadata),
    "/repo/problems/challenges/synthetic/metadata.json",
  );
  expect(projected).not.toContain("internetAccess");
  expect(projected).not.toContain(request.destination);
  metadata.runtime.internetAccess = [{ ...request, approved: true }];
  expect(validate(metadata)).toBe(false);
  expect(load).toThrow();
  metadata.runtime.internetAccess = [request];
  metadata.runtime.provider = "aws";
  metadata.runtime.engine = "cloudformation";
  expect(validate(metadata)).toBe(false);
});

test("saved requests are revalidated before start, resume or recovery can call external tools", async () => {
  const called: string[] = [];
  const guard = new Proxy(
    {},
    {
      get: (_target, key) => () => {
        called.push(String(key));
        throw new Error("Unexpected guard call");
      },
    },
  ) as LocalNetworkGuard;
  const engine = new DockerHostingEngine(
    "/unused",
    "/unused",
    undefined,
    false,
    guard,
    async () => {
      called.push("compose");
    },
    Date.now,
    () => [],
  );
  for (const internetAccess of [[request], [], [{ ...request, approved: true }]]) {
    for (const operation of ["start", "resume", "recover"] as const) {
      const job: Job = {
        jobId: "synthetic",
        eventId: "event",
        teamId: "alpha",
        problemId: "problem",
        definition: JSON.stringify({ problem: { internetAccess } }),
        offset: 0,
        status: "STOPPED",
        unit: null,
      };
      await expect(engine[operation](job, () => called.push("retain"))).rejects.toThrow();
    }
  }
  expect(called).toEqual([]);
});

test("retained request declarations never block stopping or removing an owned environment", async () => {
  const f = networkEngineFixture();
  try {
    const entry = f.engine.catalog()[0];
    if (!entry) throw new Error("Missing synthetic source problem");
    const definition = JSON.parse(entry.definition);
    definition.problem.internetAccess = [request];
    // Synthesize a previously retained version before constructing its generation-bound unit.
    const original = entry.definition;
    Object.assign(entry, { definition: JSON.stringify(definition) });
    const retained = f.add("retained-internet-request");
    Object.assign(entry, { definition: original });
    await retained.admitted;
    const operations: string[] = [];
    Reflect.set(f.engine, "runCompose", async (_unit: unknown, action: string) => {
      operations.push(action);
    });
    await f.engine.pause(retained.job);
    await f.engine.stop(retained.job);
    expect(operations).toEqual(["stop", "down"]);
    expect(f.calls).toContain("remove");
  } finally {
    await f.close();
  }
});
