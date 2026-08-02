import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  type ComposeExecTarget,
  createProblemShellSpawner,
} from "../../../scripts/local-play/docker-adapter";
import type { ContainerProblem } from "../../../scripts/local-play/manifest";
import type { TerminalProcess } from "../../../scripts/local-play/problem-terminal";
import { type LocalPlayServer, startLocalPlayServer } from "../../../scripts/local-play/server";

/**
 * [#2846] The terminal's socket transport, against a real `node:http` listener and a real
 * `ws` client: the upgrade guard (origin + single-use ticket) and one full round trip.
 * Docker is still stubbed — the "shell" is a fake that echoes what it is written.
 */

const TOKEN = "a".repeat(43);
const PORTAL_ORIGIN = "http://127.0.0.1:5175";
const HANDSHAKE_TIMEOUT_MS = 5_000;

const PROBLEM: ContainerProblem = {
  problemId: "sha256-bytes-padding",
  name: "SHA-256 padding",
  description: "A verifier-only problem whose whole workflow is a shell.",
  instructions: "Open the terminal and run the tests.",
  problemDir: "/catalog/sha256-bytes-padding",
  composePath: "/catalog/sha256-bytes-padding/local/docker-compose.yml",
  composeProjectName: "tc-local-sha256-bytes-padding",
  challengeEndpoints: {},
  verifyUrl: "http://127.0.0.1:18091/verify",
  secretEnv: ["FLAG_SEED"],
  // [#2850] The terminal is per-problem opt-in; the socket tests need an opted-in problem.
  terminal: { service: "verifier" },
  scoring: { kind: "verify", points: 100, wrongAnswerPenalty: 0, hints: [] },
};

interface EchoShell {
  readonly kills: () => number;
}

/**
 * A running single-problem session whose shells echo their input back, so a round trip
 * proves the socket carried the bytes rather than proving Docker works.
 */
async function runningServer(): Promise<{
  readonly server: LocalPlayServer;
  readonly shells: EchoShell[];
}> {
  const shells: EchoShell[] = [];
  const server = await startLocalPlayServer(
    0,
    { problems: [PROBLEM], participantToken: TOKEN },
    {
      spawnShell: (_problemId, handlers) => {
        let kills = 0;
        shells.push({ kills: () => kills });
        return {
          write: (data) => handlers.onData(`echo:${data}`),
          kill: () => {
            kills += 1;
            handlers.onExit(null);
          },
        };
      },
    },
  );
  await server.state.lifecycle.ensureRunning(PROBLEM.problemId);
  return { server, shells };
}

async function mintTicket(server: LocalPlayServer): Promise<string> {
  const response = await fetch(
    `http://127.0.0.1:${server.port}/portal/me/problems/${PROBLEM.problemId}/terminal-handoff`,
    { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } },
  );
  expect(response.status).toBe(StatusCodes.OK);
  return ((await response.json()) as { ticket: string }).ticket;
}

function terminalUrl(
  server: LocalPlayServer,
  ticket: string,
  problemId = PROBLEM.problemId,
): string {
  const query = new URLSearchParams({ ticket });
  return `ws://127.0.0.1:${server.port}/portal/me/problems/${problemId}/terminal?${query}`;
}

/** Resolve with the open socket, or reject with the handshake failure. */
function connect(url: string, options: { readonly origin?: string } = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("websocket handshake neither opened nor failed"));
    }, HANDSHAKE_TIMEOUT_MS);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** The next frame the server sends, parsed. */
function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no frame arrived")), HANDSHAKE_TIMEOUT_MS);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

