/**
 * #2707 P1 / #2711: オンボーディングドリル 3 本の 1 分 operation 動画を生成する CLI。
 *
 * 使い方:
 *   bun run scripts/landing/onboarding-videos/render.ts
 *
 * 必要なもの (生成する開発機だけ。 CI / 配信環境には不要):
 *   - chromium (headless screenshot に使用。 `CHROMIUM_BIN` で明示指定可、 既定は
 *     PATH の chromium → Playwright 配布の /opt/pw-browsers/chromium の順に探す)
 *   - ffmpeg (`FFMPEG_BIN` で明示指定可)
 *   - 日本語フォント (Noto Sans CJK 系)。 無い環境では日本語が豆腐になる
 *
 * 仕組み: script-data.ts の台本からスライド HTML を組み立て → chromium headless で
 * 2 倍解像度 (2560x1440) の PNG に撮影 → ffmpeg の zoompan (ゆっくり寄る) + xfade
 * (crossfade) で 1280x720 / 30fps / H.264 の mp4 に組む。 音声なし (字幕焼き込み)。
 * 出力先: landing/videos/onboarding/<problemId>.mp4
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONBOARDING_VIDEOS, type OnboardingSlide, type OnboardingVideo } from "./script-data";

export const FADE_S = 0.5;
export const FPS = 30;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 台本上の合計秒数 (crossfade の重なりを引く前)。 */
export function videoNominalDurationS(video: OnboardingVideo): number {
  return video.slides.reduce((sum, s) => sum + s.durationS, 0);
}

const BADGE_TONE: Record<string, string> = {
  INTRO: "#0969da",
  NOTE: "#5d6877",
  GOAL: "#008a55",
};

function badgeColor(badge: string): string {
  return BADGE_TONE[badge] ?? "#07111f";
}

function bulletRows(slide: OnboardingSlide): string {
  const ja = slide.bulletsJa ?? [];
  const en = slide.bulletsEn ?? [];
  return ja
    .map(
      (line, i) => `
      <li>
        <span class="ja">${escapeHtml(line)}</span>
        <span class="en">${escapeHtml(en[i] ?? "")}</span>
      </li>`,
    )
    .join("");
}

function codeChip(slide: OnboardingSlide): string {
  if (!slide.code) return "";
  const color = slide.code.tone === "goal" ? "#008a55" : "#0969da";
  return `<div class="code" style="color:${color};border-color:${color}33">${escapeHtml(slide.code.text)}</div>`;
}

/**
 * 1 スライド分の self-contained HTML。 landing のブランドトークン
 * (--ink / --paper / --blue / --green, Inter + Noto Sans JP) を踏襲する。
 */
