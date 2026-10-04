import { closeSync, constants, openSync, writeSync } from "node:fs";
import { isatty } from "node:tty";

/** Key generation is an explicit terminal operation; never send the secret to captured logs. */
export function openOrganizerKeyDisplay(): { show(key: string): void; close(): void } {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Run make local-reset in an interactive terminal. Organizer keys are never written to redirected output.",
    );
  let descriptor: number;
  try {
    descriptor = openSync("/dev/tty", constants.O_WRONLY | constants.O_NOCTTY);
  } catch {
    throw new Error(
      "Run make local-reset in an interactive terminal. Organizer keys are never written to redirected output.",
    );
  }
  if (!isatty(descriptor)) {
    closeSync(descriptor);
    throw new Error("Organizer keys can only be displayed on an interactive terminal.");
  }
  return {
    show(key) {
      writeSync(
        descriptor,
        `\nOrganizer key (shown once): ${key}\nSave it privately. make local-reset rotates it without deleting event data.\n`,
      );
    },
    close: () => closeSync(descriptor),
  };
}
