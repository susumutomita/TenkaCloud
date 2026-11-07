import { expect, test } from "bun:test";
import { deploymentLogCursor, deploymentLogPage, deploymentLogView } from "../deployment-logs";

test("deployment logs project only lifecycle fields and never properties, reasons or physical IDs", () => {
  const result = deploymentLogView([
    {
      StackId: "stack",
      StackName: "stack",
      EventId: "opaque",
      Timestamp: new Date("2026-01-01T00:00:00Z"),
      LogicalResourceId: "HelloParameter",
      ResourceType: "AWS::SSM::Parameter",
      ResourceStatus: "CREATE_COMPLETE",
      ResourceProperties: '{"Value":"TC{secret}"}',
      ResourceStatusReason: "ExternalId=secret",
      PhysicalResourceId: "private-value",
    },
  ]);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.message).toBe("HelloParameter (AWS::SSM::Parameter): CREATE_COMPLETE");
  expect(JSON.stringify(result)).not.toMatch(/secret|private-value|opaque/u);
  expect(result.entries[0]?.level).toBe("success");
});

test("malformed event fields cannot be used as free-form messages", () => {
  expect(
    deploymentLogView([
      {
        StackId: "stack",
        StackName: "stack",
        EventId: "event",
        LogicalResourceId: "TC{secret}",
        ResourceType: "AWS::SSM::Parameter",
        ResourceStatus: "CREATE_COMPLETE",
        Timestamp: new Date(),
      },
    ]).entries,
  ).toEqual([]);
});

test("bounded pagination binds cursors to their own job and preserves native page token", () => {
  const view = deploymentLogView(
    [1, 2, 3].map((n) => ({
      StackId: "stack",
      StackName: "stack",
      EventId: String(n),
      Timestamp: new Date(n * 1000),
      LogicalResourceId: "HelloParameter",
      ResourceType: "AWS::SSM::Parameter",
      ResourceStatus: "CREATE_COMPLETE",
    })),
  );
  const first = deploymentLogPage("job-a", view, 0, 2, undefined, "native-next");
  expect(first.entries).toHaveLength(2);
  const cursor = deploymentLogCursor("job-a", first.nextToken);
  expect(cursor.offset).toBe(2);
  expect(() => deploymentLogCursor("job-b", first.nextToken)).toThrow(
    "Invalid deployment log cursor",
  );
  const second = deploymentLogPage(
    "job-a",
    view,
    cursor.offset,
    2,
    cursor.pageToken,
    "native-next",
  );
  expect(second.entries).toHaveLength(1);
  expect(deploymentLogCursor("job-a", second.nextToken)).toEqual({
    offset: 0,
    pageToken: "native-next",
  });
});

test("all events in an aggregated provider page remain reachable beyond offset 100", () => {
  const view = deploymentLogView(
    Array.from({ length: 251 }, (_, n) => ({
      StackId: "stack",
      StackName: "stack",
      EventId: String(n),
      Timestamp: new Date(n * 1000),
      LogicalResourceId: `Resource${n}`,
      ResourceType: "AWS::SSM::Parameter",
      ResourceStatus: "CREATE_COMPLETE",
    })),
  );
  expect(view.entries).toHaveLength(251);
  const entries = [];
  let cursor: ReturnType<typeof deploymentLogCursor> = { offset: 0 };
  for (let page = 0; page < 7; page++) {
    const result = deploymentLogPage("job", view, cursor.offset, 37, cursor.pageToken, "next");
    expect(result.entries.length).toBeLessThanOrEqual(37);
    entries.push(...result.entries);
    cursor = deploymentLogCursor("job", result.nextToken);
  }
  expect(entries).toEqual([...view.entries]);
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(251);
  expect(cursor).toEqual({ offset: 0, pageToken: "next" });
});

test.each([0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "pagination refuses invalid limit %s",
  (limit) => {
    expect(() => deploymentLogPage("job", { cursor: "", entries: [] }, 0, limit)).toThrow(
      "Invalid deployment log limit",
    );
  },
);

test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("cursor refuses invalid offset %s", (offset) => {
  const token = Buffer.from(JSON.stringify({ jobId: "job", offset })).toString("base64url");
  expect(() => deploymentLogCursor("job", token)).toThrow("Invalid deployment log cursor");
});

test("cursor refuses empty, oversized and invalid provider tokens", () => {
  for (const token of [
    "",
    "a".repeat(4097),
    Buffer.from(
      JSON.stringify({
        jobId: "job",
        offset: 0,
        pageToken: "",
      }),
    ).toString("base64url"),
  ]) {
    expect(() => deploymentLogCursor("job", token)).toThrow("Invalid deployment log cursor");
  }
});

test("page refuses offsets outside the projected history", () => {
  for (const offset of [-1, 1, Number.NaN])
    expect(() => deploymentLogPage("job", { cursor: "", entries: [] }, offset, 1)).toThrow(
      "Invalid deployment log cursor",
    );
});

test("equal timestamps preserve provider lifecycle order rather than hashed IDs", () => {
  const events = (["CREATE_COMPLETE", "CREATE_IN_PROGRESS"] as const).map((status) => ({
    StackId: "stack",
    StackName: "stack",
    EventId: `event-0-${status}`,
    Timestamp: new Date("2026-01-01T00:00:00Z"),
    LogicalResourceId: "ParticipantViewerRole",
    ResourceType: "AWS::IAM::Role",
    ResourceStatus: status,
  }));
  const view = deploymentLogView(events);
  expect(view.entries.map((entry) => entry.message)).toEqual([
    "ParticipantViewerRole (AWS::IAM::Role): CREATE_IN_PROGRESS",
    "ParticipantViewerRole (AWS::IAM::Role): CREATE_COMPLETE",
  ]);
  const first = deploymentLogPage("job", view, 0, 1);
  const next = deploymentLogCursor("job", first.nextToken);
  const second = deploymentLogPage("job", view, next.offset, 1);
  expect([...first.entries, ...second.entries]).toEqual([...view.entries]);
});
