import { describe, expect, it } from "vitest";
import {
  formatCsv,
  formatJson,
  formatOutput,
  formatPretty,
  parseFormat,
} from "../src/output/format.ts";

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
  it("should print a custom message on empty when provided", () => {
    expect(formatPretty([], { message: "nothing here" })).toBe("nothing here");
  });
  it("should return a string scalar verbatim", () => {
    expect(formatPretty("Deleted: tenant-123")).toBe("Deleted: tenant-123");
  });
  it("should render a single object (not wrapped in an array)", () => {
    // Single object → toRecords returns [data] (format.ts:34).
    const out = formatPretty({ id: "t1", tier: "BASIC" });
    expect(out).toContain("id");
    expect(out).toContain("tier");
    expect(out).toContain("t1");
    expect(out).toContain("BASIC");
  });
  it("should pad missing columns when records have heterogeneous keys", () => {
    // Second record lacks 'name' → row[i] is undefined → `?? ""` branch (format.ts:78).
    const out = formatPretty([{ id: "a", name: "Alpha" }, { id: "b" }]);
    const lines = out.split("\n");
    // Body rows are lines[3] and lines[4]; the second has an empty name cell.
    expect(lines[3]).toContain("Alpha");
    expect(lines[4]).toContain("b");
    expect(lines[4]).not.toContain("Alpha");
    // Every rendered line has identical width (alignment held despite the gap).
    const bodyLines = lines.filter((l) => l.startsWith("|"));
    const widths = new Set(bodyLines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });
});

describe("toRecords (single object via formatCsv)", () => {
  it("should treat a single object as one record", () => {
    expect(formatCsv({ id: "x", n: 2 })).toBe("id,n\nx,2");
  });
});

describe("toRecords (via formatCsv) for scalar and primitive inputs", () => {
  it("should wrap a scalar value under a 'value' column", () => {
    // Non-array, non-object scalar → [{ value: data }] (format.ts:34-35).
    expect(formatCsv(42)).toBe("value\n42");
  });
  it("should wrap primitive array elements under a 'value' column", () => {
    expect(formatCsv([1, "two", true])).toBe("value\n1\ntwo\ntrue");
  });
  it("should treat a null array element as an empty-valued record", () => {
    expect(formatCsv([null])).toBe("value\n");
  });
  it("should produce an empty string for null data", () => {
    expect(formatCsv(null)).toBe("");
  });
});

describe("stringify (via formatCsv) for nested values", () => {
  it("should JSON-encode object/array cell values", () => {
    // A nested object/array cell triggers JSON.stringify (format.ts:48).
    const csv = formatCsv([{ id: "a", meta: { k: 1 }, tags: ["x", "y"] }]);
    expect(csv).toBe('id,meta,tags\na,"{""k"":1}","[""x"",""y""]"');
  });
  it("should render null and undefined cells as empty", () => {
    const csv = formatCsv([{ a: null, b: undefined, c: "z" }], { columns: ["a", "b", "c"] });
    expect(csv).toBe("a,b,c\n,,z");
  });
  it("should render number and boolean cells via String()", () => {
    const csv = formatCsv([{ n: 7, ok: false }]);
    expect(csv).toBe("n,ok\n7,false");
  });
});

describe("formatOutput", () => {
  it("should dispatch to JSON formatting", () => {
    expect(formatOutput({ a: 1 }, "json")).toBe(formatJson({ a: 1 }));
  });
  it("should dispatch to CSV formatting", () => {
    expect(formatOutput([{ a: 1 }], "csv")).toBe(formatCsv([{ a: 1 }]));
  });
  it("should dispatch to pretty formatting", () => {
    expect(formatOutput([{ a: 1 }], "pretty")).toBe(formatPretty([{ a: 1 }]));
  });
  it("should forward options to the CSV formatter", () => {
    expect(formatOutput([{ id: "a", name: "A" }], "csv", { columns: ["name"] })).toBe("name\nA");
  });
});
