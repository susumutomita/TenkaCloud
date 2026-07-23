/**
 * Render one shared 9:16 TenkaCloud Lite short for X, Instagram Reels, and YouTube Shorts.
 *
 * The input should already contain the localized narration and background music.
 *
 * Usage:
 *   bun run scripts/landing/onboarding-videos/render-social-short.ts \
 *     ja /absolute/path/to/input.mp4 /absolute/path/to/output.mp4
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanupTemporaryVideoDirectory,
  createTemporaryVideoDirectory,
  escapeHtml,
  resolveBin,
  run as runCommand,
} from "./render";
import type { VoiceoverLocale } from "./voiceover-data";

export interface SocialShortSegment {
  readonly chapter: string;
  readonly startS: number;
  readonly endS: number;
}

export interface SocialShortPhase {
  readonly startSegment: number;
  readonly endSegment: number;
  readonly label: Readonly<Record<VoiceoverLocale, string>>;
}

const TRANSITION_S = 0.25;

export const DEPLOY_SOCIAL_SHORT_SEGMENTS: readonly SocialShortSegment[] = [
  { chapter: "intro", startS: 0.2, endS: 3.7 },
  { chapter: "services", startS: 8.9, endS: 12.4 },
  { chapter: "cloudformation", startS: 13.7, endS: 16.5 },
  { chapter: "codebuild", startS: 20, endS: 22.8 },
  { chapter: "competitor", startS: 35.3, endS: 37.8 },
  { chapter: "event-reason", startS: 45.4, endS: 47.9 },
  { chapter: "event-create", startS: 50.1, endS: 53.1 },
  { chapter: "event-deploy", startS: 57.6, endS: 60.4 },
  { chapter: "participant", startS: 62.3, endS: 64.8 },
  { chapter: "play", startS: 71.4, endS: 73.9 },
  { chapter: "score", startS: 76.3, endS: 79.3 },
] as const;

export const SOCIAL_SHORT_PHASES: readonly SocialShortPhase[] = [
  {
    startSegment: 0,
    endSegment: 0,
    label: { ja: "自分のAWSへLiteをデプロイ", en: "Deploy Lite to your AWS" },
  },
  {
    startSegment: 1,
    endSegment: 2,
    label: { ja: "CloudFormationで入口を作る", en: "Start with CloudFormation" },
  },
  {
    startSegment: 3,
    endSegment: 3,
    label: { ja: "CodeBuildがCDK deploy", en: "CodeBuild runs CDK deploy" },
  },
  {
    startSegment: 4,
    endSegment: 5,
    label: { ja: "競技用AWSを登録", en: "Register competitor AWS" },
  },
  {
    startSegment: 6,
    endSegment: 8,
    label: { ja: "イベントを作成・Deploy", en: "Create and deploy an event" },
  },
  {
    startSegment: 9,
    endSegment: 9,
    label: { ja: "問題をプレイ", en: "Play the problem" },
  },
  {
    startSegment: 10,
    endSegment: 10,
    label: { ja: "スコア反映まで確認", en: "Confirm the score" },
  },
] as const;

function segmentDurationS(segment: SocialShortSegment): number {
  return segment.endS - segment.startS;
}

export function socialShortDurationS(segments: readonly SocialShortSegment[]): number {
  return (
    segments.reduce((sum, segment) => sum + segmentDurationS(segment), 0) -
    Math.max(0, segments.length - 1) * TRANSITION_S
  );
}

function segmentStartS(segments: readonly SocialShortSegment[], index: number): number {
  return (
    segments.slice(0, index).reduce((sum, segment) => sum + segmentDurationS(segment), 0) -
    index * TRANSITION_S
  );
}

function segmentEndS(segments: readonly SocialShortSegment[], index: number): number {
  const segment = segments[index];
  if (!segment) throw new Error(`Social short segment ${index} does not exist`);
  return segmentStartS(segments, index) + segmentDurationS(segment);
}

export function buildSocialShortOverlayHtml(locale: VoiceoverLocale, phaseIndex: number): string {
  const phase = SOCIAL_SHORT_PHASES[phaseIndex];
  if (!phase) throw new Error(`Social short phase ${phaseIndex} does not exist`);
  const eyebrow = locale === "ja" ? "AWS実機チュートリアル" : "REAL AWS TUTORIAL";
  const callToAction =
    locale === "ja" ? "フル動画はYouTubeへ" : "Watch the full tutorial on YouTube";
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body {
    width: 1080px; height: 1920px; margin: 0; overflow: hidden; background: transparent;
  }
  body {
    position: relative;
    font-family: "Inter", "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", sans-serif;
    color: #ffffff;
  }
  .panel {
    position: absolute; left: 0; width: 1080px;
    background: rgba(6, 20, 38, 0.94);
  }
  .top {
    top: 0; height: 520px; padding: 102px 76px 64px;
    display: flex; flex-direction: column; align-items: center; text-align: center;
  }
  .brand {
    color: #7fddc3; font-size: 66px; font-weight: 900; letter-spacing: 0.035em;
  }
  .eyebrow {
    margin-top: 28px; font-size: 48px; font-weight: 760; letter-spacing: 0.05em;
  }
  .rule {
    width: 164px; height: 7px; margin-top: 40px; border-radius: 999px; background: #0969da;
  }
  .bottom {
    top: 1260px; height: 660px; padding: 108px 66px 72px;
    display: flex; flex-direction: column; align-items: center; text-align: center;
  }
  .phase {
    min-height: 170px; display: flex; align-items: center; justify-content: center;
    font-size: 58px; font-weight: 850; line-height: 1.28; letter-spacing: -0.025em;
    text-wrap: balance;
  }
  .cta {
    margin-top: 38px; color: #7fddc3; font-size: 40px; font-weight: 800;
  }
  .tags {
    margin-top: auto; color: #b9cce0; font-size: 30px; font-weight: 650; letter-spacing: 0.015em;
  }
</style></head>
<body>
  <section class="panel top">
    <div class="brand">TENKACLOUD LITE</div>
    <div class="eyebrow">${escapeHtml(eyebrow)}</div>
    <div class="rule"></div>
  </section>
  <section class="panel bottom">
    <div class="phase">${escapeHtml(phase.label[locale])}</div>
    <div class="cta">${escapeHtml(callToAction)}</div>
    <div class="tags">#TenkaCloud&nbsp;&nbsp;#AWS&nbsp;&nbsp;#CloudFormation</div>
  </section>
</body></html>`;
}

export function buildSocialShortFilterGraph(): string {
  const segments = DEPLOY_SOCIAL_SHORT_SEGMENTS;
  const videoSplits = segments.map((_, index) => `[v${index}s]`).join("");
  const audioSplits = segments.map((_, index) => `[a${index}s]`).join("");
  const filters: string[] = [
    `[0:v]split=${segments.length}${videoSplits}`,
    `[0:a]asplit=${segments.length}${audioSplits}`,
  ];

  for (const [index, segment] of segments.entries()) {
    filters.push(
      `[v${index}s]trim=start=${segment.startS}:end=${segment.endS},setpts=PTS-STARTPTS[v${index}]`,
      `[a${index}s]atrim=start=${segment.startS}:end=${segment.endS},asetpts=PTS-STARTPTS[a${index}]`,
    );
  }

  let videoInput = "v0";
  let audioInput = "a0";
  let cumulativeS = segmentDurationS(segments[0]);
  for (let index = 1; index < segments.length; index++) {
    const videoOutput = index === segments.length - 1 ? "vx" : `vx${index}`;
    const audioOutput = index === segments.length - 1 ? "ax" : `ax${index}`;
    const offsetS = cumulativeS - index * TRANSITION_S;
    filters.push(
      `[${videoInput}][v${index}]xfade=transition=fade:duration=${TRANSITION_S}:offset=${offsetS.toFixed(2)}[${videoOutput}]`,
      `[${audioInput}][a${index}]acrossfade=d=${TRANSITION_S}:c1=tri:c2=tri[${audioOutput}]`,
    );
    cumulativeS += segmentDurationS(segments[index]);
    videoInput = videoOutput;
    audioInput = audioOutput;
  }

  filters.push(
    `[${videoInput}]split=2[bgsource][fgsource]`,
    "[bgsource]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=42,eq=brightness=-0.48:saturation=0.55[background]",
    "[fgsource]scale=1080:-2[foreground]",
    "[background][foreground]overlay=(W-w)/2:(H-h)/2[canvas]",
  );

  let overlayInput = "canvas";
  for (const [phaseIndex, phase] of SOCIAL_SHORT_PHASES.entries()) {
    const startS = segmentStartS(segments, phase.startSegment);
    const endS = segmentEndS(segments, phase.endSegment);
    const overlayOutput = `overlay${phaseIndex}`;
    filters.push(
      `[${overlayInput}][${phaseIndex + 1}:v]overlay=0:0:eof_action=repeat:format=auto:enable='between(t,${startS.toFixed(2)},${endS.toFixed(2)})'[${overlayOutput}]`,
    );
    overlayInput = overlayOutput;
  }

  filters.push(`[${overlayInput}]setsar=1,format=yuv420p[vout]`);
  filters.push(
    `[${audioInput}]apad,atrim=duration=${socialShortDurationS(segments).toFixed(3)}[aout]`,
  );
  return filters.join(";");
}

export function renderSocialShort(
  locale: VoiceoverLocale,
  inputPath: string,
  outputPath: string,
): void {
  const ffmpeg = resolveBin("FFMPEG_BIN", ["ffmpeg"]);
  const chromium = resolveBin("CHROMIUM_BIN", [
    "chromium",
    "/opt/pw-browsers/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]);
  const workDir = createTemporaryVideoDirectory("tenkacloud-social-short-");
  mkdirSync(dirname(outputPath), { recursive: true });
  try {
    const overlayPaths = SOCIAL_SHORT_PHASES.map((_, phaseIndex) => {
      const htmlPath = join(workDir, `overlay-${locale}-${phaseIndex}.html`);
      const pngPath = join(workDir, `overlay-${locale}-${phaseIndex}.png`);
      writeFileSync(htmlPath, buildSocialShortOverlayHtml(locale, phaseIndex));
      runCommand(chromium, [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--window-size=1080,1920",
        "--default-background-color=00000000",
        `--screenshot=${pngPath}`,
        `file://${htmlPath}`,
      ]);
      return pngPath;
    });
    const duration = socialShortDurationS(DEPLOY_SOCIAL_SHORT_SEGMENTS).toFixed(3);
    runCommand(ffmpeg, [
      "-y",
      "-hide_banner",
      "-i",
      inputPath,
      ...overlayPaths.flatMap((path) => ["-loop", "1", "-framerate", "30000/1001", "-i", path]),
      "-filter_complex",
      buildSocialShortFilterGraph(),
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-t",
      duration,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-r",
      "30000/1001",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      "-metadata",
      `title=${locale === "ja" ? "TenkaCloud Lite AWSショート" : "TenkaCloud Lite AWS Short"}`,
      outputPath,
    ]);
  } finally {
    cleanupTemporaryVideoDirectory(workDir);
  }
}

if (import.meta.main) {
  const [locale, inputPath, outputPath] = process.argv.slice(2);
  if ((locale !== "ja" && locale !== "en") || !inputPath || !outputPath) {
    throw new Error("Usage: render-social-short.ts <ja|en> <input.mp4> <output.mp4>");
  }
  renderSocialShort(locale, inputPath, outputPath);
}
