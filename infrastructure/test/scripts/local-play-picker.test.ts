import { describe, expect, it } from "vitest";
import type { LocalPlayProblemSummary } from "../../../scripts/local-play/manifest";
import {
  filterProblemSummaries,
  type ProblemPickerKey,
  type ProblemPickerTerminal,
  renderProblemMenu,
  renderSearchableProblemPicker,
  resolveProblemSelection,
  runSearchableProblemPicker,
  updateProblemPickerState,
} from "../../../scripts/local-play/picker";

const summaries: LocalPlayProblemSummary[] = [
  { problemId: "sqli-demo", name: "スタッフ専用ログイン", category: "challenges" },
  {
    problemId: "festivalgate-terminal-api",
    name: "入場端末の信頼境界",
    category: "challenges",
  },
  { problemId: "wp-exposed-backup", name: "前任者の忘れ物", category: "challenges" },
];

class FakeTerminal implements ProblemPickerTerminal {
  readonly columns = 100;
  readonly rows = 16;
  readonly color = false;
  readonly writes: string[] = [];
  started = false;
  stopped = false;
  private listener?: (text: string | undefined, key: ProblemPickerKey) => void;

  readonly write = (text: string) => {
    this.writes.push(text);
  };

  readonly start = (listener: (text: string | undefined, key: ProblemPickerKey) => void) => {
    this.started = true;
    this.listener = listener;
  };

  readonly stop = () => {
    this.stopped = true;
    this.listener = undefined;
  };

  press(text: string | undefined, key: ProblemPickerKey): void {
    this.listener?.(text, key);
  }
}

describe("filterProblemSummaries", () => {
  it("searches ids, Japanese display names, and categories", () => {
    expect(filterProblemSummaries(summaries, "festival").map((item) => item.problemId)).toEqual([
      "festivalgate-terminal-api",
    ]);
    expect(filterProblemSummaries(summaries, "前任者").map((item) => item.problemId)).toEqual([
      "wp-exposed-backup",
    ]);
    expect(
      filterProblemSummaries(summaries, "wp challenges").map((item) => item.problemId),
    ).toEqual(["wp-exposed-backup"]);
  });

  it("normalizes case and full-width input", () => {
    expect(filterProblemSummaries(summaries, "ＳＱＬＩ").map((item) => item.problemId)).toEqual([
      "sqli-demo",
    ]);
  });

  it("returns the original stable order for an empty query", () => {
    expect(filterProblemSummaries(summaries, "")).toEqual(summaries);
  });
});

describe("updateProblemPickerState", () => {
  it("resets the selection when the query changes and removes Unicode by code point", () => {
    const filtered = updateProblemPickerState(
      { query: "", selectedIndex: 2 },
      { type: "append", text: "前任者" },
      summaries,
    );
    expect(filtered).toEqual({ query: "前任者", selectedIndex: 0 });
    expect(updateProblemPickerState(filtered, { type: "backspace" }, summaries).query).toBe("前任");
  });

  it("wraps keyboard navigation within the filtered results", () => {
    expect(
      updateProblemPickerState(
        { query: "", selectedIndex: 0 },
        { type: "move", delta: -1 },
        summaries,
      ).selectedIndex,
    ).toBe(2);
    expect(
      updateProblemPickerState(
        { query: "wp", selectedIndex: 0 },
        { type: "move", delta: 1 },
        summaries,
      ).selectedIndex,
    ).toBe(0);
  });
});

