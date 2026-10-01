import { describe, expect, it } from "bun:test";
import type { EventRecord } from "../../infrastructure/lib/problem-deploy/control-data/domain/events";
import {
  type InstallationControl,
  type InstallationScope,
  installationScopeDigest,
} from "../../infrastructure/lib/problem-deploy/control-data/installation-control";
import { type CloudInstallation, drainInstallation } from "./installation";

const scope: InstallationScope = {
  account: "123456789012",
  region: "us-east-1",
  environment: "development",
  applicationStackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud/app-id",
  backendStackId:
    "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud-problem-deploy/backend-id",
};
function fixture(count = 2) {
  let now = Date.parse("2026-10-01T14:00:00.000Z");
  let control: InstallationControl | undefined;
  const events: EventRecord[] = Array.from({ length: count }, (_, index) => ({
    eventId: `event-${index}`,
    name: `Synthetic ${index}`,
    status: "READY",
    problems: [],
    teamCount: 1,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: now / 1000 + 3600,
  }));
  const calls: string[] = [];
  const messages: string[] = [];
  const installation: CloudInstallation = {
    repository: {
      installationControl: async () => control,
      assertAcceptingInstallation: async () => {
        if (control) throw new Error("installation_draining");
      },
      stopAcceptingInstallation: async (value, at) => {
        calls.push("stop");
        control ??= {
          scope: value,
          scopeDigest: installationScopeDigest(value),
          status: "DRAINING",
          startedAt: at,
          updatedAt: at,
        };
        return control;
      },
      listStoppedInstallationEvents: async () => {
        if (!control) throw new Error("Read before durable stop");
        calls.push("list");
        return [...events];
      },
      confirmInstallationDrained: async () => {
        if (!control) throw new Error("Missing stop");
        calls.push("drained");
        control = { ...control, status: "DRAINED" };
      },
    },
    requestEventTeardown: async (eventId) => {
      calls.push(`enqueue:${eventId}`);
      const index = events.findIndex((event) => event.eventId === eventId);
      const event = events[index];
      if (!event) throw new Error("Unknown event");
      events[index] = { ...event, status: "TEARDOWN", teardownExpected: 1, teardownCompleted: 0 };
      return { failed: 0 };
    },
    close: () => calls.push("close"),
  };
  const complete = () => {
    for (const [index, event] of events.entries())
      events[index] = { ...event, status: "ARCHIVED", teardownExpected: 1, teardownCompleted: 1 };
  };
  const io = {
    stdout: (message: string) => messages.push(message),
    now: () => now,
    wait: async (ms: number) => {
      calls.push("wait");
      now += ms;
      complete();
    },
  };
  return { installation, io, calls, messages, events, complete, control: () => control };
}

describe("installation drain orchestration with injected storage and clock only", () => {
  it("fences before discovery, queues every event, and verifies completion before returning", async () => {
    const f = fixture();
    await drainInstallation(f.installation, scope, f.io);
    expect(f.calls).toEqual([
      "stop",
      "list",
      "enqueue:event-0",
      "enqueue:event-1",
      "list",
      "wait",
      "list",
      "drained",
    ]);
    expect(f.control()?.status).toBe("DRAINED");
  });
  it("also fences and proves an empty installation", async () => {
    const f = fixture(0);
    await drainInstallation(f.installation, scope, f.io);
    expect(f.calls).toEqual(["stop", "list", "list", "drained"]);
  });
  it.each(["throws", "partial"])(
    "continues independent cleanup after %s but never authorizes platform removal",
    async (failure) => {
      const f = fixture();
      const original = f.installation.requestEventTeardown;
      const installation = {
        ...f.installation,
        requestEventTeardown: async (eventId: string, now: number) => {
          if (eventId === "event-0") {
            if (failure === "throws") throw new Error("Synthetic uncertain write");
            return { failed: 1 };
          }
          return original(eventId, now);
        },
      };
      await expect(drainInstallation(installation, scope, f.io)).rejects.toThrow(
        "Platform retained",
      );
      expect(f.calls).toContain("enqueue:event-1");
      expect(f.calls).not.toContain("drained");
      expect(f.control()?.status).toBe("DRAINING");
    },
  );
  it("times out without reopening intake and resumes the same durable scope", async () => {
    const f = fixture();
    await expect(drainInstallation(f.installation, scope, f.io, 0)).rejects.toThrow(
      "repeat the same teardown command",
    );
    expect(f.control()?.status).toBe("DRAINING");
    await expect(f.installation.repository.assertAcceptingInstallation()).rejects.toThrow(
      "installation_draining",
    );
    await drainInstallation(f.installation, scope, f.io);
    expect(f.control()?.status).toBe("DRAINED");
    expect(f.calls.filter((call) => call === "drained")).toHaveLength(1);
  });
  it("propagates a failed completion proof, leaving all platform removal to the caller", async () => {
    const f = fixture(0);
    const installation = {
      ...f.installation,
      repository: {
        ...f.installation.repository,
        confirmInstallationDrained: async () => {
          throw new Error("Synthetic scope race");
        },
      },
    };
    await expect(drainInstallation(installation, scope, f.io)).rejects.toThrow("scope race");
    expect(f.control()?.status).toBe("DRAINING");
  });
});
