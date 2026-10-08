/** Real native Battle HTTP listeners and a durable SQLite database; no fixture game engine. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CompetitionEngine } from "../competition-engine";
import { parseGatewayPorts } from "../gateway-ports";
import { type RunningLocalHost, startLocalHost } from "../server";
import type { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { organizerToken } from "./organizer-login";

export const FORENSIC_PROBLEM = "forensic-casebook";
export const forensicRoot = fileURLToPath(new URL("../../../", import.meta.url));
export interface ForensicEvent {
  eventId: string;
  teams: { teamId: string; teamLoginKey: string }[];
}
export interface ForensicRequest {
  method?: string;
  body?: unknown;
  token?: string;
  nonce?: string;
}

export async function forensicFixture() {
  const directory = createTemporaryDirectory(forensicRoot, "tenka-forensic-host-");
  let store: HostStore | undefined;
  let host: RunningLocalHost | undefined;
  let key = "";
  let token = "";
  const announcements: string[] = [];
  async function start() {
    host = await startLocalHost(
      forensicRoot,
      {
        dataDirectory: directory,
        hostname: "127.0.0.1",
        adminPort: 0,
        participantPort: 0,
        gatewayPorts: parseGatewayPorts("5800-5839"),
      },
      (data, database) => {
        store = database;
        return new CompetitionEngine(forensicRoot, data, false);
      },
      (message) => announcements.push(message),
    );
    key ||= required(host.organizerKey);
    token = await organizerToken({ admin: host.admin.origin, key });
  }
  async function api<T = Record<string, unknown>>(
    role: "admin" | "participant",
    path: string,
    options: ForensicRequest = {},
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${required(host)[role].origin}/api${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${options.token ?? (role === "admin" ? token : "")}`,
        "content-type": "application/json",
        ...(options.nonce ? { "idempotency-key": options.nonce } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  async function stop() {
    const previous = host;
    host = undefined;
    await previous?.stop();
  }
  try {
    await start();
  } catch (error) {
    await stop();
    removeTemporaryDirectory(forensicRoot, directory);
    throw error;
  }
  return {
    get store() {
      return required(store);
    },
    get host() {
      return required(host);
    },
    get key() {
      return key;
    },
    announcements,
    api,
    async create(name: string): Promise<ForensicEvent> {
      const event = await api<ForensicEvent>("admin", "/events", {
        method: "POST",
        body: {
          name,
          teams: [{ internalSlug: "alpha" }, { internalSlug: "beta" }],
          problems: [{ problemId: FORENSIC_PROBLEM }],
        },
      });
      assert.equal(event.status, 201);
      const deploy = await api("admin", `/events/${event.body.eventId}/deploy`, {
        method: "POST",
        body: {},
      });
      assert.equal(deploy.status, 202);
      const deadline = Date.now() + 15_000;
      while (required(store).event(event.body.eventId).status !== "READY") {
        assert.ok(Date.now() < deadline, "Native forensic deployment did not become READY.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const started = await api("admin", `/events/${event.body.eventId}/schedule`, {
        method: "PATCH",
        body: { startNow: true },
      });
      assert.equal(started.status, 200);
      return event.body;
    },
    async restart() {
      await stop();
      await start();
      assert.equal(required(host).organizerKey, undefined, "Restart does not redisclose the key.");
    },
    async close() {
      await stop();
      removeTemporaryDirectory(forensicRoot, directory);
    },
  };
}

export function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected a present forensic value.");
  return value;
}
