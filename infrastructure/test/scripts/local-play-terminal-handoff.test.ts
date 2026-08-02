import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import { handleLocalPlayRequest } from "../../../scripts/local-play/api";
import {
  type CreateStateOptions,
  createLocalPlayState,
  type LocalPlayRequest,
} from "../../../scripts/local-play/api-state";
import type { ContainerProblem } from "../../../scripts/local-play/manifest";
import type { SimulatedCloudProblem } from "../../../scripts/local-play/simulator";
import {
  bridgeTerminalSocket,
  consumeTerminalTicket,
  parseTerminalInput,
  parseTerminalUpgrade,
  type TerminalSocketLike,
  terminalDataFrame,
  terminalExitFrame,
} from "../../../scripts/local-play/terminal-transport";

/**
 * [#2846] The terminal's non-socket halves: the handoff ticket the WebSocket upgrade
 * spends, the frame codec, and the bridge that joins one socket to one container shell.
 * Docker is stubbed throughout — `spawnShell` hands back a fake process the test drives.
 */

const TOKEN = "a".repeat(43);
const AUTHORIZATION = `Bearer ${TOKEN}`;
const NOW = Date.UTC(2026, 7, 2, 0, 0, 0);
const HANDOFF_TTL_MS = 30_000;

function problem(problemId: string, port: number): ContainerProblem {
  return {
    problemId,
    name: `Problem ${problemId}`,
    description: "A container problem with a shell workflow.",
    instructions: "Open the terminal and run the tests.",
    problemDir: `/catalog/${problemId}`,
    composePath: `/catalog/${problemId}/local/docker-compose.yml`,
    composeProjectName: `tc-local-${problemId}`,
    challengeEndpoints: {},
    verifyUrl: `http://127.0.0.1:${port}/verify`,
    secretEnv: ["FLAG_SEED"],
    scoring: { kind: "verify", points: 100, wrongAnswerPenalty: 0, hints: [] },
  };
}

const PROBLEM = problem("sha256-bytes-padding", 18091);
const OTHER = problem("ac26-w1-constraint-lab", 18093);

const SIMULATED: SimulatedCloudProblem = {
  problemId: "hello-multicloud",
  name: "Hello Multicloud",
  category: "challenges",
  description: "A simulated-cloud problem, which has no container to exec into.",
  instructions: "Deploy the stack.",
  problemDir: "/catalog/hello-multicloud",
  runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
  templateBody: "Resources: {}\n",
  metadata: { scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 } },
};

interface FakeShell {
  readonly written: string[];
  readonly emit: (chunk: string) => void;
  readonly exit: (code: number | null) => void;
  readonly kills: () => number;
}

/** A session whose shells are fakes the test drives; nothing spawns a real process. */
function stateWith(options: CreateStateOptions = {}) {
  const shells: FakeShell[] = [];
  const state = createLocalPlayState(
    { problems: [PROBLEM, OTHER], simulatedProblems: [SIMULATED], participantToken: TOKEN },
    {
      spawnShell: (_problemId, handlers) => {
        const written: string[] = [];
        let kills = 0;
        shells.push({
          written,
          emit: handlers.onData,
          exit: handlers.onExit,
          kills: () => kills,
        });
        return {
          write: (data) => written.push(data),
          kill: () => {
            kills += 1;
          },
        };
      },
      ...options,
    },
  );
  return { state, shells };
}

/** `authorization: null` builds the unauthenticated request (an explicit `undefined`
 * would fall back to the default parameter and quietly authenticate it). */
function handoff(problemId: string, authorization: string | null = AUTHORIZATION) {
  const request: LocalPlayRequest = {
    method: "POST",
    path: `/portal/me/problems/${problemId}/terminal-handoff`,
    query: {},
    body: undefined,
    ...(authorization ? { authorization } : {}),
  };
  return request;
}

