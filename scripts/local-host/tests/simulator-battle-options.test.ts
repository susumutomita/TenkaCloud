import { describe, expect, test } from "bun:test";
import { parseOptions } from "../options";
import { battleCLIOptions } from "../simulator-battle-options";

const pin = "a".repeat(64);
const values = {
  "simulator-binary": "/owned/simulator",
  "simulator-binary-sha256": pin,
  "simulator-battle-config": "/owned/runtime.json",
  "simulator-battle-config-sha256": pin,
};
const args = Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]);
describe("explicit pinned Battle CLI selection", () => {
  test("ordinary selection stays unchanged", () => {
    expect(battleCLIOptions({}, true)).toBeUndefined();
    expect(parseOptions([], "/repo").managedSimulator).toEqual({});
  });
  test("passes exact pins through actual Host options", () => {
    expect(parseOptions(args, "/repo").managedSimulator).toEqual({
      binary: values["simulator-binary"],
      battle: {
        binarySha256: pin,
        runtimeConfigPath: "/owned/runtime.json",
        runtimeConfigSha256: pin,
      },
    });
  });
  test("rejects each missing member instead of falling back", () => {
    for (const key of Object.keys(values)) {
      const incomplete = Object.fromEntries(
        Object.entries(values).filter(([name]) => name !== key),
      );
      expect(() => battleCLIOptions(incomplete, true)).toThrow();
    }
  });
  test("rejects relative and noncanonical paths and malformed pins", () => {
    for (const path of ["runtime.json", "/owned/../runtime.json", ""]) {
      expect(() =>
        battleCLIOptions({ ...values, "simulator-battle-config": path }, true),
      ).toThrow();
      expect(() => battleCLIOptions({ ...values, "simulator-binary": path }, true)).toThrow();
    }
    for (const hash of ["A".repeat(64), "a".repeat(63), "", "not-a-pin"]) {
      expect(() =>
        battleCLIOptions({ ...values, "simulator-binary-sha256": hash }, true),
      ).toThrow();
      expect(() =>
        battleCLIOptions({ ...values, "simulator-battle-config-sha256": hash }, true),
      ).toThrow();
    }
  });
  test("rejects disabled, updating, proxy and nonlocal startup", () => {
    for (const flag of ["--no-simulator", "--update-simulator", "--behind-proxy"])
      expect(() => parseOptions([...args, flag], "/repo")).toThrow();
    expect(() => battleCLIOptions(values, false)).toThrow();
    expect(() =>
      parseOptions([...args, "--lan", [192, 168, 1, 10].join("."), "--unsafe-lan"], "/repo"),
    ).toThrow();
    expect(() =>
      parseOptions(
        [
          ...args,
          "--simulator-endpoint",
          "http://127.0.0.1:4566",
          "--simulator-token",
          "fixture-token",
        ],
        "/repo",
      ),
    ).toThrow();
  });
});
