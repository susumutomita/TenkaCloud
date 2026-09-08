import versions from "virtual:portal-plugin-versions";
import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import type { PortalLocale } from "@tenkacloud/portal-plugin-sdk";
import { useEffect, useState } from "react";

// Keep established evidence for the lifetime of this loaded build, including route remounts.
export const detectedPluginUpdates = new Set<string>();

function manifestVersions(value: unknown): Record<string, string> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("problems" in value)
  )
    return;
  const problems = value.problems;
  if (!problems || typeof problems !== "object" || Array.isArray(problems)) return;
  if (
    !Object.values(problems).every(
      (version) => typeof version === "string" && /^[a-f0-9]{64}$/.test(version),
    )
  )
    return;
  return problems as Record<string, string>;
}

export function ReloadPortal({
  locale,
  reload = () => window.location.reload(),
}: {
  locale: PortalLocale;
  reload?: () => void;
}) {
  return (
    <>
      <p>
        {locale === "ja"
          ? "送信済みの回答は残ります。未送信の入力は消えるため、必要な内容を控えてから再読み込みしてください。"
          : "Submitted answers are saved. Copy any unfinished input before reloading; unsent input will be lost."}
      </p>
      <Button onClick={reload}>
        {locale === "ja" ? "入力を破棄して再読み込み" : "Discard input and reload"}
      </Button>
    </>
  );
}

export function PluginUpdateNotice({
  locale,
  problemId,
}: {
  locale: PortalLocale;
  problemId: string;
}) {
  const [updatedProblems, setUpdatedProblems] = useState(() => new Set(detectedPluginUpdates));
  useEffect(() => {
    const base = new URL(import.meta.env.BASE_URL, window.location.origin).href;
    const loaded = versions[problemId];
    if (!loaded) return;
    let disposed = false;
    let pending: AbortController | undefined;
    const check = async () => {
      if (disposed || pending || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(new URL("plugin-versions.json", base).href, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const latest = manifestVersions(await response.json());
        // A valid complete manifest also reports removal by omitting the old problem.
        if (!disposed && latest && latest[problemId] !== loaded) {
          detectedPluginUpdates.add(problemId);
          setUpdatedProblems(new Set(detectedPluginUpdates));
        }
      } catch {
        // Offline checks are retried. They must neither reload nor erase a form.
      } finally {
        window.clearTimeout(timeout);
        pending = undefined;
      }
    };
    void check();
    const interval = window.setInterval(() => void check(), 60_000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      pending?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [problemId]);
  if (!updatedProblems.has(problemId)) return null;
  return (
    <Alert
      type="warning"
      header={
        locale === "ja" ? "問題画面の更新があります" : "An updated problem screen is available"
      }
    >
      <p>
        {locale === "ja"
          ? "開いている画面が古く、現在の問題データと合わない可能性があります。"
          : "This open screen may be incompatible with the current problem data."}
      </p>
      <ReloadPortal locale={locale} />
    </Alert>
  );
}