/** Capture everything one socket was sent, and drive its inbound frames. */
function fakeSocket() {
  const sent: string[] = [];
  let closes = 0;
  let onMessage: ((raw: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  const socket: TerminalSocketLike = {
    send: (payload) => sent.push(payload),
    close: () => {
      closes += 1;
    },
    onMessage: (handler) => {
      onMessage = handler;
    },
    onClose: (handler) => {
      onClose = handler;
    },
  };
  return {
    socket,
    sent,
    closes: () => closes,
    frames: () => sent.map((payload) => JSON.parse(payload) as Record<string, unknown>),
    receive: (raw: string) => onMessage?.(raw),
    disconnect: () => onClose?.(),
  };
}

describe("terminal handoff endpoint (#2846)", () => {
  it("should mint a single-use ticket for a running container problem", async () => {
    const { state } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);

    const response = await handleLocalPlayRequest(handoff(PROBLEM.problemId), state, NOW);

    expect(response.status).toBe(StatusCodes.OK);
    const body = response.body as { ticket: string; expiresInMs: number };
    expect(body.expiresInMs).toBe(HANDOFF_TTL_MS);
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers).toEqual({ "cache-control": "no-store" });
    expect(state.terminalHandoffs.get(body.ticket)).toEqual({
      problemId: PROBLEM.problemId,
      expiresAtMs: NOW + HANDOFF_TTL_MS,
    });
  });

  it("should refuse a problem it has never heard of", async () => {
    const { state } = stateWith();
    const response = await handleLocalPlayRequest(handoff("nope"), state, NOW);
    expect(response.status).toBe(StatusCodes.NOT_FOUND);
    expect(response.body).toEqual({ error: "unknown_problem" });
  });

  it("should refuse a simulated-cloud problem, which has no container to exec into", async () => {
    const { state } = stateWith();
    await state.lifecycle.ensureRunning(SIMULATED.problemId).catch(() => {});

    const response = await handleLocalPlayRequest(handoff(SIMULATED.problemId), state, NOW);

    expect(response.status).toBe(StatusCodes.NOT_FOUND);
    expect(response.body).toEqual({ error: "unknown_problem" });
  });

  it("should refuse a container problem that is not running", async () => {
    const { state } = stateWith();
    const response = await handleLocalPlayRequest(handoff(PROBLEM.problemId), state, NOW);
    expect(response.status).toBe(StatusCodes.CONFLICT);
    expect(response.body).toEqual({ error: "not_running" });
    expect(state.terminalHandoffs.size).toBe(0);
  });

  it("should refuse an unauthenticated request", async () => {
    const { state } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);

    const response = await handleLocalPlayRequest(handoff(PROBLEM.problemId, null), state, NOW);

    expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
    expect(state.terminalHandoffs.size).toBe(0);
  });

  it("should sweep tickets that expired before this one was issued", async () => {
    const { state } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);

    const first = await handleLocalPlayRequest(handoff(PROBLEM.problemId), state, NOW);
    const stale = (first.body as { ticket: string }).ticket;
    const second = await handleLocalPlayRequest(
      handoff(PROBLEM.problemId),
      state,
      NOW + HANDOFF_TTL_MS + 1,
    );

    expect(state.terminalHandoffs.has(stale)).toBe(false);
    expect(state.terminalHandoffs.has((second.body as { ticket: string }).ticket)).toBe(true);
  });
});

