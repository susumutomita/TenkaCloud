/**
 * 学習進捗。
 *
 * 進捗は **学習者のブラウザに閉じ込める** (`notifications-storage.ts` と同じ判断)。
 * 教材の進み具合はスコアでも提出物でもないので、サーバ側に API と表を増やす理由がない。
 * この module は保存先を知らず、直列化と再構築だけを担う (portal 側が localStorage を渡す)。
 *
 * 直列化された値は学習者が自由に書き換えられる外部入力なので、読み戻しは Zod で検証する。
 * 壊れた値・別ドリルの値は `null` を返し、呼び出し側が新規進捗として扱う。
 */

import { z } from "zod";
import type { Drill, DrillSection } from "./types";

/** 1 課題の進捗。 */
export interface TaskProgress {
  readonly completed: boolean;
  readonly attempts: number;
  readonly revealedHints: number;
}

/** ドリル 1 本の進捗。 */
export interface DrillProgress {
  readonly version: 1;
  readonly drillId: string;
  readonly tasks: Readonly<Record<string, TaskProgress>>;
}

const PROGRESS_VERSION = 1;

const taskProgressSchema = z.object({
  completed: z.boolean(),
  attempts: z.number().int().nonnegative(),
  revealedHints: z.number().int().nonnegative(),
});

const drillProgressSchema = z.object({
  version: z.literal(PROGRESS_VERSION),
  drillId: z.string().min(1),
  tasks: z.record(z.string(), taskProgressSchema),
});

const EMPTY_TASK: TaskProgress = { completed: false, attempts: 0, revealedHints: 0 };

/** まだ何もしていない進捗。 */
export function emptyProgress(drillId: string): DrillProgress {
  return { version: PROGRESS_VERSION, drillId, tasks: {} };
}

/** 課題の進捗。未着手なら 0 埋めの既定値。 */
export function taskProgress(progress: DrillProgress, taskId: string): TaskProgress {
  return progress.tasks[taskId] ?? EMPTY_TASK;
}

function withTask(progress: DrillProgress, taskId: string, next: TaskProgress): DrillProgress {
  return { ...progress, tasks: { ...progress.tasks, [taskId]: next } };
}

/**
 * 採点 1 回を記録する。`completed` は **一度立ったら下がらない**: 合格後に同じ課題で
 * 別の値を試して間違えたとき、済んだ節が未達成へ戻るのは学習の妨げにしかならない。
 */
export function recordAttempt(
  progress: DrillProgress,
  taskId: string,
  passed: boolean,
): DrillProgress {
  const current = taskProgress(progress, taskId);
  return withTask(progress, taskId, {
    completed: current.completed || passed,
    attempts: current.attempts + 1,
    revealedHints: current.revealedHints,
  });
}

/** ヒントを 1 段開示する。`hintCount` を超えては増えない。 */
export function revealNextHint(
  progress: DrillProgress,
  taskId: string,
  hintCount: number,
): DrillProgress {
  const current = taskProgress(progress, taskId);
  if (current.revealedHints >= hintCount) return progress;
  return withTask(progress, taskId, {
    ...current,
    revealedHints: current.revealedHints + 1,
  });
}

/** 節の全課題が合格しているか。 */
export function isSectionComplete(section: DrillSection, progress: DrillProgress): boolean {
  return section.tasks.every((task) => taskProgress(progress, task.id).completed);
}

/** 達成済みの節数。 */
export function completedSectionCount(drill: Drill, progress: DrillProgress): number {
  return drill.sections.filter((section) => isSectionComplete(section, progress)).length;
}

/** 未達成の最初の節。全部終わっていれば `undefined`。 */
export function firstIncompleteSection(
  drill: Drill,
  progress: DrillProgress,
): DrillSection | undefined {
  return drill.sections.find((section) => !isSectionComplete(section, progress));
}

const FILLED_CELL = "█";
const EMPTY_CELL = "□";

/**
 * `██████□□□□□□` 形式の進捗バー。節数と同じ長さで出す (= 1 セル 1 節)。
 * `done` は 0..total へ丸める。
 */
export function renderProgressBar(done: number, total: number): string {
  if (total <= 0) return "";
  const filled = Math.min(Math.max(done, 0), total);
  return FILLED_CELL.repeat(filled) + EMPTY_CELL.repeat(total - filled);
}

/** 進捗を保存用の文字列にする。 */
export function serializeProgress(progress: DrillProgress): string {
  return JSON.stringify(progress);
}

/**
 * 保存された文字列から進捗を戻す。
 *
 * 壊れた JSON / schema 違反 / 別ドリルの進捗は `null`。呼び出し側はそのとき
 * `emptyProgress` から始める (静かに部分復元して進捗を捏造しない)。
 */
export function parseProgress(raw: string, drillId: string): DrillProgress | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = drillProgressSchema.safeParse(decoded);
  if (!parsed.success) return null;
  if (parsed.data.drillId !== drillId) return null;
  return { version: PROGRESS_VERSION, drillId, tasks: parsed.data.tasks };
}
