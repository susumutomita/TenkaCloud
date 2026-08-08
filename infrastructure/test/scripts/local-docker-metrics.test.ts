import { describe, expect, it } from "vitest";
import {
  formatBytes,
  LOCAL_CONTROL_PLANE_CONTAINER,
  parseDiskAvailableBytes,
  parseDockerInfo,
  parseDockerStats,
  parseSize,
  selectOwnContainers,
  summarize,
} from "../../../scripts/local/docker-metrics";

/**
 * [Issue #2909] The published local-mode requirement numbers are only as
 * trustworthy as the parsing behind them, so the two mistakes that would
 * silently inflate them get their own cases: summing the right-hand side of
 * `MemUsage` (the VM limit, repeated on every row) and counting containers the
 * measurer happens to be running for something else.
 */

describe("parseSize", () => {
  it("should parse binary units at 1024 and decimal units at 1000", () => {
    expect(parseSize("1KiB")).toBe(1024);
    expect(parseSize("1kB")).toBe(1000);
    expect(parseSize("1MiB")).toBe(1024 * 1024);
    expect(parseSize("1GiB")).toBe(1024 ** 3);
    expect(parseSize("1TiB")).toBe(1024 ** 4);
    expect(parseSize("1TB")).toBe(1000 ** 4);
  });

  it("should parse a fractional value with surrounding whitespace", () => {
    expect(parseSize(" 128.6MiB ")).toBeCloseTo(128.6 * 1024 * 1024, 5);
  });

  it("should treat a bare number as bytes", () => {
    expect(parseSize("755000000")).toBe(755000000);
    expect(parseSize("0B")).toBe(0);
  });

  it("should return undefined for an unrecognised unit or non-numeric text", () => {
    expect(parseSize("12ZB")).toBeUndefined();
    expect(parseSize("N/A")).toBeUndefined();
    expect(parseSize("")).toBeUndefined();
  });
});

describe("parseDockerStats", () => {
  const stats = [
    "tenkacloud-local\t1.20%\t119MiB / 3.813GiB",
    "tc-local-sqli-demo-web-1\t0.01%\t16MiB / 3.813GiB",
  ].join("\n");

  it("should read only the used side of MemUsage, not the VM limit", () => {
    const samples = parseDockerStats(stats);

    expect(samples).toHaveLength(2);
    expect(samples[0].memBytes).toBe(119 * 1024 * 1024);
    // The 3.813GiB limit must not appear anywhere in the parsed totals.
    expect(summarize(samples).totalMemBytes).toBeLessThan(1024 ** 3);
  });

  it("should keep the container name and CPU percentage", () => {
    const samples = parseDockerStats(stats);

    expect(samples[0].name).toBe(LOCAL_CONTROL_PLANE_CONTAINER);
    expect(samples[0].cpuPercent).toBe(1.2);
  });

  it("should skip blank lines and rows with too few fields", () => {
    expect(parseDockerStats("\n\n")).toEqual([]);
    expect(parseDockerStats("only-a-name\t5.00%")).toEqual([]);
  });

  it("should skip a row whose memory cannot be parsed rather than recording it as zero", () => {
    const samples = parseDockerStats("tenkacloud-local\t1.00%\t-- / --");

    expect(samples).toEqual([]);
  });

  it("should record an unparseable CPU percentage as zero without dropping the row", () => {
    const samples = parseDockerStats("tenkacloud-local\t--\t119MiB / 3.813GiB");

    expect(samples).toHaveLength(1);
    expect(samples[0].cpuPercent).toBe(0);
  });
});

describe("selectOwnContainers", () => {
  it("should keep the control plane and tc-local- problem containers", () => {
    const kept = selectOwnContainers([
      { name: "tenkacloud-local", cpuPercent: 1, memBytes: 10 },
      { name: "tc-local-sqli-demo-web-1", cpuPercent: 1, memBytes: 10 },
    ]);

    expect(kept.map((sample) => sample.name)).toEqual([
      "tenkacloud-local",
      "tc-local-sqli-demo-web-1",
    ]);
  });

  it("should drop unrelated containers so a measurer's own workload cannot inflate a published number", () => {
    const kept = selectOwnContainers([
      { name: "tenkacloud-local", cpuPercent: 1, memBytes: 10 },
      { name: "my-unrelated-postgres", cpuPercent: 90, memBytes: 8 * 1024 ** 3 },
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0].name).toBe("tenkacloud-local");
  });
});

