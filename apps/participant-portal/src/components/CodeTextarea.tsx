import Textarea from "@cloudscape-design/components/textarea";
import { useEffect, useRef, useState } from "react";

const INDENT = "    ";
const COMMENT = "# ";

interface CodeTextareaProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly rows?: number;
  readonly disabled?: boolean;
}

interface Selection {
  readonly start: number;
  readonly end: number;
}

interface Edit {
  readonly value: string;
  readonly selection: Selection;
}

function lineStart(value: string, index: number): number {
  return value.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(value: string, index: number): number {
  const next = value.indexOf("\n", index);
  return next === -1 ? value.length : next;
}

/** Indent or outdent every line the selection touches. */
function shiftBlock(value: string, sel: Selection, outdent: boolean): Edit {
  const from = lineStart(value, sel.start);
  const body = value.slice(from, sel.end);
  let firstDelta = 0;
  let totalDelta = 0;
  const shifted = body.split("\n").map((line, index) => {
    if (outdent) {
      const removed = Math.min(INDENT.length, line.length - line.trimStart().length);
      if (index === 0) firstDelta = -removed;
      totalDelta -= removed;
      return line.slice(removed);
    }
    if (index === 0) firstDelta = INDENT.length;
    totalDelta += INDENT.length;
    return INDENT + line;
  });
  return {
    value: value.slice(0, from) + shifted.join("\n") + value.slice(sel.end),
    selection: {
      start: Math.max(from, sel.start + firstDelta),
      end: sel.end + totalDelta,
    },
  };
}

/** Toggle `# ` on every line the selection touches, Python style. */
function toggleComment(value: string, sel: Selection): Edit {
  const from = lineStart(value, sel.start);
  const to = lineEnd(value, sel.end);
  const lines = value.slice(from, to).split("\n");
  const filled = lines.filter((line) => line.trim() !== "");
  if (filled.length === 0) return { value, selection: sel };

  const commented = filled.every((line) => line.trimStart().startsWith("#"));
  let firstDelta = 0;
  let totalDelta = 0;
  const column = commented
    ? 0
    : Math.min(...filled.map((line) => line.length - line.trimStart().length));

  const next = lines.map((line, index) => {
    if (line.trim() === "") return line;
    let delta: number;
    let updated: string;
    if (commented) {
      const at = line.indexOf("#");
      const width = line.slice(at + 1).startsWith(" ") ? COMMENT.length : 1;
      updated = line.slice(0, at) + line.slice(at + width);
      delta = -width;
    } else {
      updated = line.slice(0, column) + COMMENT + line.slice(column);
      delta = COMMENT.length;
    }
    if (index === 0) firstDelta = delta;
    totalDelta += delta;
    return updated;
  });

  return {
    value: value.slice(0, from) + next.join("\n") + value.slice(to),
    selection: {
      start: Math.max(from, sel.start + firstDelta),
      end: sel.end + totalDelta,
    },
  };
}

/** Carry the current indentation to the new line, deepening it after a colon. */
function newlineWithIndent(value: string, sel: Selection): Edit {
  const from = lineStart(value, sel.start);
  const current = value.slice(from, sel.start);
  const indent = current.slice(0, current.length - current.trimStart().length);
  const deeper = current.trimEnd().endsWith(":") ? indent + INDENT : indent;
  const inserted = `\n${deeper}`;
  const caret = sel.start + inserted.length;
  return {
    value: value.slice(0, sel.start) + inserted + value.slice(sel.end),
    selection: { start: caret, end: caret },
  };
}

type Intent = "indent" | "outdent" | "comment" | "newline";

/** The part of Cloudscape's key detail this component reads. */
interface KeyDetail {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

function intentOf(detail: KeyDetail): Intent | null {
  if (detail.key === "Tab") return detail.shiftKey ? "outdent" : "indent";
  if (detail.key === "/" && (detail.ctrlKey || detail.metaKey)) return "comment";
  if (detail.key === "Enter" && !detail.shiftKey && !detail.ctrlKey && !detail.metaKey) {
    return "newline";
  }
  return null;
}

function editFor(intent: Intent, value: string, sel: Selection): Edit {
  if (intent === "outdent") return shiftBlock(value, sel, true);
  if (intent === "comment") return toggleComment(value, sel);
  if (intent === "newline") return newlineWithIndent(value, sel);
  if (sel.start !== sel.end && value.slice(sel.start, sel.end).includes("\n")) {
    return shiftBlock(value, sel, false);
  }
  const caret = sel.start + INDENT.length;
  return {
    value: value.slice(0, sel.start) + INDENT + value.slice(sel.end),
    selection: { start: caret, end: caret },
  };
}

/**
 * A code editor that keeps the keys people expect when writing Python.
 *
 * Python is indentation-sensitive, so a Tab that escapes the field makes the
 * editor unusable for problems that ship Python starters. Keyboard users still
 * need a way out, so Escape arms the next Tab to move focus as usual.
 */
export function CodeTextarea({ value, onChange, rows, disabled }: CodeTextareaProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<Selection | null>(null);
  const [escapeArmed, setEscapeArmed] = useState(false);

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    const field = hostRef.current?.querySelector("textarea");
    // 直前の keydown で textarea を掴んでいるので、ここで消えている経路は無い。
    /* v8 ignore next */
    if (!field) return;
    const limit = value.length;
    field.setSelectionRange(Math.min(pending.start, limit), Math.min(pending.end, limit));
  }, [value]);

  return (
    <div ref={hostRef}>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.detail.value)}
        onKeyDown={(event) => {
          const detail = event.detail;
          if (detail.key === "Escape") {
            setEscapeArmed(true);
            return;
          }
          const intent = intentOf(detail);
          const tabbing = intent === "indent" || intent === "outdent";
          if (escapeArmed) {
            setEscapeArmed(false);
            if (tabbing) return; // let the browser move focus
          }
          if (intent === null) return;
          const field = hostRef.current?.querySelector("textarea");
          // イベント元が textarea なので null にはならない。disabled は下で見る。
          /* v8 ignore next */
          if (!field) return;
          event.preventDefault();
          // textarea では常に数値が返る。型の null を畳むだけの分岐。
          /* v8 ignore start */
          const start = field.selectionStart ?? 0;
          const end = field.selectionEnd ?? start;
          /* v8 ignore stop */
          const edit = editFor(intent, value, { start, end });
          pendingRef.current = edit.selection;
          onChange(edit.value);
        }}
        rows={rows}
        disabled={disabled}
        spellcheck={false}
        autoComplete={false}
      />
    </div>
  );
}