describe("terminal upgrade parsing + ticket redemption (#2846)", () => {
  const upgradeUrl = (path: string) => new URL(path, "http://127.0.0.1");

  it("should read the problem id and ticket off the upgrade URL", () => {
    expect(
      parseTerminalUpgrade(
        upgradeUrl("/portal/me/problems/sha256-bytes-padding/terminal?ticket=t"),
      ),
    ).toEqual({ problemId: "sha256-bytes-padding", ticket: "t" });
  });

  it.each([
    "/portal/me/problems/a/terminal",
    "/portal/me/problems/a/terminal?ticket=",
    "/portal/me/problems/a/console?ticket=t",
    "/portal/me/problems/a/b/terminal?ticket=t",
    "/portal/me/problems/%ZZ/terminal?ticket=t",
  ])("should refuse to parse %s", (path) => {
    expect(parseTerminalUpgrade(upgradeUrl(path))).toBeUndefined();
  });

  it("should redeem a ticket exactly once", async () => {
    const { state } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const response = await handleLocalPlayRequest(handoff(PROBLEM.problemId), state, NOW);
    const ticket = (response.body as { ticket: string }).ticket;
    const request = { problemId: PROBLEM.problemId, ticket };

    expect(consumeTerminalTicket(state, request, NOW)).toBe(true);
    expect(consumeTerminalTicket(state, request, NOW)).toBe(false);
  });

  it("should refuse an expired ticket and still burn it", async () => {
    const { state } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const response = await handleLocalPlayRequest(handoff(PROBLEM.problemId), state, NOW);
    const ticket = (response.body as { ticket: string }).ticket;

    expect(
      consumeTerminalTicket(
        state,
        { problemId: PROBLEM.problemId, ticket },
        NOW + HANDOFF_TTL_MS + 1,
      ),
    ).toBe(false);
    expect(state.terminalHandoffs.has(ticket)).toBe(false);
  });

  it("should refuse a ticket minted for a different problem, and burn it", async () => {
    const { state } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const response = await handleLocalPlayRequest(handoff(PROBLEM.problemId), state, NOW);
    const ticket = (response.body as { ticket: string }).ticket;

    // A surviving mismatch would let the id be guessed one upgrade at a time.
    expect(consumeTerminalTicket(state, { problemId: OTHER.problemId, ticket }, NOW)).toBe(false);
    expect(state.terminalHandoffs.has(ticket)).toBe(false);
  });

  it("should refuse a ticket that was never issued", () => {
    const { state } = stateWith();
    expect(consumeTerminalTicket(state, { problemId: PROBLEM.problemId, ticket: "x" }, NOW)).toBe(
      false,
    );
  });
});

describe("terminal frame codec (#2846)", () => {
  it("should encode the server-to-client frames", () => {
    expect(JSON.parse(terminalDataFrame("ok\n"))).toEqual({ type: "data", data: "ok\n" });
    expect(JSON.parse(terminalExitFrame(0))).toEqual({ type: "exit", code: 0 });
    expect(JSON.parse(terminalExitFrame(null, "not_running"))).toEqual({
      type: "exit",
      code: null,
      reason: "not_running",
    });
  });

  it("should decode a well-formed input frame", () => {
    expect(parseTerminalInput('{"type":"input","data":"ls\\n"}')).toBe("ls\n");
    expect(parseTerminalInput('{"type":"input","data":""}')).toBe("");
  });

  it.each([
    "not json",
    "[]",
    "null",
    '"input"',
    '{"type":"resize","cols":80}',
    '{"type":"input"}',
    '{"type":"input","data":42}',
    '{"data":"ls"}',
  ])("should refuse the malformed frame %s", (raw) => {
    expect(parseTerminalInput(raw)).toBeUndefined();
  });
});