describe("summarize", () => {
  it("should total memory and CPU across the owned containers", () => {
    const usage = summarize([
      { name: "a", cpuPercent: 1.5, memBytes: 100 },
      { name: "b", cpuPercent: 0.25, memBytes: 300 },
    ]);

    expect(usage.containerCount).toBe(2);
    expect(usage.totalMemBytes).toBe(400);
    expect(usage.totalCpuPercent).toBe(1.75);
  });

  it("should sort containers by descending memory so the dominant term reads first", () => {
    const usage = summarize([
      { name: "small", cpuPercent: 0, memBytes: 16 },
      { name: "control-plane", cpuPercent: 0, memBytes: 119 },
    ]);

    expect(usage.containers.map((container) => container.name)).toEqual(["control-plane", "small"]);
  });

  it("should report zeroes for an empty sample set", () => {
    expect(summarize([])).toEqual({
      containerCount: 0,
      totalMemBytes: 0,
      totalCpuPercent: 0,
      containers: [],
    });
  });
});

describe("parseDockerInfo", () => {
  it("should read the CPU count, memory, versions and architecture", () => {
    const facts = parseDockerInfo("4\t4090956349\t29.6.1\tUbuntu 24.04.4 LTS\taarch64");

    expect(facts).toEqual({
      cpus: 4,
      memoryBytes: 4090956349,
      serverVersion: "29.6.1",
      operatingSystem: "Ubuntu 24.04.4 LTS",
      architecture: "aarch64",
    });
  });

  it("should map the daemon-down template output (zeros and blanks) to undefined, not to zero", () => {
    // The Docker CLI still renders the template when the daemon is unreachable and
    // reports the failure only on stderr; treating that as a real 0 would let a
    // profile check pass against a daemon that is not running.
    const facts = parseDockerInfo("0\t0\t\t\t");

    expect(facts.cpus).toBeUndefined();
    expect(facts.memoryBytes).toBeUndefined();
    expect(facts.serverVersion).toBeUndefined();
    expect(facts.operatingSystem).toBeUndefined();
    expect(facts.architecture).toBeUndefined();
  });

  it("should ignore everything after the first line", () => {
    const facts = parseDockerInfo("2\t1024\tv\tos\tarch\n99\t99\tx\ty\tz");

    expect(facts.cpus).toBe(2);
  });

  it("should return all-undefined for empty output", () => {
    expect(parseDockerInfo("")).toEqual({
      cpus: undefined,
      memoryBytes: undefined,
      serverVersion: undefined,
      operatingSystem: undefined,
      architecture: undefined,
    });
  });
});

describe("parseDiskAvailableBytes", () => {
  const df = [
    "Filesystem     1024-blocks     Used Available Capacity Mounted on",
    "overlay           61202244 15551096  42513524      27% /",
    "tmpfs                65536        0     65536       0% /dev",
  ].join("\n");

  it("should read the available column of the root filesystem row as bytes", () => {
    expect(parseDiskAvailableBytes(df)).toBe(42513524 * 1024);
  });

  it("should ignore rows for other mount points", () => {
    const other = "tmpfs 65536 0 65536 0% /dev";

    expect(parseDiskAvailableBytes(other)).toBeUndefined();
  });

  it("should return undefined when the available column is not a number", () => {
    expect(parseDiskAvailableBytes("overlay 1 2 - 27% /")).toBeUndefined();
  });

  it("should return undefined for empty output", () => {
    expect(parseDiskAvailableBytes("")).toBeUndefined();
  });
});

describe("formatBytes", () => {
  it("should render GiB, MiB and raw bytes", () => {
    expect(formatBytes(4090956349)).toBe("3.81 GiB");
    expect(formatBytes(142606336)).toBe("136 MiB");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("should render an unread value as unknown rather than as zero", () => {
    expect(formatBytes(undefined)).toBe("unknown");
  });
});
