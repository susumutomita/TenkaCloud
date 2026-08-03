import { escapeHtml } from "./render";
import type { RecordedLiteEdit } from "./render-recorded-lite";
import type { VoiceoverCue, VoiceoverLocale } from "./voiceover-data";

function headingFontSizeFor(cleanup: boolean, japanese: boolean): number {
  if (cleanup && japanese) return 48;
  return japanese ? 58 : 54;
}

function cleanupFooter(japanese: boolean): string {
  return japanese ? "Lite本体を先に削除 · launcherは最後" : "Delete Lite first · launcher last";
}

function buildIntroOverlayHtml(cue: VoiceoverCue, locale: VoiceoverLocale): string {
  const details = cue.details?.[locale] ?? [];
  const columns = Math.max(1, Math.min(4, details.length));
  const note = cue.note ? `<div class="stack-note">${escapeHtml(cue.note[locale])}</div>` : "";
  const japanese = locale === "ja";
  const cleanup = cue.theme === "cleanup";
  const headingFontSize = headingFontSizeFor(cleanup, japanese);
  const headingMaxWidth = cleanup && japanese ? 1100 : 930;
  const footer = cleanup ? cleanupFooter(japanese) : "Single tenant · One organizer · One event";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #071426; }
body { box-sizing: border-box; padding: 74px 90px; font-family: Inter, "Noto Sans JP", "Hiragino Sans", sans-serif;
  color: #f8fbff; background: radial-gradient(circle at 82% 18%, #123d70 0, #071426 43%); }
.eyebrow { display: inline-block; padding: 9px 15px; border: 1px solid #68a9ff; border-radius: 999px;
  color: #9bc7ff; font-size: 18px; font-weight: 800; letter-spacing: .12em; }
h1 { margin: 30px 0 14px; max-width: ${headingMaxWidth}px; font-size: ${headingFontSize}px; line-height: 1.15; }
.lead { max-width: 1010px; color: #dceaff; font-size: ${locale === "ja" ? 29 : 27}px;
  line-height: 1.45; font-weight: 650; }
.facts { display: grid; grid-template-columns: repeat(${columns}, 1fr); gap: 12px; margin-top: 36px; }
.fact { position: relative; padding: 20px 18px; border-radius: 16px; background: rgba(20, 58, 99, .76);
  border: 1px solid rgba(155, 199, 255, .46); font-size: ${locale === "ja" ? 20 : 18}px;
  line-height: 1.35; font-weight: 700; }
.fact:not(:last-child)::after { content: "→"; position: absolute; right: -14px; top: 26px;
  z-index: 2; color: #9bc7ff; font-size: 24px; }
.stack-note { margin-top: 22px; color: #9bc7ff; font-size: 17px; font-weight: 700; }
.foot { position: absolute; right: 90px; bottom: 30px; color: #8dacd0; font-size: 16px; }
</style></head><body>
<div class="eyebrow">TENKACLOUD LITE · AWS ${cue.theme === "cleanup" ? "CLEANUP" : "DEPLOYMENT"}</div>
<h1>${escapeHtml(cue.heading[locale])}</h1>
<div class="lead">${escapeHtml(cue[locale])}</div>
<div class="facts">${details.map((detail) => `<div class="fact">${escapeHtml(detail)}</div>`).join("")}</div>
${note}
<div class="foot">${footer}</div>
</body></html>`;
}

function buildExplainerOverlayHtml(cue: VoiceoverCue, locale: VoiceoverLocale): string {
  const details = cue.details?.[locale] ?? [];
  const columns = Math.max(1, Math.min(4, details.length));
  const note = cue.note ? `<div class="why">${escapeHtml(cue.note[locale])}</div>` : "";
  const eyebrow = (() => {
    if (cue.layout === "complete") return "CLEANUP COMPLETE · VERIFY IN AWS";
    if (cue.layout === "start") return "START HERE · THEN THE REAL AWS CONSOLE";
    if (cue.theme === "cleanup") return "WHY THIS ORDER · THEN THE REAL AWS CONSOLE";
    return "WHY THIS STEP · THEN THE REAL AWS CONSOLE";
  })();
  const next = cue.layout === "complete" ? "Cleanup complete" : "Next: actual screen operation";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #0b2037; }
body { box-sizing: border-box; padding: 70px 90px; font-family: Inter, "Noto Sans JP", "Hiragino Sans", sans-serif;
  color: #f8fbff; background: radial-gradient(circle at 15% 80%, #174c67 0, #0b2037 42%); }
.eyebrow { color: #7fddc3; font-size: 19px; font-weight: 850; letter-spacing: .12em; }
h1 { margin: 20px 0 12px; font-size: ${locale === "ja" ? 52 : 48}px; line-height: 1.15; }
.reason { max-width: 1040px; color: #dceaff; font-size: ${locale === "ja" ? 28 : 26}px;
  line-height: 1.45; font-weight: 650; }
.flow { display: grid; grid-template-columns: repeat(${columns}, 1fr); gap: 24px; margin-top: 42px; }
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
<div class="next">${next}</div>
</body></html>`;
}

function buildOperationOverlayHtml(
  cue: VoiceoverCue,
  locale: VoiceoverLocale,
  index: number,
  total: number,
): string {
  const note = cue.note?.[locale];
  const captionPlacement = cue.captionPlacement ?? "bottom";
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
.caption.top-right { top: 18px; left: auto; right: 18px; bottom: auto; max-width: 720px;
  padding: 12px 18px; font-size: ${locale === "ja" ? 25 : 23}px; }
.note { position: absolute; top: 78px; left: 18px; max-width: 820px; padding: 8px 14px; border-radius: 10px;
  background: rgba(7, 17, 31, .88); border: 1px solid rgba(104, 169, 255, .62);
  color: #dceaff; font-size: ${locale === "ja" ? 17 : 16}px; font-weight: 700; }
</style></head><body>
<div class="step">STEP ${index + 1} / ${total} · ${escapeHtml(cue.heading[locale])}</div>
${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}
<div class="caption ${captionPlacement}">${escapeHtml(cue[locale])}</div>
</body></html>`;
}

export function buildCaptionOverlayHtml(
  cue: VoiceoverCue,
  locale: VoiceoverLocale,
  index: number,
  total: number,
): string {
  if (cue.layout === "intro") return buildIntroOverlayHtml(cue, locale);
  if (cue.layout === "start" || cue.layout === "explainer" || cue.layout === "complete") {
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

export function captionOverlayBasename(
  problemId: RecordedLiteEdit["problemId"],
  locale: VoiceoverLocale,
  cueIndex: number,
): string {
  return `${problemId}-caption-${locale}-${cueIndex}`;
}
