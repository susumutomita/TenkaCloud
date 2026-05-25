import { describe, expect, it } from "vitest";
import { parseFlags, requireFlag, requirePositional } from "../src/commands/args.ts";

describe("parseFlags", () => {
  it("should parse positional + flag pairs", () => {
    const r = parseFlags(["tenant-1", "--name", "foo"]);
    expect(r.positional).toEqual(["tenant-1"]);
    expect(r.flags).toEqual({ name: "foo" });
  });
  it("should treat trailing --flag as switch", () => {
    const r = parseFlags(["--json"]);
    expect(r.switches).toEqual(["json"]);
    expect(r.flags).toEqual({});
  });
  it("should not consume the next flag as value", () => {
    const r = parseFlags(["--csv", "--name", "x"]);
    expect(r.switches).toContain("csv");
    expect(r.flags.name).toBe("x");
  });
});

describe("requireFlag / requirePositional", () => {
  it("should throw on missing flag", () => {
    expect(() => requireFlag({ positional: [], flags: {}, switches: [] }, "name")).toThrow(
      /--name/,
    );
  });
  it("should return value when present", () => {
    expect(requireFlag({ positional: [], flags: { x: "1" }, switches: [] }, "x")).toBe("1");
  });
  it("should throw on missing positional", () => {
    expect(() => requirePositional({ positional: [], flags: {}, switches: [] }, 0, "<id>")).toThrow(
      /<id>/,
    );
  });
});
