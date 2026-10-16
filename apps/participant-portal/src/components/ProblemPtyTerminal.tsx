import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

export interface PtyOutput {
  pending: string;
  write?: (data: string) => void;
}

function boundedWriter(term: Terminal, active: () => boolean, fail: () => void) {
  let queuedBytes = 0;
  return (data: string) => {
    if (!active()) return;
    const bytes = new TextEncoder().encode(data).byteLength;
    if (queuedBytes + bytes > 4 * 1024 * 1024) {
      fail();
      return;
    }
    queuedBytes += bytes;
    term.write(data, () => {
      queuedBytes -= bytes;
    });
  };
}

/** xterm consumes terminal escape sequences as text, without HTML or link/clipboard addons. */
export function ProblemPtyTerminal({
  socket,
  output,
  label,
  onFailure,
}: {
  socket: WebSocket;
  output: PtyOutput;
  label: string;
  onFailure: () => void;
}) {
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    let disposed = false;
    let failed = false;
    const fail = () => {
      if (disposed || failed) return;
      failed = true;
      onFailure();
    };
    let terminal: Terminal | undefined;
    let cleanup = () => undefined;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([xterm, fit]) => {
        if (disposed || !container.current) return;
        const term = new xterm.Terminal({
          cols: 80,
          rows: 24,
          scrollback: 500,
          screenReaderMode: true,
          fontSize: 13,
          allowProposedApi: false,
        });
        terminal = term;
        const addon = new fit.FitAddon();
        term.loadAddon(addon);
        term.open(container.current);
        output.write = boundedWriter(term, () => !disposed && !failed, fail);
        output.write(output.pending);
        output.pending = "";
        let sentSize = "";
        const sendSize = () => {
          const size = `${term.cols}:${term.rows}`;
          if (failed || socket.readyState !== 1 || sentSize === size) return;
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          sentSize = size;
        };
        const measure = () => {
          if (disposed || failed) return;
          const dimensions = addon.proposeDimensions();
          if (dimensions)
            term.resize(
              Math.max(2, Math.min(256, dimensions.cols)),
              Math.max(1, Math.min(128, dimensions.rows)),
            );
          sendSize();
        };
        const input = term.onData((data) => {
          if (failed || socket.readyState !== 1) return;
          const frame = JSON.stringify({ type: "input", data });
          if (socket.bufferedAmount + new TextEncoder().encode(frame).byteLength > 1024 * 1024) {
            fail();
            return;
          }
          socket.send(frame);
        });
        let scheduled = 0;
        const schedule = () => {
          if (disposed || failed) return;
          cancelAnimationFrame(scheduled);
          scheduled = requestAnimationFrame(measure);
        };
        const observer =
          typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
        observer?.observe(container.current);
        window.addEventListener("resize", schedule);
        measure();
        term.focus();
        cleanup = () => {
          cancelAnimationFrame(scheduled);
          observer?.disconnect();
          window.removeEventListener("resize", schedule);
          input.dispose();
        };
      })
      .catch(() => {
        fail();
      });
    return () => {
      disposed = true;
      cleanup();
      output.write = undefined;
      terminal?.dispose();
    };
  }, [socket, output, onFailure]);
  return (
    <section
      ref={container}
      aria-label={label}
      style={{ height: 280, overflow: "hidden", background: "#000", padding: 8 }}
    />
  );
}
