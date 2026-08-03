/**
 * #2707 P1 / #2711: LP 用 30 秒動画を生成する CLI。
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
 * オンボーディング動画は YouTube 配信のため、この CLI はリポジトリへ出力しない。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { LP_VIDEO, type OnboardingSlide, type OnboardingVideo } from "./script-data";

export const FADE_S = 0.5;
export const FPS = 30;

/**
 * 出力レイアウト。 landscape = 1280x720 (README / LP / 問題冒頭)、
 * portrait = 720x1280 (SNS 縦型、 #2696 P1 の 9:16 variant)。
 */
export type SlideLayout = "landscape" | "portrait";

export const LAYOUTS: Record<SlideLayout, { w: number; h: number; windowH: number; css: string }> =
  {
    landscape: { w: 1280, h: 720, windowH: 800, css: "" },
    portrait: {
      w: 720,
      h: 1280,
      windowH: 1360,
      // 縦型は幅が細いので余白と型を詰め、 video タイトル行 (.vtitle) は落とす。
      css: `
  html, body { width: 720px; height: 1280px; }
  .frame { padding: 44px 40px 40px; }
  .vtitle { display: none; }
  main { max-width: 100%; gap: 22px; }
  h1 { font-size: 44px; }
  .subtitle { font-size: 20px; }
  li .ja { font-size: 24px; }
  li .en { font-size: 15px; }
  .code { font-size: 22px; padding: 12px 20px; }
`,
    },
  };

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
  layout: SlideLayout = "landscape",
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
${LAYOUTS[layout].css}</style></head>
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
export function buildFilterGraph(
  durations: readonly number[],
  layout: SlideLayout = "landscape",
): string {
  // screenshot は高さ余白付きの窓 (2 倍解像度)。 高さちょうどの窓だと chromium headless が
  // 最下段 (footer) を描画しないことがあるため、 余白付きで撮って crop する。
  const { w, h } = LAYOUTS[layout];
  const pre = durations
    .map(
      (_, i) =>
        `[${i}:v]crop=${w * 2}:${h * 2}:0:0,` +
        `zoompan=z='min(zoom+0.0003,1.06)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${FPS},setsar=1[v${i}]`,
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

export function resolveBin(envName: string, candidates: readonly string[]): string {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  for (const c of candidates) {
    if (c.includes("/")) {
      if (existsSync(c)) return c;
      // Resolving a bare binary name through PATH is exactly what this branch is for:
      // `candidates` carries bare names so a developer's own ffmpeg / chromium install is
      // found. Absolute candidates take the branch above, and the env override outranks both.
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- developer-local toolchain
    } else if (spawnSync("which", [c]).status === 0) {
      return c;
    }
  }
  throw new Error(`${envName} not set and none of [${candidates.join(", ")}] found`);
}

export function run(bin: string, args: string[]): void {
  const res = spawnSync(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (res.status !== 0) {
    throw new Error(
      `${bin} ${args.slice(0, 4).join(" ")}… failed (exit ${res.status}):\n${res.stderr?.toString().slice(-2000)}`,
    );
  }
}

export function createTemporaryVideoDirectory(prefix: string): string {
  if (!/^tenka(?:cloud)?-[a-z0-9-]+-$/i.test(prefix)) {
    throw new Error(`Invalid video temp prefix: ${prefix}`);
  }
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTemporaryVideoDirectory(workDir: string): void {
  const resolvedWorkDir = resolve(workDir);
  if (
    dirname(resolvedWorkDir) !== resolve(tmpdir()) ||
    !/^tenka(?:cloud)?-[a-z0-9-]+-[a-z0-9]{6}$/i.test(basename(resolvedWorkDir))
  ) {
    throw new Error(`Refusing to remove non-video temp directory: ${workDir}`);
  }
  rmSync(resolvedWorkDir, { recursive: true, force: true });
}

function renderVideo(
  video: OnboardingVideo,
  chromium: string,
  ffmpeg: string,
  outPath: string,
  layout: SlideLayout = "landscape",
) {
  const work = createTemporaryVideoDirectory(`tenka-video-${video.problemId}-${layout}-`);
  try {
    const { w, windowH } = LAYOUTS[layout];
    const total = video.slides.length;
    const pngs: string[] = [];
    video.slides.forEach((slide, i) => {
      const htmlPath = join(work, `slide-${i}.html`);
      const pngPath = join(work, `slide-${i}.png`);
      writeFileSync(htmlPath, buildSlideHtml(video, slide, i, total, layout));
      run(chromium, [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=2",
        // 高さちょうどの窓は最下段を落とすことがある (footer 消失) ので余白を持たせ、
        // ffmpeg 側で出力サイズの 2 倍に crop する。
        `--window-size=${w},${windowH}`,
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
    run(ffmpeg, [
      "-y",
      ...inputs,
      "-filter_complex",
      buildFilterGraph(durations, layout),
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
  } finally {
    cleanupTemporaryVideoDirectory(work);
  }
}

function main() {
  const chromium = resolveBin("CHROMIUM_BIN", ["chromium", "/opt/pw-browsers/chromium"]);
  const ffmpeg = resolveBin("FFMPEG_BIN", ["ffmpeg"]);
  const root = join(import.meta.dir, "../../..");

  // #2696 P1: 30 秒 LP 動画 (16:9 + 9:16) と README 用 preview GIF / poster。
  const lpDir = join(root, "landing/videos/lp");
  const lpAssetsDir = join(root, "docs/assets/lp-30s");
  mkdirSync(lpDir, { recursive: true });
  mkdirSync(lpAssetsDir, { recursive: true });
  const lp169 = join(lpDir, "tenkacloud-30s.mp4");
  renderVideo(LP_VIDEO, chromium, ffmpeg, lp169, "landscape");
  renderVideo(LP_VIDEO, chromium, ffmpeg, join(lpDir, "tenkacloud-30s-vertical.mp4"), "portrait");
  // preview GIF: 全編を 1 fps でサンプルし 4 倍速再生 (= 約 7 秒ループの早回し)。
  run(ffmpeg, [
    "-y",
    "-i",
    lp169,
    "-vf",
    "fps=1,setpts=PTS*0.25,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer",
    "-loop",
    "0",
    join(lpAssetsDir, "tenkacloud-30s-preview.gif"),
  ]);
  run(ffmpeg, [
    "-y",
    "-ss",
    "1.0",
    "-i",
    lp169,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    join(lpAssetsDir, "tenkacloud-30s-poster.jpg"),
  ]);
  console.log(`wrote ${lpAssetsDir}/tenkacloud-30s-preview.gif and -poster.jpg`);
}

if (import.meta.main) main();