describe("terminal WebSocket transport (#2846)", () => {
  it("should carry a command to the container shell and its output back", async () => {
    const { server } = await runningServer();
    try {
      const socket = await connect(terminalUrl(server, await mintTicket(server)));
      socket.send(JSON.stringify({ type: "input", data: "python show.py\n" }));

      await expect(nextFrame(socket)).resolves.toEqual({
        type: "data",
        data: "echo:python show.py\n",
      });
      socket.close();
      await closed(socket);
    } finally {
      await server.close();
    }
  });

  it("should carry a payload large enough to span several reads intact", async () => {
    // A pasted heredoc arrives as one text message split over many TCP reads. `ws`
    // concatenates text fragments before emitting, but the adapter stringifies whatever
    // it is handed — so a payload that outgrows a single read has to survive verbatim
    // or the participant silently loses the session to a "malformed frame".
    const { server } = await runningServer();
    const paste = `${"x".repeat(256 * 1024)}\n`;
    try {
      const socket = await connect(terminalUrl(server, await mintTicket(server)));
      socket.send(JSON.stringify({ type: "input", data: paste }));

      await expect(nextFrame(socket)).resolves.toEqual({ type: "data", data: `echo:${paste}` });
      socket.close();
      await closed(socket);
    } finally {
      await server.close();
    }
  });

  it("should accept the participant portal origin", async () => {
    const { server } = await runningServer();
    try {
      const socket = await connect(terminalUrl(server, await mintTicket(server)), {
        origin: PORTAL_ORIGIN,
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
      await closed(socket);
    } finally {
      await server.close();
    }
  });

  it("should refuse the upgrade from a hostile origin before spending the ticket", async () => {
    const { server, shells } = await runningServer();
    try {
      const ticket = await mintTicket(server);

      await expect(
        connect(terminalUrl(server, ticket), { origin: "https://attacker.example" }),
      ).rejects.toThrow(/403/);

      expect(shells).toHaveLength(0);
      // The guard runs before redemption, so the participant's own ticket still works.
      expect(server.state.terminalHandoffs.has(ticket)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("should refuse an upgrade with a missing, unknown, or already-spent ticket", async () => {
    const { server, shells } = await runningServer();
    try {
      await expect(connect(terminalUrl(server, "never-issued"))).rejects.toThrow(/401/);

      const ticket = await mintTicket(server);
      const socket = await connect(terminalUrl(server, ticket));
      socket.close();
      await closed(socket);

      // Single use: the same ticket must not open a second shell.
      await expect(connect(terminalUrl(server, ticket))).rejects.toThrow(/401/);
      expect(shells).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("should refuse an upgrade whose ticket was minted for another problem", async () => {
    const { server } = await runningServer();
    try {
      const ticket = await mintTicket(server);
      await expect(connect(terminalUrl(server, ticket, "other-problem"))).rejects.toThrow(/401/);
    } finally {
      await server.close();
    }
  });

  it("should refuse an upgrade on a path that is not the terminal", async () => {
    const { server } = await runningServer();
    try {
      await expect(
        connect(`ws://127.0.0.1:${server.port}/portal/me?ticket=${await mintTicket(server)}`),
      ).rejects.toThrow(/404/);
    } finally {
      await server.close();
    }
  });

  it("should end the session when the participant disconnects", async () => {
    const { server, shells } = await runningServer();
    try {
      const socket = await connect(terminalUrl(server, await mintTicket(server)));
      socket.close();
      await closed(socket);
      // The close travels back over the wire; give the server's handler a turn.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(shells[0]?.kills()).toBe(1);
      expect(server.state.terminals.countFor(PROBLEM.problemId)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("should reclaim live terminals when the server shuts down", async () => {
    // An upgraded socket keeps `server.close` from calling back, so a shutdown that did
    // not terminate them would hang the whole `serve` process on Ctrl-C.
    const { server, shells } = await runningServer();
    const socket = await connect(terminalUrl(server, await mintTicket(server)));

    await server.close();

    expect(shells[0]?.kills()).toBe(1);
    expect(server.state.terminals.countFor(PROBLEM.problemId)).toBe(0);
    await closed(socket);
  });
});

describe("compose shell spawner (#2846/#2850)", () => {
  const unit = {
    problemId: PROBLEM.problemId,
    composePath: "/tmp/tc/remapped.compose.yml",
    composeProjectName: PROBLEM.composeProjectName,
    secretEnv: PROBLEM.secretEnv,
    projectDirectory: "/catalog/sha256-bytes-padding/local",
  };
  const units = new Map([[PROBLEM.problemId, unit]]);
  const services = new Map([[PROBLEM.problemId, "verifier"]]);
  const shell: TerminalProcess = { write: () => {}, kill: () => {} };
  const handlers = { onData: () => {}, onExit: () => {} };

  it("should exec into the metadata-declared service once its participant build is verified", () => {
    const inspected: ComposeExecTarget[] = [];
    const calls: Array<{ target: ComposeExecTarget; service: string }> = [];
    const spawn = createProblemShellSpawner(units, services, {
      inspectConfig: (target) => {
        inspected.push(target);
        // A multi-service config: the shell must pick the declared service, not
        // whichever name sorts first ("db" would).
        return new Map([
          ["db", {}],
          ["verifier", { buildTarget: "participant" }],
        ]);
      },
      spawnShell: (target, service) => {
        calls.push({ target, service });
        return shell;
      },
    });

    spawn(PROBLEM.problemId, handlers);

    const expectedTarget = {
      composePath: unit.composePath,
      composeProjectName: unit.composeProjectName,
      secretEnv: unit.secretEnv,
      projectDirectory: unit.projectDirectory,
    };
    // The verification reads the same live unit the shell then enters.
    expect(inspected).toEqual([expectedTarget]);
    expect(calls).toEqual([{ service: "verifier", target: expectedTarget }]);
  });

  it("should throw for a problem with no recorded container unit", () => {
    const spawn = createProblemShellSpawner(new Map(), services, {
      inspectConfig: () => new Map([["verifier", { buildTarget: "participant" }]]),
    });
    // `ProblemTerminals` turns the throw into `spawn_failed`; a session attached to a
    // container that is not there would look alive and do nothing.
    expect(() => spawn(PROBLEM.problemId, handlers)).toThrow(/no running container recorded/);
  });

  it("should refuse a problem that never opted into a terminal", () => {
    const inspectConfig = () => {
      throw new Error("inspectConfig must not run for an undeclared problem");
    };
    const spawn = createProblemShellSpawner(units, new Map(), { inspectConfig });
    expect(() => spawn(PROBLEM.problemId, handlers)).toThrow(/does not declare runtime\.terminal/);
  });

  it("should refuse a declared service that is not in the live compose config", () => {
    const spawn = createProblemShellSpawner(units, services, {
      inspectConfig: () => new Map([["db", { buildTarget: "participant" }]]),
      spawnShell: () => shell,
    });
    expect(() => spawn(PROBLEM.problemId, handlers)).toThrow(/is not in its compose config/);
  });

  it.each([
    ["a non-participant build target", { buildTarget: "author" }],
    ["an image with no build section", {}],
  ])("should refuse a terminal service running %s", (_label, build) => {
    // The participant stage is the machine-checkable guarantee that the image excludes
    // author-only material; anything else must never receive a shell.
    const spawn = createProblemShellSpawner(units, services, {
      inspectConfig: () => new Map([["verifier", build]]),
      spawnShell: () => shell,
    });
    expect(() => spawn(PROBLEM.problemId, handlers)).toThrow(
      /must build with target "participant"/,
    );
  });
});
