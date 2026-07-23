/**
 * TenkaCloud Lite の実画面収録を、デプロイ編とクリーンアップ編へ切り出す CLI。
 *
 * Usage:
 *   bun run scripts/landing/onboarding-videos/render-recorded-lite.ts \
 *     /path/to/source.mp4 /path/to/upload-work [deploy-tenkacloud-lite|cleanup-tenkacloud-lite]
 *
 * 個人用ブラウザサイドバー、URL バー、AWS role / email が出る上部 chrome は全編で
 * crop する。認証入力、AWS account ID、問題の回答、teamLoginKey が映る区間は
 * sourceRanges から外すか、操作対象だけを focus で拡大して画角の外へ出す。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface RecordedRange {
  readonly chapter:
    | "intro"
    | "setup-explainer"
    | "launcher"
    | "deploy"
    | "admin-sign-in"
    | "trust-explainer"
    | "competitor"
    | "event-explainer"
    | "event-create"
    | "event-deploy"
    | "participant"
    | "play"
    | "score"
    | "cleanup-intro"
    | "cleanup-order"
    | "cleanup-action"
    | "cleanup-wait"
    | "cleanup-launcher"
    | "cleanup-complete";
  /** A generated neutral card; it does not consume or expose source-recording frames. */
  readonly generated?: "intro" | "explainer";
  readonly startS: number;
  readonly endS: number;
  /** Playback rate: waits are accelerated, while a short critical input may be slowed for clarity. */
  readonly speed?: number;
  /** Transition into this range. A white fade separates zoom targets that move across the page. */
  readonly transition?: "fade" | "fadewhite";
  /** Crop the already-normalized 1280x720 view to the safe operation target, then enlarge it. */
  readonly focus?: RecordedFocus;
}

