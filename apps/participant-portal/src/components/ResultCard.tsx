import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LeaderboardResponse } from "../api/portal-client";
import { useLang, useT } from "../i18n";
import "./ResultCard.css";
import {
  buildResultCardFilename,
  buildResultCardModel,
  renderResultCardPng,
  resultCardSvgDataUrl,
  type ResultCardModel,
  type ResultCardResult,
} from "./result-card";

export interface ResultCardRuntime {
  readonly now: () => string;
  readonly renderPng: (model: ResultCardModel) => Promise<ResultCardResult<Blob>>;
  readonly supportsFileShare: () => boolean;
  readonly share: (file: File) => Promise<void>;
  readonly download: (blob: Blob, filename: string) => void;
}

function browserSupportsFileShare(): boolean {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.share !== "function" ||
    typeof navigator.canShare !== "function" ||
    typeof File === "undefined"
  ) {
    return false;
  }
  try {
    const probe = new File([""], "tenkacloud-result.png", { type: "image/png" });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  if (
    typeof document === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error("Blob download is unavailable in this browser.");
  }
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

const defaultResultCardRuntime: ResultCardRuntime = {
  now: () => new Date().toISOString(),
  renderPng: (model) => renderResultCardPng(model),
  supportsFileShare: browserSupportsFileShare,
  share: async (file) => {
    if (
      typeof navigator === "undefined" ||
      typeof navigator.share !== "function" ||
      typeof navigator.canShare !== "function" ||
      !navigator.canShare({ files: [file] })
    ) {
      throw new Error("File sharing is unavailable in this browser.");
    }
    await navigator.share({
      title: "TenkaCloud Result Card",
      files: [file],
    });
  },
  download: downloadBlob,
};

function isShareCancellation(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { readonly name?: unknown }).name === "AbortError")
  );
}

/**
 * Issue #3035: Scoreboard と同じ LeaderboardResponse を読む Result Card UI。
 * 独自 polling や score 再計算は持たず、明示的な user action でだけ PNG を生成する。
 */
export function ResultCard({
  leaderboard,
  eventTitle,
  runtime = defaultResultCardRuntime,
}: {
  readonly leaderboard: LeaderboardResponse;
  readonly eventTitle: string;
  readonly runtime?: ResultCardRuntime;
}) {
  const t = useT();
  const lang = useLang();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<"share" | "download" | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorVisible, setErrorVisible] = useState(false);

  const modelResult = useMemo(
    () =>
      buildResultCardModel({
        leaderboard,
        eventTitle,
        generatedAt: runtime.now(),
        locale: lang,
      }),
    [eventTitle, lang, leaderboard, runtime],
  );

  const model = modelResult.ok ? modelResult.value : undefined;
  const modelIdentity = model
    ? [
        model.generatedAt,
        model.eventTitle,
        model.teamName,
        model.rank,
        model.score,
        model.completedProblems,
        model.totalProblems,
        model.status,
      ].join(":")
    : undefined;
  useEffect(() => {
    setSuccessMessage(null);
    setErrorVisible(false);
  }, [modelIdentity]);

  if (!model) return null;

  const filename = buildResultCardFilename(model);
  const shareSupported = runtime.supportsFileShare();
  const previewAlt = t("result_card.preview_alt", {
    eventTitle: model.eventTitle,
    teamName: model.teamName,
    rank: model.rank,
    score: model.score,
    completed: model.completedProblems,
    total: model.totalProblems,
  });

  const renderPng = async (): Promise<Blob | undefined> => {
    const result = await runtime.renderPng(model);
    if (!result.ok) {
      setErrorVisible(true);
      return undefined;
    }
    return result.value;
  };

  const runExclusive = async (
    operation: "share" | "download",
    action: () => Promise<void>,
  ): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(operation);
    setSuccessMessage(null);
    setErrorVisible(false);
    try {
      await action();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const handleDownload = () =>
    runExclusive("download", async () => {
      try {
        const blob = await renderPng();
        if (!blob) return;
        runtime.download(blob, filename);
        setSuccessMessage(t("result_card.download_success"));
      } catch {
        setErrorVisible(true);
      }
    });

  const handleShare = () =>
    runExclusive("share", async () => {
      try {
        const blob = await renderPng();
        if (!blob) return;
        const file = new File([blob], filename, {
          type: "image/png",
          lastModified: Date.parse(model.generatedAt),
        });
        await runtime.share(file);
        setSuccessMessage(t("result_card.share_success"));
      } catch (error) {
        if (!isShareCancellation(error)) setErrorVisible(true);
      }
    });

  return (
    <Container
      header={
        <Header variant="h2" description={t("result_card.description")}>
          {t("result_card.title")}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {errorVisible && (
          <Alert type="error" header={t("result_card.error_header")}>
            {t("result_card.error_body")}
          </Alert>
        )}
        {successMessage && (
          <div role="status" aria-live="polite">
            <Alert type="success" statusIconAriaLabel={successMessage}>
              {successMessage}
            </Alert>
          </div>
        )}

        <div className="tenkacloud-result-card-preview">
          <img
            src={resultCardSvgDataUrl(model)}
            alt={previewAlt}
            draggable={false}
            width={1200}
            height={630}
          />
        </div>

        <Box variant="small" color="text-status-inactive">
          {model.status === "final"
            ? t("result_card.final_note")
            : t("result_card.live_note")}
        </Box>

        <SpaceBetween direction="horizontal" size="s">
          {shareSupported && (
            <Button
              variant="primary"
              loading={busy === "share"}
              disabled={busy !== null}
              onClick={handleShare}
            >
              {t("result_card.share_button")}
            </Button>
          )}
          <Button
            loading={busy === "download"}
            disabled={busy !== null}
            onClick={handleDownload}
          >
            {t("result_card.download_button")}
          </Button>
        </SpaceBetween>

        {!shareSupported && (
          <Box variant="small" color="text-status-inactive">
            {t("result_card.share_unavailable")}
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}
