/**
 * Add Japanese VOICEVOX:ずんだもん narration, natural macOS English narration,
 * and localized WebVTT captions to the recorded Lite videos.
 *
 * Prerequisites:
 *   docker run --rm -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:cpu-latest
 *   macOS `say` command with the Samantha voice installed
 *   bun run scripts/landing/onboarding-videos/render-recorded-lite.ts /path/to/source.mp4
 *
 * Usage:
 *   bun run scripts/landing/onboarding-videos/render-zundamon.ts
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  cleanupTemporaryVideoDirectory,
  createTemporaryVideoDirectory,
  escapeHtml,
  resolveBin,
  run as runCommand,
} from "./render";
import {
  RECORDED_LITE_EDITS,
  type RecordedLiteEdit,
  recordedChapterStartS,
  recordedEditDurationS,
} from "./render-recorded-lite";
import {
  CLEANUP_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER,
  DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER,
  type VoiceoverCue,
  type VoiceoverLocale,
  type VoiceoverScript,
} from "./voiceover-data";

const VOICEVOX_SPEAKER_ID = 3;
const MAX_ATEMPO = 1.4;

interface VoiceoverTimeline {
  readonly starts: readonly number[];
  readonly videoDurationS: number;
}

const editByProblemId = Object.fromEntries(
  RECORDED_LITE_EDITS.map((edit) => [edit.problemId, edit]),
) as Record<RecordedLiteEdit["problemId"], RecordedLiteEdit>;

const deployEdit = editByProblemId["deploy-tenkacloud-lite"];
const cleanupEdit = editByProblemId["cleanup-tenkacloud-lite"];
const deployDurationS = recordedEditDurationS(deployEdit);
const cleanupDurationS = recordedEditDurationS(cleanupEdit);

export const VOICEOVER_TIMELINES: Readonly<
  Record<RecordedLiteEdit["problemId"], VoiceoverTimeline>
> = {
  "deploy-tenkacloud-lite": {
    starts: [
      recordedChapterStartS(deployEdit, "intro") + 0.2,
      recordedChapterStartS(deployEdit, "setup-explainer") + 0.2,
      recordedChapterStartS(deployEdit, "launcher") + 0.3,
      recordedChapterStartS(deployEdit, "deploy") + 0.2,
      recordedChapterStartS(deployEdit, "admin-sign-in") + 0.2,
      recordedChapterStartS(deployEdit, "trust-explainer") + 0.2,
      recordedChapterStartS(deployEdit, "competitor") + 0.2,
      recordedChapterStartS(deployEdit, "event-explainer") + 0.2,
      recordedChapterStartS(deployEdit, "event-create") + 0.2,
      recordedChapterStartS(deployEdit, "event-deploy") + 0.2,
      recordedChapterStartS(deployEdit, "participant") + 0.2,
      recordedChapterStartS(deployEdit, "play") + 0.2,
      recordedChapterStartS(deployEdit, "score") + 0.2,
    ],
    videoDurationS: deployDurationS,
  },
  "cleanup-tenkacloud-lite": {
    starts: [
      recordedChapterStartS(cleanupEdit, "cleanup-action") + 0.3,
      recordedChapterStartS(cleanupEdit, "cleanup-wait") + 0.2,
      recordedChapterStartS(cleanupEdit, "cleanup-launcher") + 0.2,
    ],
    videoDurationS: cleanupDurationS,
  },
};

const SCRIPT_BY_PROBLEM_ID: Readonly<Record<RecordedLiteEdit["problemId"], VoiceoverScript>> = {
  "deploy-tenkacloud-lite": DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER,
  "cleanup-tenkacloud-lite": CLEANUP_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER,
};

export function localizedVideoPath(path: string, locale: VoiceoverLocale): string {
  if (locale === "ja") return path;
  const extension = extname(path);
  return `${path.slice(0, -extension.length)}.${locale}${extension}`;
}

export function localeWorkVideoPath(
  workDir: string,
  problemId: RecordedLiteEdit["problemId"],
  locale: VoiceoverLocale,
): string {
  return join(workDir, `${problemId}-${locale}.mp4`);
}

export function assertUnvoicedRecordedBase(comment: string, path: string): void {
  if (comment.includes("VOICEVOX:") || comment.includes("macOS Samantha")) {
    throw new Error(
      `Refusing to add captions twice to ${path}. Run render-recorded-lite.ts again first.`,
    );
  }
}

function formatComment(path: string): string {
  const result = spawnSync(
    process.env.FFPROBE_BIN ?? "ffprobe",
    ["-v", "error", "-show_entries", "format_tags=comment", "-of", "default=nw=1:nk=1", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not inspect source metadata for ${path}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function localizedCaptionPath(path: string, locale: VoiceoverLocale): string {
  const extension = extname(path);
  return `${path.slice(0, -extension.length)}.${locale}.vtt`;
}

function vttTimestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return [hours, minutes, wholeSeconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":")
    .concat(`.${remainder.toString().padStart(3, "0")}`);
}

export function buildWebVtt(
  cues: readonly VoiceoverCue[],
  locale: VoiceoverLocale,
  starts: readonly number[],
  videoDurationS: number,
): string {
  if (cues.length !== starts.length) throw new Error("Every voice-over cue needs a timeline start");
  const blocks = cues.map((cue, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] - 0.2 : videoDurationS - 0.2;
    if (end <= starts[index]) throw new Error(`Invalid caption window for cue ${index}`);
    return `${index + 1}\n${vttTimestamp(starts[index])} --> ${vttTimestamp(end)}\n${cue[locale]}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

function buildIntroOverlayHtml(cue: VoiceoverCue, locale: VoiceoverLocale): string {
  const details = cue.details?.[locale] ?? [];
  const note = cue.note ? `<div class="stack-note">${escapeHtml(cue.note[locale])}</div>` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #071426; }
body { box-sizing: border-box; padding: 74px 90px; font-family: Inter, "Noto Sans JP", "Hiragino Sans", sans-serif;
  color: #f8fbff; background: radial-gradient(circle at 82% 18%, #123d70 0, #071426 43%); }
.eyebrow { display: inline-block; padding: 9px 15px; border: 1px solid #68a9ff; border-radius: 999px;
  color: #9bc7ff; font-size: 18px; font-weight: 800; letter-spacing: .12em; }
h1 { margin: 30px 0 14px; max-width: 930px; font-size: ${locale === "ja" ? 58 : 54}px; line-height: 1.15; }
.lead { max-width: 1010px; color: #dceaff; font-size: ${locale === "ja" ? 29 : 27}px;
  line-height: 1.45; font-weight: 650; }
.facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 36px; }
.fact { position: relative; padding: 20px 18px; border-radius: 16px; background: rgba(20, 58, 99, .76);
  border: 1px solid rgba(155, 199, 255, .46); font-size: ${locale === "ja" ? 20 : 18}px;
  line-height: 1.35; font-weight: 700; }
.fact:not(:last-child)::after { content: "→"; position: absolute; right: -14px; top: 26px;
  z-index: 2; color: #9bc7ff; font-size: 24px; }
.stack-note { margin-top: 22px; color: #9bc7ff; font-size: 17px; font-weight: 700; }
.foot { position: absolute; right: 90px; bottom: 30px; color: #8dacd0; font-size: 16px; }
</style></head><body>
<div class="eyebrow">TENKACLOUD LITE · AWS DEPLOYMENT</div>
<h1>${escapeHtml(cue.heading[locale])}</h1>
<div class="lead">${escapeHtml(cue[locale])}</div>
<div class="facts">${details.map((detail) => `<div class="fact">${escapeHtml(detail)}</div>`).join("")}</div>
${note}
<div class="foot">Single tenant · One organizer · One event</div>
</body></html>`;
}

function buildExplainerOverlayHtml(cue: VoiceoverCue, locale: VoiceoverLocale): string {
  const details = cue.details?.[locale] ?? [];
  const note = cue.note ? `<div class="why">${escapeHtml(cue.note[locale])}</div>` : "";
  const eyebrow =
    cue.layout === "start"
      ? "START HERE · THEN THE REAL AWS CONSOLE"
      : "WHY THIS STEP · THEN THE REAL AWS CONSOLE";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #0b2037; }
body { box-sizing: border-box; padding: 70px 90px; font-family: Inter, "Noto Sans JP", "Hiragino Sans", sans-serif;
  color: #f8fbff; background: radial-gradient(circle at 15% 80%, #174c67 0, #0b2037 42%); }
.eyebrow { color: #7fddc3; font-size: 19px; font-weight: 850; letter-spacing: .12em; }
h1 { margin: 20px 0 12px; font-size: ${locale === "ja" ? 52 : 48}px; line-height: 1.15; }
.reason { max-width: 1040px; color: #dceaff; font-size: ${locale === "ja" ? 28 : 26}px;
  line-height: 1.45; font-weight: 650; }
.flow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 42px; }
.node { position: relative; min-height: 94px; display: flex; align-items: center; justify-content: center;
  padding: 18px; border-radius: 16px; background: rgba(18, 62, 83, .82);
  border: 1px solid rgba(127, 221, 195, .62); text-align: center;
  font-size: ${locale === "ja" ? 23 : 21}px; line-height: 1.3; font-weight: 780; }
.node:not(:last-child)::after { content: "→"; position: absolute; right: -30px; color: #7fddc3; font-size: 30px; }
.why { margin-top: 30px; padding-left: 16px; border-left: 4px solid #7fddc3;
  color: #bfe8dc; font-size: ${locale === "ja" ? 20 : 18}px; font-weight: 700; }
.next { position: absolute; right: 90px; bottom: 34px; color: #85a8c7; font-size: 16px; }
</style></head><body>
<div class="eyebrow">${eyebrow}</div>
<h1>${escapeHtml(cue.heading[locale])}</h1>
<div class="reason">${escapeHtml(cue[locale])}</div>
<div class="flow">${details.map((detail) => `<div class="node">${escapeHtml(detail)}</div>`).join("")}</div>
${note}
<div class="next">Next: actual screen operation</div>
</body></html>`;
}

function buildOperationOverlayHtml(
  cue: VoiceoverCue,
  locale: VoiceoverLocale,
  index: number,
  total: number,
): string {
  const note = cue.note?.[locale];
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: transparent; }
body { font-family: Inter, "Noto Sans JP", "Hiragino Sans", sans-serif; color: #fff; }
.step { position: absolute; top: 18px; left: 18px; padding: 10px 18px; border-radius: 999px;
  background: rgba(7, 17, 31, .92); border: 2px solid #68a9ff; font-size: 22px; font-weight: 800; }
.caption { position: absolute; left: 40px; right: 40px; bottom: 24px; padding: 16px 24px;
  border-radius: 14px; background: rgba(7, 17, 31, .92); border: 2px solid rgba(255, 255, 255, .28);
  font-size: ${locale === "ja" ? 29 : 26}px; line-height: 1.35; font-weight: 700; text-align: center;
  text-shadow: 0 2px 4px #000; }
.note { position: absolute; top: 78px; left: 18px; max-width: 820px; padding: 8px 14px; border-radius: 10px;
  background: rgba(7, 17, 31, .88); border: 1px solid rgba(104, 169, 255, .62);
  color: #dceaff; font-size: ${locale === "ja" ? 17 : 16}px; font-weight: 700; }
</style></head><body>
<div class="step">STEP ${index + 1} / ${total} · ${escapeHtml(cue.heading[locale])}</div>
${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}
<div class="caption">${escapeHtml(cue[locale])}</div>
</body></html>`;
}

export function buildCaptionOverlayHtml(
  cue: VoiceoverCue,
  locale: VoiceoverLocale,
  index: number,
  total: number,
): string {
  if (cue.layout === "intro") return buildIntroOverlayHtml(cue, locale);
  if (cue.layout === "start" || cue.layout === "explainer") {
    return buildExplainerOverlayHtml(cue, locale);
  }
  return buildOperationOverlayHtml(cue, locale, index, total);
}

export function buildCaptionOverlayFilter(
  starts: readonly number[],
  firstOverlayInputIndex: number,
  videoDurationS: number,
): string {
  if (starts.length === 0) throw new Error("At least one caption overlay is required");
  const filters: string[] = [];
  let videoInput = "[0:v]";
  for (const [index, start] of starts.entries()) {
    const end = index + 1 < starts.length ? starts[index + 1] - 0.2 : videoDurationS - 0.2;
    const output = `[vc${index}]`;
    filters.push(
      `${videoInput}[${firstOverlayInputIndex + index}:v]overlay=0:0:` +
        `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})':eof_action=pass${output}`,
    );
    videoInput = output;
  }
  filters.push(`${videoInput}format=yuv420p[vout]`);
  return filters.join(";");
}

export function buildVoiceoverMixFilter(
  starts: readonly number[],
  cueDurationsS: readonly number[],
  videoDurationS: number,
): string {
  if (starts.length === 0 || starts.length !== cueDurationsS.length) {
    throw new Error("Narration starts and durations must be non-empty and aligned");
  }
  const filters = starts.map((start, index) => {
    const slotEnd = index + 1 < starts.length ? starts[index + 1] - 0.25 : videoDurationS - 0.25;
    const slotDuration = slotEnd - start;
    const speed = Math.max(1, cueDurationsS[index] / slotDuration);
    if (speed > MAX_ATEMPO) {
      throw new Error(
        `Narration cue ${index} exceeds its slot (${cueDurationsS[index].toFixed(2)}s / ${slotDuration.toFixed(2)}s)`,
      );
    }
    const atempo = speed > 1.001 ? `,atempo=${speed.toFixed(4)}` : "";
    const delayMs = Math.round(start * 1_000);
    return (
      `[${index + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo${atempo},` +
      `adelay=${delayMs}|${delayMs}[a${index}]`
    );
  });
  const inputs = starts.map((_, index) => `[a${index}]`).join("");
  return (
    `${filters.join(";")};${inputs}amix=inputs=${starts.length}:duration=longest:normalize=0,` +
    `loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=duration=${videoDurationS.toFixed(3)}[aout]`
  );
}

export function normalizeEnglishForSpeech(text: string): string {
  return text
    .replace(/\bwe'll\b/gi, "we will")
    .replace(/\byou're\b/gi, "you are")
    .replace(/\bit's\b/gi, "it is")
    .replace(/\bdon't\b/gi, "do not")
    .replace(/\bTenkaCloud\b/g, "Tenka Cloud")
    .replace(/\bLite\b/g, "Light")
    .replace(/\bAWS\b/g, "A W S")
    .replace(/\bCloudFormation\b/g, "Cloud Formation")
    .replace(/\bCodeBuild\b/g, "Code Build")
    .replace(/\bExternalId\b/g, "External I D")
    .replace(/\bAssumeRole\b/g, "Assume Role")
    .replace(/\bSUCCEEDED\b/g, "succeeded")
    .replace(/\bURLs?\b/g, (value) => (value.endsWith("s") ? "U R Ls" : "U R L"));
}

export function normalizeJapaneseForSpeech(text: string): string {
  return text
    .replace(/\bCloudFormation\b/g, "クラウドフォーメーション")
    .replace(/\bCodeBuild\b/g, "コードビルド")
    .replace(/\bIAM Role\b/gi, "アイエーエム ロール")
    .replace(/\bCDK\b/g, "シーディーケー")
    .replace(/\bstack\b/gi, "スタック")
    .replace(/\bproject\b/gi, "プロジェクト")
    .replace(/\bdeploy\b/gi, "デプロイ");
}

function assertLocalVoicevoxUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (!(["127.0.0.1", "localhost"].includes(url.hostname) && url.protocol === "http:")) {
    throw new Error("VOICEVOX_URL must be a local http://127.0.0.1 or http://localhost endpoint");
  }
  return url;
}

async function synthesizeVoicevoxCue(
  engineUrl: URL,
  text: string,
  outputPath: string,
): Promise<void> {
  const queryUrl = new URL("/audio_query", engineUrl);
  queryUrl.searchParams.set("text", text);
  queryUrl.searchParams.set("speaker", VOICEVOX_SPEAKER_ID.toString());
  const queryResponse = await fetch(queryUrl, { method: "POST" });
  if (!queryResponse.ok) {
    throw new Error(
      `VOICEVOX audio_query failed: ${queryResponse.status} ${await queryResponse.text()}`,
    );
  }
  const query = (await queryResponse.json()) as Record<string, unknown>;
  query.speedScale = 1.08;
  query.outputSamplingRate = 48_000;
  query.outputStereo = true;

  const synthesisUrl = new URL("/synthesis", engineUrl);
  synthesisUrl.searchParams.set("speaker", VOICEVOX_SPEAKER_ID.toString());
  const synthesisResponse = await fetch(synthesisUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!synthesisResponse.ok) {
    throw new Error(
      `VOICEVOX synthesis failed: ${synthesisResponse.status} ${await synthesisResponse.text()}`,
    );
  }
  writeFileSync(outputPath, Buffer.from(await synthesisResponse.arrayBuffer()));
}

function synthesizeEnglishCue(text: string, outputPath: string): string {
  const voice = process.env.ENGLISH_TTS_VOICE?.trim() || "Samantha";
  const aiffPath = outputPath.replace(/\.wav$/, ".aiff");
  const say = spawnSync("say", ["-v", voice, "-r", "175", "-o", aiffPath, text], {
    encoding: "utf8",
  });
  if (say.status !== 0) {
    throw new Error(`macOS say failed with voice ${voice}: ${say.stderr}`);
  }
  runCommand(process.env.FFMPEG_BIN ?? "ffmpeg", [
    "-y",
    "-i",
    aiffPath,
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ]);
  return voice;
}

function audioDurationS(path: string): number {
  const result = spawnSync(
    process.env.FFPROBE_BIN ?? "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { encoding: "utf8" },
  );
  const duration = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read narration duration for ${path}: ${result.stderr}`);
  }
  return duration;
}

function renderCaptionOverlay(
  chromium: string,
  cue: VoiceoverCue,
  locale: VoiceoverLocale,
  problemId: RecordedLiteEdit["problemId"],
  cueIndex: number,
  displayIndex: number,
  total: number,
  workDir: string,
): string {
  const basename = captionOverlayBasename(problemId, locale, cueIndex);
  const htmlPath = join(workDir, `${basename}.html`);
  const pngPath = join(workDir, `${basename}.png`);
  writeFileSync(htmlPath, buildCaptionOverlayHtml(cue, locale, displayIndex, total));
  runCommand(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1280,720",
    "--default-background-color=00000000",
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ]);
  return pngPath;
}

export function captionOverlayBasename(
  problemId: RecordedLiteEdit["problemId"],
  locale: VoiceoverLocale,
  cueIndex: number,
): string {
  return `${problemId}-caption-${locale}-${cueIndex}`;
}

function muxVoiceover(
  baseVideoPath: string,
  cuePaths: readonly string[],
  overlayPaths: readonly string[],
  starts: readonly number[],
  videoDurationS: number,
  outputPath: string,
  voiceCredit: string,
): void {
  if (cuePaths.length !== overlayPaths.length) {
    throw new Error("Every narration cue needs one burned-caption overlay");
  }
  const cueDurations = cuePaths.map(audioDurationS);
  const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
  const tempOutput = join(dirname(outputPath), `.${basename(outputPath)}.${Date.now()}.tmp.mp4`);
  const result = spawnSync(
    ffmpeg,
    [
      "-y",
      "-i",
      baseVideoPath,
      ...cuePaths.flatMap((path) => ["-i", path]),
      ...overlayPaths.flatMap((path) => ["-loop", "1", "-framerate", "30", "-i", path]),
      "-filter_complex",
      `${buildVoiceoverMixFilter(starts, cueDurations, videoDurationS)};` +
        buildCaptionOverlayFilter(starts, cuePaths.length + 1, videoDurationS),
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
      "160k",
      "-metadata",
      `comment=${voiceCredit}`,
      "-movflags",
      "+faststart",
      tempOutput,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg voice-over mux failed:\n${result.stderr?.toString().slice(-4_000)}`);
  }
  renameSync(tempOutput, outputPath);
}

async function renderLocale(
  problemId: RecordedLiteEdit["problemId"],
  script: VoiceoverScript,
  locale: VoiceoverLocale,
  baseVideoPath: string,
  outputPath: string,
  engineUrl: URL,
  chromium: string,
  workDir: string,
): Promise<void> {
  const timeline = VOICEOVER_TIMELINES[problemId];
  const cuePaths: string[] = [];
  const overlayPaths: string[] = [];
  const operationTotal = script.cues.filter((cue) => cue.layout === undefined).length;
  let operationIndex = 0;
  let englishVoice = "Samantha";
  for (const [index, cue] of script.cues.entries()) {
    const cuePath = join(workDir, `${problemId}-${locale}-${index}.wav`);
    if (locale === "en") {
      englishVoice = synthesizeEnglishCue(normalizeEnglishForSpeech(cue.en), cuePath);
    } else {
      await synthesizeVoicevoxCue(engineUrl, normalizeJapaneseForSpeech(cue.ja), cuePath);
    }
    cuePaths.push(cuePath);
    const displayIndex = cue.layout ? index : operationIndex++;
    const displayTotal = cue.layout ? script.cues.length : operationTotal;
    overlayPaths.push(
      renderCaptionOverlay(
        chromium,
        cue,
        locale,
        problemId,
        index,
        displayIndex,
        displayTotal,
        workDir,
      ),
    );
  }
  muxVoiceover(
    baseVideoPath,
    cuePaths,
    overlayPaths,
    timeline.starts,
    timeline.videoDurationS,
    outputPath,
    locale === "ja" ? "VOICEVOX:ずんだもん" : `macOS Samantha English narration (${englishVoice})`,
  );
  writeFileSync(
    localizedCaptionPath(baseVideoPath, locale),
    buildWebVtt(script.cues, locale, timeline.starts, timeline.videoDurationS),
  );
  console.log(
    `wrote ${outputPath} (${locale}, ${locale === "ja" ? "VOICEVOX:ずんだもん" : `macOS ${englishVoice}`})`,
  );
}

async function main(): Promise<void> {
  const engineUrl = assertLocalVoicevoxUrl(process.env.VOICEVOX_URL ?? "http://127.0.0.1:50021");
  const outputDir = join(import.meta.dir, "../../../landing/videos/onboarding");
  mkdirSync(outputDir, { recursive: true });
  const workDir = createTemporaryVideoDirectory("tenkacloud-zundamon-");
  const chromium = resolveBin("CHROMIUM_BIN", [
    "chromium",
    "/opt/pw-browsers/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]);

  try {
    for (const problemId of Object.keys(SCRIPT_BY_PROBLEM_ID) as RecordedLiteEdit["problemId"][]) {
      const canonicalVideoPath = join(outputDir, `${problemId}.mp4`);
      assertUnvoicedRecordedBase(formatComment(canonicalVideoPath), canonicalVideoPath);
      const baseVideoPath = join(workDir, `${problemId}-source.mp4`);
      copyFileSync(canonicalVideoPath, baseVideoPath);
      const script = SCRIPT_BY_PROBLEM_ID[problemId];
      const japaneseTempPath = localeWorkVideoPath(workDir, problemId, "ja");
      const englishTempPath = localeWorkVideoPath(workDir, problemId, "en");
      await renderLocale(
        problemId,
        script,
        "ja",
        baseVideoPath,
        japaneseTempPath,
        engineUrl,
        chromium,
        workDir,
      );
      await renderLocale(
        problemId,
        script,
        "en",
        baseVideoPath,
        englishTempPath,
        engineUrl,
        chromium,
        workDir,
      );
      renameSync(japaneseTempPath, canonicalVideoPath);
      renameSync(englishTempPath, localizedVideoPath(canonicalVideoPath, "en"));
      for (const locale of ["ja", "en"] as const) {
        renameSync(
          localizedCaptionPath(baseVideoPath, locale),
          localizedCaptionPath(canonicalVideoPath, locale),
        );
      }
    }
  } finally {
    cleanupTemporaryVideoDirectory(workDir);
  }
}

if (import.meta.main) await main();