export interface RecordedFocus {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RecordedLiteEdit {
  readonly problemId: "deploy-tenkacloud-lite" | "cleanup-tenkacloud-lite";
  readonly sourceRanges: readonly RecordedRange[];
}

/**
 * Source timeline: deploy 0-365s / cleanup 500-650s.
 * The deploy edit follows one causal story: Lite definition -> launcher -> Lite -> competitor
 * account -> event -> participant play -> score. Waiting views are accelerated and every edit is
 * crossfaded so a time jump is deliberate. Shared-account cleanup after the launcher deletion
 * (CDKToolkit, global log groups, buckets, and so on) is intentionally excluded.
 */
export const RECORDED_LITE_EDITS: readonly RecordedLiteEdit[] = [
  {
    problemId: "deploy-tenkacloud-lite",
    sourceRanges: [
      { chapter: "intro", generated: "intro", startS: 0, endS: 9 },
      { chapter: "setup-explainer", generated: "explainer", startS: 0, endS: 5 },
      { chapter: "launcher", startS: 7, endS: 10 },
      {
        chapter: "launcher",
        startS: 41,
        endS: 47,
        speed: 1.5,
        focus: { x: 90, y: 140, width: 350, height: 300 },
      },
      {
        chapter: "deploy",
        startS: 49,
        endS: 53,
        focus: { x: 305, y: 35, width: 885, height: 160 },
      },
      {
        chapter: "deploy",
        startS: 61,
        endS: 64,
        focus: { x: 310, y: 300, width: 660, height: 420 },
      },
      { chapter: "admin-sign-in", startS: 156, endS: 160 },
      { chapter: "trust-explainer", generated: "explainer", startS: 0, endS: 5.5 },
      {
        chapter: "competitor",
        startS: 168,
        endS: 171,
        focus: { x: 415, y: 245, width: 450, height: 287 },
      },
      { chapter: "competitor", startS: 172, endS: 176, speed: 2 },
      {
        chapter: "competitor",
        startS: 189,
        endS: 192,
        focus: { x: 630, y: 60, width: 560, height: 110 },
      },
      {
        chapter: "competitor",
        startS: 193,
        endS: 198,
        speed: 1.5,
        focus: { x: 630, y: 160, width: 560, height: 180 },
      },
      { chapter: "event-explainer", generated: "explainer", startS: 0, endS: 5 },
      { chapter: "event-create", startS: 212, endS: 216, speed: 2 },
      {
        chapter: "event-create",
        startS: 218,
        endS: 222,
        speed: 1.25,
        focus: { x: 305, y: 330, width: 885, height: 390 },
      },
      {
        chapter: "event-create",
        startS: 228,
        endS: 232,
        speed: 1.25,
        focus: { x: 295, y: 50, width: 885, height: 562 },
      },
      {
        chapter: "event-deploy",
        startS: 276,
        endS: 280,
        speed: 0.8,
        focus: { x: 295, y: 50, width: 885, height: 562 },
      },
      {
        chapter: "participant",
        startS: 307.5,
        endS: 309.5,
        focus: { x: 650, y: 120, width: 540, height: 540 },
      },
      {
        chapter: "participant",
        startS: 310,
        endS: 319,
        speed: 1.5,
        transition: "fadewhite",
        focus: { x: 340, y: 80, width: 530, height: 600 },
      },
      {
        chapter: "participant",
        startS: 319,
        endS: 321,
        focus: { x: 245, y: 120, width: 945, height: 506 },
      },
      {
        chapter: "play",
        startS: 323,
        endS: 326,
        focus: { x: 295, y: 50, width: 885, height: 350 },
      },
      {
        chapter: "play",
        startS: 329,
        endS: 331.5,
        focus: { x: 295, y: 570, width: 885, height: 140 },
      },
      { chapter: "score", startS: 361, endS: 365 },
    ],
  },
  {
    problemId: "cleanup-tenkacloud-lite",
    sourceRanges: [
      {
        chapter: "cleanup-intro",
        generated: "intro",
        startS: 0,
        endS: 7,
      },
      {
        chapter: "cleanup-order",
        generated: "explainer",
        startS: 0,
        endS: 8,
      },
      {
        chapter: "cleanup-action",
        startS: 527,
        endS: 529.8,
        speed: 0.5,
        // ACTION=destroy と入力する領域へ寄り、直下のメールと repository URL を外す。
        focus: { x: 100, y: 30, width: 540, height: 304 },
      },
      {
        chapter: "cleanup-wait",
        startS: 585,
        endS: 597.5,
        speed: 1.3,
        focus: { x: 90, y: 200, width: 650, height: 300 },
      },
      {
        chapter: "cleanup-launcher",
        startS: 630.8,
        endS: 632.2,
        speed: 0.4,
        focus: { x: 380, y: 180, width: 500, height: 300 },
      },
      {
        chapter: "cleanup-launcher",
        startS: 642,
        endS: 648,
        speed: 0.65,
        focus: { x: 90, y: 260, width: 650, height: 250 },
      },
      {
        chapter: "cleanup-complete",
        generated: "explainer",
        startS: 0,
        endS: 7,
      },
    ],
  },
];

export function selectRecordedLiteEdits(problemId?: string): readonly RecordedLiteEdit[] {
  if (!problemId) return RECORDED_LITE_EDITS;
  const edit = RECORDED_LITE_EDITS.find((candidate) => candidate.problemId === problemId);
  if (!edit) throw new Error(`Unknown recorded Lite problem: ${problemId}`);
  return [edit];
}

const TRANSITION_S = 0.3;

function recordedRangeDurationS(range: RecordedRange): number {
  return (range.endS - range.startS) / (range.speed ?? 1);
}

export function recordedEditDurationS(edit: RecordedLiteEdit): number {
  const clips = edit.sourceRanges.reduce((sum, range) => sum + recordedRangeDurationS(range), 0);
  return clips - Math.max(0, edit.sourceRanges.length - 1) * TRANSITION_S;
}

export function recordedChapterStartS(
  edit: RecordedLiteEdit,
  chapter: RecordedRange["chapter"],
): number {
  let startS = 0;
  for (const [index, range] of edit.sourceRanges.entries()) {
    if (range.chapter === chapter) return startS;
    startS += recordedRangeDurationS(range);
    if (index < edit.sourceRanges.length - 1) startS -= TRANSITION_S;
  }
  throw new Error(`Chapter ${chapter} is not present in ${edit.problemId}`);
}

export function buildRecordedFilterGraph(ranges: readonly RecordedRange[]): string {
  if (ranges.length === 0) throw new Error("At least one source range is required");

  const streams = ranges.map((range, index) => {
    if (range.generated) {
      const background = range.generated === "intro" ? "0x071426" : "0x0b2037";
      return (
        `color=c=${background}:s=1280x720:d=${recordedRangeDurationS(range).toFixed(3)},` +
        `fps=30000/1001,setsar=1,format=yuv420p[v${index}]`
      );
    }
    const focus = range.focus
      ? `,crop=${range.focus.width}:${range.focus.height}:${range.focus.x}:${range.focus.y},` +
        "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos," +
        "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xf5f7fa"
      : "";
    return (
      `[0:v]trim=start=${range.startS}:end=${range.endS},setpts=PTS-STARTPTS,` +
      "crop=1472:940:312:140," +
      "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos," +
      `pad=1280:720:(ow-iw)/2:(oh-ih)/2:black${focus},` +
      `setpts=(PTS-STARTPTS)/${range.speed ?? 1},fps=30000/1001,setsar=1,format=yuv420p[v${index}]`
    );
  });
  const durations = ranges.map(recordedRangeDurationS);
  let videoGraph = "";
  if (ranges.length === 1) {
    videoGraph = "[v0]null[vout]";
  } else {
    let cumulative = durations[0];
    for (let index = 1; index < ranges.length; index += 1) {
      const input = index === 1 ? "[v0]" : `[vx${index - 1}]`;
      const output = index === ranges.length - 1 ? "[vout]" : `[vx${index}]`;
      const offset = cumulative - TRANSITION_S * index;
      videoGraph +=
        `${videoGraph ? ";" : ""}${input}[v${index}]xfade=transition=${ranges[index].transition ?? "fade"}:` +
        `duration=${TRANSITION_S}:offset=${offset.toFixed(3)}${output}`;
      cumulative += durations[index];
    }
  }
  const duration =
    durations.reduce((sum, clipDuration) => sum + clipDuration, 0) -
    TRANSITION_S * Math.max(0, ranges.length - 1);
  return (
    `${streams.join(";")};${videoGraph};` +
    `anullsrc=r=48000:cl=stereo,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`
  );
}

function runFfmpeg(sourcePath: string, edit: RecordedLiteEdit, outputPath: string): void {
  const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
  const result = spawnSync(
    ffmpeg,
    [
      "-y",
      "-i",
      sourcePath,
      "-filter_complex",
      buildRecordedFilterGraph(edit.sourceRanges),
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed for ${edit.problemId}:\n${result.stderr?.toString().slice(-4_000)}`,
    );
  }
}

function main(): void {
  const sourcePath = process.argv[2];
  const outputDir = process.argv[3];
  const problemId = process.argv[4];
  if (!sourcePath || !outputDir) {
    throw new Error(
      "Usage: render-recorded-lite.ts <source.mp4> <external-output-directory> [problem-id]",
    );
  }
  if (!existsSync(sourcePath)) throw new Error(`Recorded source not found: ${sourcePath}`);

  mkdirSync(outputDir, { recursive: true });
  for (const edit of selectRecordedLiteEdits(problemId)) {
    const outputPath = join(outputDir, `${edit.problemId}.mp4`);
    runFfmpeg(sourcePath, edit, outputPath);
    console.log(`wrote ${outputPath} (${recordedEditDurationS(edit).toFixed(1)}s)`);
  }
}

if (import.meta.main) main();