describe("terminal socket bridge (#2846)", () => {
  it("should carry keystrokes in and container output back", async () => {
    const { state, shells } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const peer = fakeSocket();

    bridgeTerminalSocket(peer.socket, state, PROBLEM.problemId);
    peer.receive('{"type":"input","data":"python show.py\\n"}');
    shells[0]?.emit("field p = 2013265921\n");

    expect(shells[0]?.written).toEqual(["python show.py\n"]);
    expect(peer.frames()).toEqual([{ type: "data", data: "field p = 2013265921\n" }]);
    expect(peer.closes()).toBe(0);
  });

  it("should report the shell's exit over the socket and then close it", async () => {
    const { state, shells } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const peer = fakeSocket();

    bridgeTerminalSocket(peer.socket, state, PROBLEM.problemId);
    shells[0]?.exit(0);

    expect(peer.frames()).toEqual([{ type: "exit", code: 0 }]);
    expect(peer.closes()).toBe(1);
  });

  it("should report an attach failure over the established socket, not by hanging", async () => {
    // The handshake is already done by the time the container's state is known, so a
    // refused attach has to be said out loud — a silent close reads as a network fault.
    const { state } = stateWith();
    const peer = fakeSocket();

    bridgeTerminalSocket(peer.socket, state, PROBLEM.problemId);

    expect(peer.frames()).toEqual([{ type: "exit", code: null, reason: "not_running" }]);
    expect(peer.closes()).toBe(1);
  });

  it("should report a spawn failure exactly once when the shell dies mid-attach", async () => {
    const { state } = stateWith({
      spawnShell: (_problemId, handlers) => {
        handlers.onExit(137);
        return { write: () => {}, kill: () => {} };
      },
    });
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const peer = fakeSocket();

    bridgeTerminalSocket(peer.socket, state, PROBLEM.problemId);

    expect(peer.frames()).toEqual([{ type: "exit", code: 137 }]);
    expect(peer.closes()).toBe(1);
  });

  it("should end the session on a malformed frame rather than silently dropping input", async () => {
    const { state, shells } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const peer = fakeSocket();

    bridgeTerminalSocket(peer.socket, state, PROBLEM.problemId);
    peer.receive('{"type":"resize","cols":80}');

    expect(shells[0]?.kills()).toBe(1);
    expect(peer.frames()).toEqual([{ type: "exit", code: null }]);
    expect(state.terminals.countFor(PROBLEM.problemId)).toBe(0);
  });

  it("should kill the shell when the participant's socket goes away", async () => {
    const { state, shells } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const peer = fakeSocket();

    bridgeTerminalSocket(peer.socket, state, PROBLEM.problemId);
    peer.disconnect();

    expect(shells[0]?.kills()).toBe(1);
    expect(state.terminals.countFor(PROBLEM.problemId)).toBe(0);
    // Nothing may be written to a peer that is already gone.
    expect(peer.sent).toEqual([]);
  });
});

describe("terminal lifecycle coupling (#2846)", () => {
  it("should close a problem's shells when its container is stopped", async () => {
    const { state, shells } = stateWith();
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const peer = fakeSocket();
    bridgeTerminalSocket(peer.socket, state, PROBLEM.problemId);

    await state.lifecycle.stop(PROBLEM.problemId);

    expect(shells[0]?.kills()).toBe(1);
    expect(peer.frames()).toEqual([{ type: "exit", code: null }]);
    expect(state.terminals.countFor(PROBLEM.problemId)).toBe(0);
  });

  it("should close a problem's shells when the cap evicts its container", async () => {
    // LRU eviction reclaims the container without going through portal Stop, so it is
    // the path most likely to leave a shell attached to nothing.
    const { state, shells } = stateWith({ maxRunning: 1 });
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const peer = fakeSocket();
    bridgeTerminalSocket(peer.socket, state, PROBLEM.problemId);

    await state.lifecycle.ensureRunning(OTHER.problemId);

    expect(state.lifecycle.statusOf(PROBLEM.problemId)).toBe("stopped");
    expect(shells[0]?.kills()).toBe(1);
    expect(peer.frames()).toEqual([{ type: "exit", code: null }]);
  });

  it("should refuse to attach without a configured shell adapter", async () => {
    // The default seam throws, and `attach` fails closed rather than handing back a
    // session whose writes go nowhere.
    const state = createLocalPlayState({ problems: [PROBLEM], participantToken: TOKEN });
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    const peer = fakeSocket();

    bridgeTerminalSocket(peer.socket, state, PROBLEM.problemId);

    expect(peer.frames()).toEqual([{ type: "exit", code: null, reason: "spawn_failed" }]);
  });

  it("should ask the shell adapter only for the problem being attached", async () => {
    const spawnShell = vi.fn(() => ({ write: () => {}, kill: () => {} }));
    const { state } = stateWith({ spawnShell });
    await state.lifecycle.ensureRunning(OTHER.problemId);

    bridgeTerminalSocket(fakeSocket().socket, state, OTHER.problemId);

    expect(spawnShell.mock.calls[0]?.[0]).toBe(OTHER.problemId);
  });
});
