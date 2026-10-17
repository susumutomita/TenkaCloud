import { expect, test } from "bun:test";
import { terminalSession } from "./terminal-session";
import type { TerminalHandlers } from "./terminal-shell";

function fixture(
  cleanup: (pid: string, starttime: string) => Promise<void> = async () => undefined,
) {
  let events: TerminalHandlers = { onData: () => undefined, onExit: () => undefined };
  const inputs: string[] = [];
  const output: string[] = [];
  const exits: (number | null)[] = [];
  let kills = 0;
  const terminal = terminalSession(
    (handlers) => {
      events = handlers;
      return {
        write: (data) => inputs.push(data),
        resize: () => undefined,
        kill: () => {
          kills++;
          events.onExit(null);
        },
      };
    },
    cleanup,
    { onData: (data) => output.push(data), onExit: (code) => exits.push(code) },
  );
  return { terminal, inputs, output, exits, events, kills: () => kills };
}

test("PTY handoff validates split identity before input and strips its header from output", async () => {
  const identities: string[][] = [];
  const f = fixture(async (...identity) => {
    identities.push(identity);
  });
  f.terminal.write("pending\r");
  f.events.onData("\x1eTENKACLOUD:42:");
  expect(f.inputs).toEqual([]);
  f.events.onData(`12345\x1f${"x".repeat(16_384)}`);
  expect(f.inputs).toEqual(["pending\r"]);
  expect(f.output).toEqual(["x".repeat(16_384)]);
  f.terminal.write("\u0010");
  f.terminal.write("\u0011");
  expect(f.inputs.slice(-2)).toEqual(["\u0010", "\u0011"]);
  f.terminal.kill();
  f.terminal.kill();
  await f.terminal.closed;
  expect(identities).toEqual([["42", "12345"]]);
  expect(f.kills()).toBe(1);
  expect(f.exits).toEqual([null]);
});

test("PTY ownership stays pending until remote cleanup, and cleanup failure is observable", async () => {
  let release: () => void = () => undefined;
  const f = fixture(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  f.events.onData("\x1eTENKACLOUD:42:12345\x1f");
  f.events.onExit(0);
  expect(f.exits).toEqual([]);
  release();
  await f.terminal.closed;
  expect(f.exits).toEqual([0]);
  const failed = fixture(async () => {
    throw new Error("daemon unavailable");
  });
  failed.events.onData("\x1eTENKACLOUD:42:12345\x1f");
  failed.terminal.kill();
  await expect(failed.terminal.closed).rejects.toThrow("daemon unavailable");
});

test("NUL detach input, malformed identity, oversize handshake and early disconnect fail closed", async () => {
  for (const header of [
    "\x1eTENKACLOUD:1:123\x1f",
    "\x1eTENKACLOUD:42:bad\x1f",
    "x".repeat(257),
    "",
  ]) {
    const f = fixture();
    f.events.onData(header);
    f.terminal.kill();
    await expect(f.terminal.closed).rejects.toThrow("identity was not confirmed");
    expect(f.inputs).toEqual([]);
  }
  const f = fixture();
  f.events.onData("\x1eTENKACLOUD:42:12345\x1f");
  f.terminal.write("\0");
  await f.terminal.closed;
  expect(f.inputs).toEqual([]);
});

test("revocation while waiting for remote identity prevents all queued input", async () => {
  let active = true;
  let events: TerminalHandlers = { onData: () => undefined, onExit: () => undefined };
  const writes: string[] = [];
  const identities: string[][] = [];
  const shell = terminalSession(
    (handlers) => {
      events = handlers;
      return { write: (data) => writes.push(data), kill: () => undefined };
    },
    async (...identity) => {
      identities.push(identity);
    },
    { onData: () => undefined, onExit: () => undefined },
    () => {
      if (!active) throw new Error("revoked");
    },
  );
  shell.write("pending-command\r");
  active = false;
  events.onData("\x1eTENKACLOUD:42:12345\x1f");
  await shell.closed;
  expect(writes).toEqual([]);
  expect(identities).toEqual([["42", "12345"]]);
});
