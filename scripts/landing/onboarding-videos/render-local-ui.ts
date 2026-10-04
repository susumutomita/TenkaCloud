import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { validatedLocalRecording } from "./local-ui-validation";

/** Edit continuous isolated Local UI captures; keep existing published footage. */
const [rawArgument, outputArgument] = process.argv.slice(2);
if (!rawArgument || !outputArgument)
  throw new Error("Usage: bun render-local-ui.ts <raw-directory> <output.mp4>");
const raw = resolve(rawArgument),
  output = resolve(outputArgument),
  work = dirname(raw),
  out = join(work, "overlays");
const roles = validatedLocalRecording(raw);
mkdirSync(out, { recursive: true });
const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_BIN ?? "ffprobe";
function run(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${binary} failed: ${(result.stderr ?? "").slice(-2000)}`);
  return result.stdout;
}
function duration(path: string): number {
  const result = JSON.parse(
    run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", path]),
  ) as { format: { duration: string } };
  const seconds = Number(result.format.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Invalid recorded duration.");
  return seconds;
}
const browser = await chromium.launch({
  executablePath:
    process.env.HOST_E2E_CHROMIUM ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
for (const [id, title] of [
  ["organizer", "1. 主催者：問題を選び、大会・チームを作成して開始"],
  ["participant", "2. 参加者：URL＋チームキーで参加 → 解答提出 → 得点確認"],
  ["teardown", "3. 主催者：大会を終了 → 問題環境を撤収 → Removed を確認"],
]) {
  await page.setContent(
    `<html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;font-family:Arial,'Hiragino Kaku Gothic ProN',sans-serif}.top,.bottom{box-sizing:border-box;position:absolute;left:0;right:0;background:#0d1624;color:#f4f7fb}.top{top:0;height:60px;padding:15px 20px;font-size:24px;font-weight:700}.bottom{bottom:0;height:60px;padding:16px 20px;font-size:19px;color:#7ce3d8}</style><div class=top>${title}</div><div class=bottom>隔離 Local 実演 / SQLite＋合成問題adapter / AWS・Docker配置なし / キーと解答は非表示</div></html>`,
  );
  await page.screenshot({ path: `${out}/${id}.png`, omitBackground: true });
}
await browser.close();

const organizerPath = roles["local-catalog.png"],
  participantPath = roles["participant-scoreboard.png"];
if (!organizerPath || !participantPath)
  throw new Error("Expected verified organizer and team-1 recording roles.");
const organizer = duration(organizerPath),
  participant = duration(participantPath);
const points = JSON.parse(readFileSync(join(raw, "edit-points.json"), "utf8")) as {
  openingEnd: number;
  teardownStart: number;
};
if (
  !Number.isFinite(points.openingEnd) ||
  !Number.isFinite(points.teardownStart) ||
  points.openingEnd <= 0 ||
  points.teardownStart <= points.openingEnd ||
  points.teardownStart >= organizer
)
  throw new Error("Expected validated operation timestamps for editing.");
const opening = points.openingEnd,
  tail = organizer - points.teardownStart;
const segments = [
  { name: "organizer", source: organizerPath, offset: 0, length: opening },
  { name: "participant", source: participantPath, offset: 0, length: participant },
  { name: "teardown", source: organizerPath, offset: points.teardownStart, length: tail },
];
const clips = [];
for (const segment of segments) {
  const clip = join(work, `${segment.name}.mp4`);
  clips.push(clip);
  run(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(segment.offset),
    "-t",
    String(segment.length),
    "-i",
    segment.source,
    "-loop",
    "1",
    "-i",
    join(out, `${segment.name}.png`),
    "-filter_complex",
    "[0:v]fps=25,pad=1280:840:0:60:color=0x0d1624[base];[base][1:v]overlay=0:0:shortest=1,format=yuv420p[v]",
    "-map",
    "[v]",
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    "20",
    "-t",
    String(segment.length),
    clip,
  ]);
}
const concat = join(work, "concat.txt");
if (clips.some((path) => path.includes("'")))
  throw new Error("Choose a recording path without apostrophes.");
writeFileSync(concat, clips.map((path) => `file '${path}'\n`).join(""));
mkdirSync(dirname(output), { recursive: true });
run(ffmpeg, [
  "-y",
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  concat,
  "-c",
  "copy",
  "-movflags",
  "+faststart",
  output,
]);
console.log(
  `Wrote ${output} (${segments.reduce((seconds, segment) => seconds + segment.length, 0).toFixed(2)}s)`,
);
