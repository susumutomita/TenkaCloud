import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import { useEffect, useState } from "react";
import { useT } from "../i18n";

/**
 * Issue #1349: 残時間 (= 終了予定 ISO 8601 - now) を `HH:MM:SS` 文字列で返す純関数。
 *
 * - 終了予定 `endsAt` が未指定なら `null` (= caller 側で表示せず render skip)。
 * - 終了済 (= now > endsAt) は `{ kind: "ended" }`。
 * - 残 5 分以内は `{ kind: "warning" }` で UI 側 alert を出す。
 * - それ以外は `{ kind: "running" }`。
 *
 * 設計判断: render 専用 component (`CountdownTimer`) と分離して、pure function 単独で
 * unit test できる形にする (= 時刻依存 logic を React component に閉じ込めない)。
 */
export type CountdownState =
  | { readonly kind: "no-event" }
  | { readonly kind: "ended"; readonly display: string }
  | { readonly kind: "warning"; readonly display: string; readonly remainingSec: number }
  | { readonly kind: "running"; readonly display: string; readonly remainingSec: number };

const WARNING_THRESHOLD_SEC = 5 * 60;

function formatHms(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function computeCountdownState(
  endsAtIso: string | undefined,
  nowMs: number,
): CountdownState {
  if (!endsAtIso) return { kind: "no-event" };
  const endsMs = Date.parse(endsAtIso);
  if (!Number.isFinite(endsMs)) return { kind: "no-event" };
  const remainingMs = endsMs - nowMs;
  if (remainingMs <= 0) return { kind: "ended", display: "00:00:00" };
  const remainingSec = Math.floor(remainingMs / 1000);
  const display = formatHms(remainingSec);
  if (remainingSec <= WARNING_THRESHOLD_SEC) {
    return { kind: "warning", display, remainingSec };
  }
  return { kind: "running", display, remainingSec };
}

/**
 * 残時間表示用 React component。1 秒 tick で再描画する (= 60 秒 polling とは独立、
 * client-side のみで動く時計)。`endsAt` が無い (= legacy deployment) は null を return。
 *
 * 残 5 分以内は赤系 badge + 「ラスト 5 分」 ラベルで visual alert。
 */
export function CountdownTimer({ endsAt }: { endsAt?: string }) {
  const t = useT();
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const state = computeCountdownState(endsAt, nowMs);
  if (state.kind === "no-event") return null;

  if (state.kind === "ended") {
    return (
      <Badge color="grey">
        {t("countdown.ended_label")} {state.display}
      </Badge>
    );
  }

  if (state.kind === "warning") {
    return (
      <Box color="text-status-error" fontWeight="bold" display="inline-block">
        <Badge color="red">
          {t("countdown.last_5_min")} {state.display}
        </Badge>
      </Box>
    );
  }

  return (
    <Badge color="blue">
      {t("countdown.remaining_label")} {state.display}
    </Badge>
  );
}
