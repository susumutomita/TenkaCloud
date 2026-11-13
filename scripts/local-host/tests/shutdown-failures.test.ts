import { expect, test } from "bun:test";
import { throwShutdownFailures } from "../shutdown-failures";

test("shutdown without cleanup failures returns normally", () => {
  expect(() => throwShutdownFailures([], [], [])).not.toThrow();
});
test("simultaneous Battle Docker VPN failures all retain their cause and visibility", () => {
  const battle = new Error("unconfirmed seal");
  const vpn = new Error("guard join failed");
  try {
    throwShutdownFailures([battle], ["team-a status=FAILED"], [vpn]);
    throw new Error("Expected shutdown failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    const combined = error as AggregateError;
    expect(combined.errors).toHaveLength(3);
    expect(combined.message).toContain("Battle cleanup unconfirmed");
    expect(combined.message).toContain("owned Docker jobs are not confirmed stopped");
    expect(combined.message).toContain("VPN closure failed");
    expect((combined.errors[0] as AggregateError).errors).toEqual([battle]);
    expect((combined.errors[2] as AggregateError).errors).toEqual([vpn]);
  }
});
test("single-category shutdown preserves its specific error", () => {
  expect(() => throwShutdownFailures([], ["team"], [])).toThrow("owned Docker jobs");
  expect(() => throwShutdownFailures([new Error("seal")], [], [])).toThrow("Battle cleanup");
  expect(() => throwShutdownFailures([], [], [new Error("guard")])).toThrow("VPN closure");
});
