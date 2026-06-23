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
  it("should skip undefined holes in a sparse args array", () => {
    // a sparse array yields `undefined` for the hole → the `raw === undefined` guard.
    const sparse: string[] = ["a"];
    sparse[2] = "b";
    const r = parseFlags(sparse);
    expect(r.positional).toEqual(["a", "b"]);
    expect(r.flags).toEqual({});
    expect(r.switches).toEqual([]);
  });
  it("should return empty result for empty args", () => {
    const r = parseFlags([]);
    expect(r.positional).toEqual([]);
    expect(r.flags).toEqual({});
    expect(r.switches).toEqual([]);
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
  it("should throw on empty-string positional", () => {
    expect(() =>
      requirePositional({ positional: [""], flags: {}, switches: [] }, 0, "<id>"),
    ).toThrow(/<id>/);
  });
  it("should throw on empty-string flag", () => {
    expect(() =>
      requireFlag({ positional: [], flags: { name: "" }, switches: [] }, "name"),
    ).toThrow(/--name/);
  });
  it("should return positional value when present", () => {
    expect(requirePositional({ positional: ["abc"], flags: {}, switches: [] }, 0, "<id>")).toBe(
      "abc",
    );
  });
});
