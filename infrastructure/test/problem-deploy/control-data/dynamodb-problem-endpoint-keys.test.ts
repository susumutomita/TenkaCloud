import { describe, expect, it } from "vitest";
import {
  buildEndpointPK,
  buildEndpointSK,
} from "../../../lib/problem-deploy/control-data/dynamodb-problem-endpoint-keys";

describe("DynamoDB problem endpoint keys", () => {
  it("should preserve the physical endpoint key contract", () => {
    expect(buildEndpointPK("tenant-1", "team-2", "problem-3")).toBe(
      "TENANT#tenant-1#TEAM#team-2#PROBLEM#problem-3",
    );
    expect(buildEndpointSK("primary-api")).toBe("SLOT#primary-api");
  });
});
