// @vitest-environment node
import type { Plugin, PluginOption } from "vite";
import { expect, it } from "vitest";
import cloud from "../vite.config";
import host from "../vite.host.config";

it("keeps local search imports and their oversized WASM out of cloud/demo builds", () => {
  const boundary = cloud.plugins?.find(
    (plugin: PluginOption) =>
      plugin &&
      typeof plugin === "object" &&
      "name" in plugin &&
      plugin.name === "cloud-purpose-search-boundary",
  ) as Plugin;
  expect(cloud.define?.__TENKACLOUD_LOCAL_HOST_BUILD__).toBe("false");
  expect(boundary.enforce).toBe("pre");
  expect(boundary.apply).toBe("build");
  if (typeof boundary.resolveId !== "function" || typeof boundary.load !== "function")
    throw new Error("Expected build hooks");
  const context = Object.create(null) as ThisParameterType<typeof boundary.resolveId>;
  const options = { isEntry: false, attributes: {} };
  const blocked = boundary.resolveId.call(
    context,
    "./SemanticProblemSearch",
    "/src/pages/event-create/EventCreateProblemsetSection.tsx",
    options,
  );
  expect(blocked).toBe("\0tenkacloud-purpose-search-not-local");
  expect(
    boundary.resolveId.call(
      context,
      "./ScrollableProblemList",
      "/src/pages/event-create/EventCreateProblemsetSection.tsx",
      options,
    ),
  ).toBeNull();
  expect(
    boundary.resolveId.call(context, "./SemanticProblemSearch", "/other.tsx", options),
  ).toBeNull();
  expect(boundary.load.call(context, String(blocked), {})).toContain(
    "requires the local host build",
  );
  expect(boundary.load.call(context, "/other.tsx", {})).toBeNull();
  expect(host.define?.__TENKACLOUD_LOCAL_HOST_BUILD__).toBe("true");
  expect(
    host.plugins?.some(
      (plugin: PluginOption) =>
        plugin && typeof plugin === "object" && "name" in plugin && plugin.name === boundary.name,
    ),
  ).toBe(false);
});
