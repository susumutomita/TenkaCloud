import { describe, expect, it } from "bun:test";
import {
  BOM_CONSUMERS,
  type BomConsumer,
  findBomConsumerDrift,
  formatBomConsumerDrift,
} from "./check-bom-consumers";
import { readReleaseManifest } from "./manifest";

const manifest = readReleaseManifest();

describe("in-product BOM consumers", () => {
  it("keeps every shipped BOM value equal to the checked-in manifest", () => {
    expect(formatBomConsumerDrift(findBomConsumerDrift(manifest))).toBe("");
  });

  it("covers the Simulator image the local-play launcher actually runs", () => {
    const simulator = BOM_CONSUMERS.find(({ consumer }) =>
      consumer.includes("DEFAULT_SIMULATOR_IMAGE"),
    );
    expect(simulator?.actual).toBe(manifest.artifacts.simulatorImage);
  });

  it("reports drift with both values and why the value is part of the BOM", () => {
    const stale: BomConsumer = {
      consumer: "scripts/example.ts STALE_IMAGE",
      reason: "the release would claim a Simulator it does not launch",
      actual: `ghcr.io/susumutomita/tenkacloud-simulator@sha256:${"0".repeat(64)}`,
      expected: (current) => current.artifacts.simulatorImage,
    };
    const drift = findBomConsumerDrift(manifest, [stale]);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.actual).toBe(stale.actual);
    expect(drift[0]?.expected).toBe(manifest.artifacts.simulatorImage);
    const formatted = formatBomConsumerDrift(drift);
    expect(formatted).toContain("scripts/example.ts STALE_IMAGE");
    expect(formatted).toContain(manifest.artifacts.simulatorImage);
    expect(formatted).toContain("does not launch");
  });

  it("passes a consumer that already agrees with the manifest", () => {
    const agreeing: BomConsumer = {
      consumer: "scripts/example.ts CURRENT_IMAGE",
      reason: "checked",
      actual: manifest.artifacts.simulatorImage,
      expected: (current) => current.artifacts.simulatorImage,
    };
    expect(findBomConsumerDrift(manifest, [agreeing])).toEqual([]);
  });
});
