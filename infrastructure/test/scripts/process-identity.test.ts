import { describe, expect, it } from "vitest";
import {
  observeProcessIdentity,
  parseProcessObservation,
} from "../../../scripts/local-play/process-identity";

describe("process identity", () => {
  it("should parse a live process state and start time", () => {
    expect(parseProcessObservation("Ss   Tue Jul 14 13:00:00 2026\n")).toBe(
      "Tue Jul 14 13:00:00 2026",
    );
  });

  it("should treat a zombie process as already exited", () => {
    expect(parseProcessObservation("Z    Tue Jul 14 13:00:00 2026\n")).toBeUndefined();
  });

  it("should reject an empty or incomplete process observation", () => {
    expect(parseProcessObservation("")).toBeUndefined();
    expect(parseProcessObservation("Ss")).toBeUndefined();
  });

  it("should observe the current live process", () => {
    expect(observeProcessIdentity(process.pid)).toMatch(/^[a-f0-9]{64}$/);
  });
});
