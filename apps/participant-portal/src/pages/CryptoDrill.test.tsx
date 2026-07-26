import {
  emptyProgress,
  isValueTask,
  listTasks,
  recordAttempt,
  SHA256_DRILL,
} from "@tenkacloud/crypto-drill";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drillStorageKey } from "../lib/crypto-drill-storage";

/**
 * ドリル画面: 進捗表示 / 節移動 / 進捗の localStorage 永続化 / 再訪時の開始位置を pin する。
 * i18n は key をそのまま返す stub にして、 文言ではなく状態を検査する。
 */

vi.mock("../i18n", () => ({
  useI18n: () => ({
    locale: "ja" as const,
    t: (key: string, params?: Readonly<Record<string, string | number>>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
  }),
}));

const { CryptoDrillPage, initialSectionIndex } = await import("./CryptoDrill");

beforeEach(() => {
  window.localStorage.clear();
});

/** 節 1 の全課題を localStorage 上で達成済みにする。 */
function completeFirstSection() {
  const first = SHA256_DRILL.sections[0];
  let progress = emptyProgress(SHA256_DRILL.id);
  for (const task of first.tasks) {
    progress = recordAttempt(progress, task.id, true);
  }
  window.localStorage.setItem(drillStorageKey(SHA256_DRILL.id), JSON.stringify(progress));
  return progress;
}

describe("initialSectionIndex", () => {
  it("should start at the first section when nothing is done", () => {
    expect(initialSectionIndex(emptyProgress(SHA256_DRILL.id))).toBe(0);
  });

  it("should start at the first section that is not complete", () => {
    expect(initialSectionIndex(completeFirstSection())).toBe(1);
  });

  it("should fall back to the first section when everything is complete", () => {
    let progress = emptyProgress(SHA256_DRILL.id);
    for (const task of listTasks(SHA256_DRILL)) {
      progress = recordAttempt(progress, task.id, true);
    }
    expect(initialSectionIndex(progress)).toBe(0);
  });
});

describe("CryptoDrillPage", () => {
  it("should show the drill title, the progress bar and the section count", () => {
    render(<CryptoDrillPage />);
    expect(screen.getByText("SHA-256 をステップ実行で理解する")).toBeInTheDocument();
    expect(screen.getByTestId("drill-progress-bar").textContent).toBe("□□□□□□□□□□□□□□□  0 / 15");
    expect(
      screen.getByText('crypto_drill.progress_label|{"done":0,"total":15}'),
    ).toBeInTheDocument();
  });

  it("should open at the first section and offer a jump button per section", () => {
    render(<CryptoDrillPage />);
    expect(
      screen.getByText('crypto_drill.section_heading|{"order":1,"title":"文字列を byte 列にする"}'),
    ).toBeInTheDocument();
    expect(screen.getByTestId("drill-section-jump-15")).toBeInTheDocument();
  });

  it("should disable previous on the first section and next on the last", async () => {
    render(<CryptoDrillPage />);
    expect(screen.getByTestId("drill-prev")).toBeDisabled();
    expect(screen.getByTestId("drill-next")).toBeEnabled();
    await userEvent.click(screen.getByTestId("drill-section-jump-15"));
    expect(screen.getByTestId("drill-next")).toBeDisabled();
    expect(screen.getByTestId("drill-prev")).toBeEnabled();
  });

  it("should move forward and back one section at a time", async () => {
    render(<CryptoDrillPage />);
    await userEvent.click(screen.getByTestId("drill-next"));
    expect(
      screen.getByText(
        'crypto_drill.section_heading|{"order":2,"title":"パディングで 512 bit の倍数にする"}',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("drill-prev"));
    expect(
      screen.getByText('crypto_drill.section_heading|{"order":1,"title":"文字列を byte 列にする"}'),
    ).toBeInTheDocument();
  });

  it("should resume at the first unfinished section on a later visit", () => {
    completeFirstSection();
    render(<CryptoDrillPage />);
    expect(
      screen.getByText(
        'crypto_drill.section_heading|{"order":2,"title":"パディングで 512 bit の倍数にする"}',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("drill-progress-bar").textContent).toBe("█□□□□□□□□□□□□□□  1 / 15");
    expect(screen.getByTestId("drill-section-jump-1").textContent).toContain("✓");
  });

  it("should persist a passed attempt so the progress bar advances", async () => {
    render(<CryptoDrillPage />);
    const first = SHA256_DRILL.sections[0];
    for (const task of first.tasks) {
      if (!isValueTask(task)) continue;
      for (const drillCase of task.cases) {
        fireEvent.change(screen.getByLabelText(drillCase.label.ja), {
          target: { value: drillCase.expected },
        });
      }
      await userEvent.click(screen.getByTestId(`grade-${task.id}`));
    }
    expect(screen.getByTestId("drill-progress-bar").textContent).toBe("█□□□□□□□□□□□□□□  1 / 15");
    const stored = window.localStorage.getItem(drillStorageKey(SHA256_DRILL.id));
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "{}").tasks["utf8-hex"].completed).toBe(true);
  });

  it("should persist a revealed hint across a remount", async () => {
    const first = SHA256_DRILL.sections[0];
    const task = first.tasks[0];
    const { unmount } = render(<CryptoDrillPage />);
    await userEvent.click(screen.getByTestId(`hint-${task.id}`));
    expect(screen.getByText(task.hints[0].text.ja)).toBeInTheDocument();
    unmount();
    render(<CryptoDrillPage />);
    expect(screen.getByText(task.hints[0].text.ja)).toBeInTheDocument();
  });
});