export function buildSlideHtml(
  video: OnboardingVideo,
  slide: OnboardingSlide,
  index: number,
  total: number,
): string {
  const segments = Array.from(
    { length: total },
    (_, i) => `<span class="seg${i <= index ? " on" : ""}"></span>`,
  ).join("");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 720px; overflow: hidden; }
  body {
    font-family: "Inter", "Noto Sans CJK JP", "Noto Sans JP", sans-serif;
    color: #07111f; background: #ffffff; position: relative;
  }
  body::before {
    content: ""; position: absolute; inset: 0;
    background:
      radial-gradient(900px 420px at 88% -10%, #0969da12, transparent 60%),
      radial-gradient(700px 380px at -6% 110%, #008a5510, transparent 55%);
  }
  .frame { position: relative; height: 100%; display: flex; flex-direction: column; padding: 56px 72px 48px; }
  header { display: flex; align-items: center; gap: 18px; }
  .brand { font-weight: 900; font-size: 22px; letter-spacing: -0.03em; }
  .brand em { font-style: normal; color: #0969da; }
  .vtitle { font-size: 16px; color: #5d6877; border-left: 1px solid #d9dee8; padding-left: 18px; }
  .badge {
    margin-left: auto; font-size: 15px; font-weight: 800; letter-spacing: 0.08em;
    color: #ffffff; background: ${badgeColor(slide.badge)}; border-radius: 999px; padding: 7px 18px;
  }
  main { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 26px; max-width: 1010px; }
  h1 { font-size: 58px; font-weight: 800; letter-spacing: -0.04em; line-height: 1.16; }
  .subtitle { font-size: 25px; color: #5d6877; letter-spacing: -0.01em; }
  ul { list-style: none; display: flex; flex-direction: column; gap: 17px; margin-top: 6px; }
  li { display: flex; flex-direction: column; gap: 3px; padding-left: 26px; position: relative; }
  li::before { content: ""; position: absolute; left: 0; top: 15px; width: 11px; height: 11px; border-radius: 3px; background: #0969da; }
  li .ja { font-size: 29px; font-weight: 600; color: #263241; }
  li .en { font-size: 18px; color: #8a94a3; }
  .code {
    align-self: flex-start; font-family: "JetBrains Mono", monospace; font-size: 30px; font-weight: 700;
    background: #f5f7fb; border: 2px solid; border-radius: 10px; padding: 14px 26px; margin-top: 4px;
  }
  footer { display: flex; align-items: center; gap: 18px; }
  .progress { display: flex; gap: 8px; flex: 1; }
  .seg { height: 6px; flex: 1; border-radius: 3px; background: #edf0f5; }
  .seg.on { background: #0969da; }
  .counter { font-size: 15px; color: #8a94a3; font-variant-numeric: tabular-nums; }
</style></head>
<body>
  <div class="frame">
    <header>
      <span class="brand">Tenka<em>Cloud</em></span>
      <span class="vtitle">${escapeHtml(video.titleJa)} / ${escapeHtml(video.titleEn)}</span>
      <span class="badge">${escapeHtml(slide.badge)}</span>
    </header>
    <main>
      <div>
        <h1>${escapeHtml(slide.titleJa)}</h1>
        <p class="subtitle">${escapeHtml(slide.titleEn)}</p>
      </div>
      ${bulletRows(slide) ? `<ul>${bulletRows(slide)}</ul>` : ""}
      ${codeChip(slide)}
    </main>
    <footer>
      <div class="progress">${segments}</div>
      <span class="counter">${index + 1} / ${total}</span>
    </footer>
  </div>
</body></html>`;
}

/**
 * ffmpeg の filter graph。 各スライド入力へ zoompan (毎フレーム +0.0003、 上限 1.06 の
 * ゆっくり寄り) をかけ、 隣接スライドを `FADE_S` 秒の xfade で繋ぐ。
 * offset_k = (先頭から k 枚分の合計秒数) - k * FADE_S。
 */
export function buildFilterGraph(durations: readonly number[]): string {
  // screenshot は 1280x800 窓 (2 倍解像度で 2560x1600)。 720 ちょうどの窓だと chromium
  // headless が最下段 (footer) を描画しないことがあるため、 余白付きで撮って crop する。
  const pre = durations
    .map(
      (_, i) =>
        `[${i}:v]crop=2560:1440:0:0,` +
        `zoompan=z='min(zoom+0.0003,1.06)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x720:fps=${FPS},setsar=1[v${i}]`,
    )
    .join(";");
  if (durations.length === 1) return `${pre};[v0]format=yuv420p[vout]`;
  let chain = "";
  let acc = durations[0];
  let prev = "v0";
  for (let i = 1; i < durations.length; i++) {
    const out = i === durations.length - 1 ? "vx" : `x${i}`;
    chain += `;[${prev}][v${i}]xfade=transition=fade:duration=${FADE_S}:offset=${(acc - i * FADE_S).toFixed(2)}[${out}]`;
    acc += durations[i];
    prev = out;
  }
  return `${pre}${chain};[vx]format=yuv420p[vout]`;
}

function resolveBin(envName: string, candidates: readonly string[]): string {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  for (const c of candidates) {
    if (c.includes("/")) {
      if (existsSync(c)) return c;
    } else if (spawnSync("which", [c]).status === 0) {
      return c;
    }
  }
  throw new Error(`${envName} not set and none of [${candidates.join(", ")}] found`);
}

function run(bin: string, args: string[]): void {
  const res = spawnSync(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (res.status !== 0) {
    throw new Error(
      `${bin} ${args.slice(0, 4).join(" ")}… failed (exit ${res.status}):\n${res.stderr?.toString().slice(-2000)}`,
    );
  }
}

function renderVideo(video: OnboardingVideo, chromium: string, ffmpeg: string, outDir: string) {
  const work = mkdtempSync(join(tmpdir(), `tenka-video-${video.problemId}-`));
  const total = video.slides.length;
  const pngs: string[] = [];
  video.slides.forEach((slide, i) => {
    const htmlPath = join(work, `slide-${i}.html`);
    const pngPath = join(work, `slide-${i}.png`);
    writeFileSync(htmlPath, buildSlideHtml(video, slide, i, total));
    run(chromium, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      // 720 ちょうどの窓は最下段を落とすことがある (footer 消失) ので余白を持たせ、
      // ffmpeg 側で 2560x1440 (= 1280x720 の 2 倍) に crop する。
      "--window-size=1280,800",
      "--default-background-color=FFFFFFFF",
      "--virtual-time-budget=3000",
      `--screenshot=${pngPath}`,
      `file://${htmlPath}`,
    ]);
    pngs.push(pngPath);
  });

  const durations = video.slides.map((s) => s.durationS);
  const inputs = pngs.flatMap((png, i) => [
    "-loop",
    "1",
    "-framerate",
    String(FPS),
    "-t",
    String(durations[i]),
    "-i",
    png,
  ]);
  const outPath = join(outDir, `${video.problemId}.mp4`);
  run(ffmpeg, [
    "-y",
    ...inputs,
    "-filter_complex",
    buildFilterGraph(durations),
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "23",
    "-r",
    String(FPS),
    "-movflags",
    "+faststart",
    "-an",
    outPath,
  ]);
  console.log(`wrote ${outPath}`);
}

function main() {
  const chromium = resolveBin("CHROMIUM_BIN", ["chromium", "/opt/pw-browsers/chromium"]);
  const ffmpeg = resolveBin("FFMPEG_BIN", ["ffmpeg"]);
  const outDir = join(import.meta.dir, "../../../landing/videos/onboarding");
  mkdirSync(outDir, { recursive: true });
  for (const video of ONBOARDING_VIDEOS) {
    renderVideo(video, chromium, ffmpeg, outDir);
  }
}

if (import.meta.main) main();
