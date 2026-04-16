import { describe, it, expect, vi } from "vitest";
import { provisionTenant, type ProvisionInput } from "../../lib/handlers/provision";

describe("provisionTenant", () => {
  const mockSend = vi.fn().mockResolvedValue({});
  const mockClient = { send: mockSend } as any;

  const input: ProvisionInput = {
    tenantId: "tenant-123",
    tier: "basic",
    tablePrefix: "TestApp",
  };

  it("should put tenant metadata to DynamoDB and return created status", async () => {
    const result = await provisionTenant(input, mockClient);

    expect(result.tenantStatus).toBe("created");
    expect(mockSend).toHaveBeenCalledOnce();

    const command = mockSend.mock.calls[0][0];
    expect(command.input.TableName).toBe("TestApp-Tenants");
    expect(command.input.Item.PK.S).toBe("TENANT#tenant-123");
    expect(command.input.Item.tier.S).toBe("basic");
    expect(command.input.Item.status.S).toBe("ACTIVE");
    expect(command.input.Item.EntityType.S).toBe("TENANT");
  });

  it("should propagate DynamoDB errors", async () => {
    mockSend.mockRejectedValueOnce(new Error("Table not found"));

    await expect(provisionTenant(input, mockClient)).rejects.toThrow("Table not found");
  });
});
