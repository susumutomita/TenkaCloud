import { type DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoDbEventsRepository } from "../../../lib/problem-deploy/control-data/dynamodb-events-repository";

const registration = {
  version: 1,
  enabled: true,
  invitationHash: "digest",
  closesAt: "2027-01-01T00:00:00Z",
  teamIds: [],
  claims: [],
};
const input = {
  tenantId: "tenant-a",
  eventId: "event-a",
  expectedVersion: 0,
  registration,
  now: "2026-09-22T00:00:00.000Z",
};
function setup() {
  const send = vi.fn(async (_command: unknown) => ({}));
  const repo = new DynamoDbEventsRepository(
    { send } as unknown as DynamoDBDocumentClient,
    "Events",
  );
  return { send, repo };
}

describe("registration DynamoDB command boundaries", () => {
  it("uses a consistent read and a conditional tenant/event mutation without returning all fields", async () => {
    const { repo, send } = setup();
    await repo.getEvent("tenant-a", "event-a", true);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    const read = send.mock.calls[0]?.[0];
    if (!(read instanceof GetCommand)) throw new Error("Expected a GetCommand");
    expect(read.input.ConsistentRead).toBe(true);
    expect(await repo.updateRegistration(input)).toBe("updated");
    const command = send.mock.calls[1]?.[0] as UpdateCommand;
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input.Key).toEqual({ PK: "EVENT#event-a", SK: "META" });
    expect(command.input.ConditionExpression).toContain("tenantId = :tenant");
    expect(command.input.ConditionExpression).toContain("expiresAt > :epoch");
    expect(command.input.ConditionExpression).toContain("endsAt > :now");
    expect(command.input.ConditionExpression).toContain("attribute_not_exists(#registration)");
    expect(command.input.ExpressionAttributeNames).not.toHaveProperty("#version");
    expect(command.input.ReturnValues).toBeUndefined();
    await repo.updateRegistration({ ...input, expectedVersion: 1 });
    const next = send.mock.calls[2]?.[0];
    if (!(next instanceof UpdateCommand)) throw new Error("Expected an UpdateCommand");
    expect(next.input.ConditionExpression).toContain("#registration.#version = :version");
  });

  it("retries only conditional conflicts and does not conceal IAM or storage errors", async () => {
    const { repo, send } = setup();
    send.mockRejectedValueOnce(
      Object.assign(new Error("collision"), { name: "ConditionalCheckFailedException" }),
    );
    expect(await repo.updateRegistration(input)).toBe("conflict");
    send.mockRejectedValueOnce(new Error("AccessDeniedException"));
    await expect(repo.updateRegistration(input)).rejects.toThrow("AccessDeniedException");
  });
});
