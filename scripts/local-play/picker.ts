import { emitKeypressEvents } from "node:readline";
import type { LocalPlayProblemSummary } from "./manifest";

const ENTER_ALTERNATE_SCREEN = "\u001B[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\u001B[?1049l";
const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const CLEAR_SCREEN = "\u001B[2J\u001B[H";

export interface ProblemPickerState {
  readonly query: string;
  readonly selectedIndex: number;
}

export type ProblemPickerAction =
  | { readonly type: "append"; readonly text: string }
  | { readonly type: "backspace" }
  | { readonly type: "clear" }
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "first" }
  | { readonly type: "last" };

export interface ProblemPickerKey {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

type ProblemPickerIntent =
  | { readonly type: "cancel" }
  | { readonly type: "select" }
  | { readonly type: "update"; readonly action: ProblemPickerAction }
  | { readonly type: "ignore" };

export interface ProblemPickerTerminal {
  readonly columns: number;
  readonly rows: number;
  readonly color: boolean;
  readonly write: (text: string) => void;
  readonly start: (listener: (text: string | undefined, key: ProblemPickerKey) => void) => void;
  readonly stop: () => void;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

/**
 * Search by problem id, localized display name, or catalog group. Space-
 * separated terms are ANDed, so `api challenge` narrows rather than broadens.
 * Source order remains stable to keep keyboard navigation predictable.
 */
export function filterProblemSummaries(
  summaries: readonly LocalPlayProblemSummary[],
  query: string,
): readonly LocalPlayProblemSummary[] {
  const terms = normalizeSearchText(query)
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return summaries;
  return summaries.filter((summary) => {
    const searchable = normalizeSearchText(
      `${summary.problemId} ${summary.name} ${summary.category}`,
    );
    return terms.every((term) => searchable.includes(term));
  });
}

export function updateProblemPickerState(
  state: ProblemPickerState,
  action: ProblemPickerAction,
  summaries: readonly LocalPlayProblemSummary[],
): ProblemPickerState {
  if (action.type === "append") {
    return { query: `${state.query}${action.text}`, selectedIndex: 0 };
  }
  if (action.type === "backspace") {
    return { query: Array.from(state.query).slice(0, -1).join(""), selectedIndex: 0 };
  }
  if (action.type === "clear") return { query: "", selectedIndex: 0 };

  const count = filterProblemSummaries(summaries, state.query).length;
  if (count === 0) return { ...state, selectedIndex: 0 };
  if (action.type === "first") return { ...state, selectedIndex: 0 };
  if (action.type === "last") return { ...state, selectedIndex: count - 1 };
  const selectedIndex = (((state.selectedIndex + action.delta) % count) + count) % count;
  return { ...state, selectedIndex };
}

function truncate(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, Math.max(1, maxCharacters - 1)).join("")}…`;
}

function colorize(enabled: boolean, codes: string, text: string): string {
  return enabled ? `\u001B[${codes}m${text}\u001B[0m` : text;
}

function renderProblemRows(
  visible: readonly LocalPlayProblemSummary[],
  firstVisible: number,
  selectedIndex: number,
  idWidth: number,
  nameCharacters: number,
  color: boolean,
): string[] {
  if (visible.length === 0) return [colorize(color, "33", "  No matching problems.")];
  return visible.map((summary, index) => {
    const active = firstVisible + index === selectedIndex;
    const marker = active ? "›" : " ";
    const id = truncate(summary.problemId, idWidth).padEnd(idWidth);
    const name = truncate(summary.name, nameCharacters);
    const line = `${marker} ${id}  ${name}`;
    return active ? colorize(color, "1;36", line) : line;
  });
}

export interface ProblemPickerRenderOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly color?: boolean;
}

export function renderSearchableProblemPicker(
  summaries: readonly LocalPlayProblemSummary[],
  state: ProblemPickerState,
  options: ProblemPickerRenderOptions = {},
): string {
  const columns = Math.max(40, options.columns ?? 80);
  const rows = Math.max(10, options.rows ?? 24);
  const color = options.color ?? true;
  const filtered = filterProblemSummaries(summaries, state.query);
  const selectedIndex =
    filtered.length === 0 ? 0 : Math.min(state.selectedIndex, filtered.length - 1);
  const visibleCount = Math.max(3, Math.min(12, rows - 9));
  const firstVisible = Math.max(
    0,
    Math.min(selectedIndex - visibleCount + 1, Math.max(0, filtered.length - visibleCount)),
  );
  const visible = filtered.slice(firstVisible, firstVisible + visibleCount);
  const maxIdWidth = Math.max(8, Math.floor(columns * 0.45));
  const idWidth = Math.min(
    32,
    maxIdWidth,
    Math.max(8, ...visible.map((summary) => summary.problemId.length)),
  );
  // Treat every name character as potentially double-width. This is
  // conservative for English and prevents Japanese names from wrapping.
  const nameCharacters = Math.max(4, Math.floor((columns - idWidth - 6) / 2));
  const problemWord = summaries.length === 1 ? "problem" : "problems";
  const controls =
    columns < 70
      ? "↑/↓ select  •  enter play  •  esc cancel"
      : "type to search  •  ↑/↓ select  •  enter play  •  esc cancel  •  ctrl+u clear";

  const lines = [
    colorize(color, "1", "Choose a problem to play locally"),
    colorize(color, "2", "Type to search by problem id or name."),
    "",
    `${colorize(color, "1", "Search:")} ${state.query}${colorize(color, "36", "▌")}`,
    colorize(color, "2", `${filtered.length} of ${summaries.length} ${problemWord}`),
    "",
    ...renderProblemRows(visible, firstVisible, selectedIndex, idWidth, nameCharacters, color),
  ];

  while (lines.length < rows - 2) lines.push("");
  lines.push(colorize(color, "2", controls));
  return lines.join("\n");
}

export function createProcessProblemPickerTerminal(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): ProblemPickerTerminal {
  let listener: ((text: string | undefined, key: ProblemPickerKey) => void) | undefined;
  const wasRaw = input.isRaw;
  return {
    columns: output.columns ?? 80,
    rows: output.rows ?? 24,
    color: !("NO_COLOR" in process.env) && process.env.TERM !== "dumb",
    write: (text) => {
      output.write(text);
    },
    start: (nextListener) => {
      listener = nextListener;
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", nextListener);
    },
    stop: () => {
      if (listener) input.off("keypress", listener);
      input.setRawMode(wasRaw ?? false);
      input.pause();
    },
  };
}

const NAMED_KEY_ACTIONS: Readonly<Record<string, ProblemPickerAction>> = {
  up: { type: "move", delta: -1 },
  down: { type: "move", delta: 1 },
  pageup: { type: "move", delta: -10 },
  pagedown: { type: "move", delta: 10 },
  home: { type: "first" },
  end: { type: "last" },
  backspace: { type: "backspace" },
};

function isPrintable(text: string): boolean {
  return Array.from(text).every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint !== 0x7f;
  });
}

function problemPickerIntent(text: string | undefined, key: ProblemPickerKey): ProblemPickerIntent {
  if ((key.ctrl && key.name === "c") || key.name === "escape") return { type: "cancel" };
  if (key.name === "return" || key.name === "enter") return { type: "select" };
  if (key.ctrl && key.name === "u") {
    return { type: "update", action: { type: "clear" } };
  }
  const namedAction = key.name ? NAMED_KEY_ACTIONS[key.name] : undefined;
  if (namedAction) return { type: "update", action: namedAction };
  if (text && !key.ctrl && !key.meta && isPrintable(text)) {
    return { type: "update", action: { type: "append", text } };
  }
  return { type: "ignore" };
}

/**
 * Full-screen searchable picker. Terminal control sequences are written only to
 * stderr by the process adapter; the caller keeps stdout exclusively for the
 * selected problem id, preserving `make local` command substitution.
 */
export async function runSearchableProblemPicker(
  summaries: readonly LocalPlayProblemSummary[],
  terminal: ProblemPickerTerminal = createProcessProblemPickerTerminal(),
): Promise<string | undefined> {
  let state: ProblemPickerState = { query: "", selectedIndex: 0 };
  let finished = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (finished) return;
      finished = true;
      try {
        terminal.stop();
      } finally {
        terminal.write(`${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`);
      }
    };
    const finish = (problemId: string | undefined) => {
      cleanup();
      resolve(problemId);
    };
    const render = () => {
      terminal.write(`${CLEAR_SCREEN}${renderSearchableProblemPicker(summaries, state, terminal)}`);
    };

    const onKeypress = (text: string | undefined, key: ProblemPickerKey) => {
      const intent = problemPickerIntent(text, key);
      if (intent.type === "cancel") {
        finish(undefined);
        return;
      }
      if (intent.type === "select") {
        const filtered = filterProblemSummaries(summaries, state.query);
        const selected = filtered[state.selectedIndex];
        if (selected) finish(selected.problemId);
        return;
      }
      if (intent.type === "ignore") return;
      state = updateProblemPickerState(state, intent.action, summaries);
      render();
    };

    try {
      terminal.write(`${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}`);
      terminal.start(onKeypress);
      render();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/**
 * Plain numbered menu retained for non-full-screen callers and backwards
 * compatibility with the #2188 pure formatter contract.
 */
export function renderProblemMenu(summaries: readonly LocalPlayProblemSummary[]): string {
  const numberWidth = String(summaries.length).length;
  const idWidth = Math.max(...summaries.map((summary) => summary.problemId.length));
  const lines = summaries.map((summary, index) => {
    const marker = `${String(index + 1).padStart(numberWidth)})`;
    return `  ${marker} ${summary.problemId.padEnd(idWidth)}  ${summary.name}`;
  });
  return ["Choose a problem to play locally:", "", ...lines].join("\n");
}

export function resolveProblemSelection(
  rawInput: string,
  summaries: readonly LocalPlayProblemSummary[],
): string | undefined {
  const input = rawInput.trim();
  if (input.length === 0) return undefined;
  if (/^\d+$/u.test(input)) return summaries[Number(input) - 1]?.problemId;
  return summaries.find((summary) => summary.problemId === input)?.problemId;
}
