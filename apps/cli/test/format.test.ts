import { describe, expect, it } from "vitest";
import { formatCsv, formatJson, formatPretty, parseFormat } from "../src/output/format.ts";

describe("parseFormat", () => {
  it("should return json when --json flag present", () => {
    expect(parseFormat(["--json"])).toBe("json");
  });
  it("should return csv when --csv flag present", () => {
    expect(parseFormat(["--csv"])).toBe("csv");
  });
  it("should default to pretty", () => {
    expect(parseFormat(["foo", "--name", "bar"])).toBe("pretty");
  });
});

describe("formatJson", () => {
  it("should produce indented JSON", () => {
    const result = formatJson({ a: 1 });
    expect(result).toContain('"a": 1');
  });
});

describe("formatCsv", () => {
  it("should produce header + rows for object array", () => {
    const csv = formatCsv([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
    expect(csv).toBe("id,name\na,Alpha\nb,Beta");
  });
  it("should respect explicit columns", () => {
    const csv = formatCsv([{ id: "a", name: "A" }], { columns: ["name"] });
    expect(csv).toBe("name\nA");
  });
  it("should escape commas and quotes", () => {
    const csv = formatCsv([{ x: 'a,"b"' }]);
    expect(csv).toBe(`x\n"a,""b"""`);
  });
  it("should return empty string for empty array", () => {
    expect(formatCsv([])).toBe("");
  });
});

describe("formatPretty", () => {
  it("should render ascii box for object array", () => {
    const out = formatPretty([{ id: "a", n: 1 }]);
    expect(out).toMatch(/\+[-+]+\+/);
    expect(out).toContain("id");
    expect(out).toContain("a");
  });
  it("should print no-results message on empty", () => {
    expect(formatPretty([])).toBe("(no results)");
  });
});