describe("renderSearchableProblemPicker", () => {
  it("renders the query, result count, selected row, and controls", () => {
    const screen = renderSearchableProblemPicker(
      summaries,
      { query: "terminal", selectedIndex: 0 },
      { columns: 100, rows: 16, color: false },
    );
    expect(screen).toContain("Search: terminal▌");
    expect(screen).toContain("1 of 3 problems");
    expect(screen).toContain("› festivalgate-terminal-api");
    expect(screen).not.toContain("sqli-demo");
    expect(screen).toContain("↑/↓ select");
  });

  it("renders a stable empty state", () => {
    const screen = renderSearchableProblemPicker(
      summaries,
      { query: "missing", selectedIndex: 0 },
      { color: false },
    );
    expect(screen).toContain("0 of 3 problems");
    expect(screen).toContain("No matching problems.");
  });

  it("scrolls a large result set to keep the selected problem visible", () => {
    const many = Array.from({ length: 185 }, (_, index) => ({
      problemId: `problem-${String(index).padStart(3, "0")}`,
      name: `Problem ${index}`,
      category: "challenges",
    }));
    const screen = renderSearchableProblemPicker(
      many,
      { query: "", selectedIndex: 120 },
      { columns: 80, rows: 14, color: false },
    );
    expect(screen).toContain("185 of 185 problems");
    expect(screen).toContain("› problem-120");
    expect(screen).not.toContain("problem-000");
  });

  it("uses a compact controls line in a narrow terminal", () => {
    const screen = renderSearchableProblemPicker(
      summaries,
      { query: "", selectedIndex: 0 },
      { columns: 40, rows: 12, color: false },
    );
    expect(screen).toContain("↑/↓ select  •  enter play  •  esc cancel");
    expect(screen).not.toContain("ctrl+u clear");
  });
});

describe("runSearchableProblemPicker", () => {
  it("filters while typing, navigates, returns only the selected id, and restores the terminal", async () => {
    const terminal = new FakeTerminal();
    const result = runSearchableProblemPicker(summaries, terminal);

    for (const character of "challenges") {
      terminal.press(character, { name: character });
    }
    // All fixtures are in the challenges group, so Down selects the second row.
    terminal.press(undefined, { name: "down" });
    terminal.press("\r", { name: "return" });

    await expect(result).resolves.toBe("festivalgate-terminal-api");
    expect(terminal.started).toBe(true);
    expect(terminal.stopped).toBe(true);
    expect(terminal.writes.join("")).toContain("\u001B[?1049h");
    expect(terminal.writes.join("")).toContain("\u001B[?1049l");
  });

  it("keeps the picker open when Enter is pressed with no matches", async () => {
    const terminal = new FakeTerminal();
    const result = runSearchableProblemPicker(summaries, terminal);

    for (const character of "missing") terminal.press(character, { name: character });
    terminal.press("\r", { name: "return" });
    terminal.press(undefined, { name: "u", ctrl: true });
    terminal.press(undefined, { name: "down" });
    terminal.press("\r", { name: "return" });

    await expect(result).resolves.toBe("festivalgate-terminal-api");
  });

  it("cancels on Escape and still restores the terminal", async () => {
    const terminal = new FakeTerminal();
    const result = runSearchableProblemPicker(summaries, terminal);
    terminal.press(undefined, { name: "escape" });

    await expect(result).resolves.toBeUndefined();
    expect(terminal.stopped).toBe(true);
    expect(terminal.writes.join("")).toContain("\u001B[?25h");
  });
});

describe("plain picker compatibility (#2188)", () => {
  it("numbers every problem and aligns the ids", () => {
    expect(renderProblemMenu(summaries.slice(0, 2))).toBe(
      [
        "Choose a problem to play locally:",
        "",
        "  1) sqli-demo                  スタッフ専用ログイン",
        "  2) festivalgate-terminal-api  入場端末の信頼境界",
      ].join("\n"),
    );
  });

  it("resolves a number or exact id and rejects invalid input", () => {
    expect(resolveProblemSelection("2", summaries)).toBe("festivalgate-terminal-api");
    expect(resolveProblemSelection("sqli-demo", summaries)).toBe("sqli-demo");
    expect(resolveProblemSelection("0", summaries)).toBeUndefined();
    expect(resolveProblemSelection("missing", summaries)).toBeUndefined();
  });
});
