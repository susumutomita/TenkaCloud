import { expect, test } from "bun:test";
import { spawnTerminalPty } from "./terminal-pty";

// Real unprivileged PTY child only. No Docker, firewall, privilege or network operations.
test("PTY exposes a tty, applies resize, accepts interactive input and closes once", async () => {
  const completed = Promise.withResolvers<number | null>();
  let output = "";
  let exits = 0;
  const process = spawnTerminalPty(
    "/bin/sh",
    ["-c", "test -t 0 && printf 'REAL_TTY\\n'; printf '日本語\\n'; read line; stty size; exit 0"],
    { PATH: "/usr/bin:/bin" },
    {
      onData: (data) => {
        output += data;
      },
      onExit: (code) => {
        exits++;
        completed.resolve(code);
      },
    },
  );
  try {
    process.resize?.(101, 37);
    process.write("size\r");
    expect(await completed.promise).toBe(0);
    expect(output).toContain("REAL_TTY");
    expect(output).toContain("37 101");
    expect(output).toContain("日本語");
    process.kill();
    process.write("ignored");
    expect(exits).toBe(1);
  } finally {
    process.kill();
  }
});

test("disconnect kills the PTY child once and a new connection starts a fresh tty", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    let exits = 0;
    const closed = Promise.withResolvers<number | null>();
    const shell = spawnTerminalPty(
      "/bin/sh",
      [],
      { PATH: "/usr/bin:/bin" },
      {
        onData: () => undefined,
        onExit: (code) => {
          exits++;
          closed.resolve(code);
        },
      },
    );
    shell.kill();
    shell.kill();
    await closed.promise;
    expect(exits).toBe(1);
  }
});

test("PTY resize notifies the pinned CLI so it can forward its new window size", async () => {
  const ready = Promise.withResolvers<undefined>();
  const resized = Promise.withResolvers<undefined>();
  let output = "";
  const shell = spawnTerminalPty(
    "/bin/sh",
    [
      "-c",
      'trap \'stty size; printf "WINCH_SEEN\\n"\' WINCH; printf "PTY_READY\\n"; while :; do read line; if [ "$line" = done ]; then exit 0; fi; done',
    ],
    { PATH: "/usr/bin:/bin" },
    {
      onData: (data) => {
        output += data;
        if (output.includes("PTY_READY")) ready.resolve(undefined);
        if (output.includes("WINCH_SEEN")) resized.resolve(undefined);
      },
      onExit: () => undefined,
    },
  );
  try {
    await ready.promise;
    shell.resize?.(110, 42);
    await resized.promise;
    expect(output).toContain("42 110");
    shell.write("done\r");
  } finally {
    shell.kill();
  }
});

test("oversized pending input closes the PTY process instead of growing its queue", async () => {
  let exits = 0;
  const shell = spawnTerminalPty(
    "/bin/sh",
    [],
    { PATH: "/usr/bin:/bin" },
    {
      onData: () => undefined,
      onExit: () => {
        exits++;
      },
    },
  );
  try {
    shell.write("x".repeat(1024 * 1024 + 1));
    expect(exits).toBe(1);
    shell.kill();
    expect(exits).toBe(1);
  } finally {
    shell.kill();
  }
});
