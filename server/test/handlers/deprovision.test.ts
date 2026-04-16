import { describe, it, expect, vi } from "vitest";
import { deprovisionTenant, type DeprovisionInput } from "../../lib/handlers/deprovision";

describe("deprovisionTenant", () => {
  const input: DeprovisionInput = {
    tenantId: "tenant-123",
    cfnStackPrefix: "tenant",
  };

  it("should delete the stack and return deleted status", async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    const mockClient = { send: mockSend } as unknown;

    const result = await deprovisionTenant(input, mockClient);

    expect(result.registrationStatus).toBe("deleted");
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("should return deleted when stack does not exist", async () => {
    const mockSend = vi.fn().mockRejectedValue(new Error("Stack does not exist"));
    const mockClient = { send: mockSend } as unknown;

    const result = await deprovisionTenant(input, mockClient);

    expect(result.registrationStatus).toBe("deleted");
  });

  it("should propagate unexpected errors", async () => {
    const mockSend = vi.fn().mockRejectedValue(new Error("Access denied"));
    const mockClient = { send: mockSend } as unknown;

    await expect(deprovisionTenant(input, mockClient)).rejects.toThrow("Access denied");
  });
});
