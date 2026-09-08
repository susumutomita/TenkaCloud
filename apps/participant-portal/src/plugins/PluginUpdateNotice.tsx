import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import type { PortalLocale } from "@tenkacloud/portal-plugin-sdk";
import { useEffect, useState } from "react";

/** Compare Vite's content-addressed entry URLs, not runtime config or problem data. */
export function moduleEntries(doc: Document, base: string): string[] {
  return Array.from(doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
    .map((script) => new URL(script.getAttribute("src") ?? "", base).href)
    .sort();
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

export function PluginUpdateNotice({ locale }: { locale: PortalLocale }) {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    const base = new URL(import.meta.env.BASE_URL, window.location.origin).href;
    const loaded = moduleEntries(document, base);
    // Development/test pages without an entry cannot establish a version.
    if (!loaded.length) return;
    let disposed = false;
    let pending: AbortController | undefined;
    const check = async () => {
      if (disposed || pending || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(base, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const latest = moduleEntries(
          new DOMParser().parseFromString(await response.text(), "text/html"),
          base,
        );
        // An error page or a login redirect is not evidence of a new build.
        if (!disposed && latest.length && JSON.stringify(latest) !== JSON.stringify(loaded))
          setUpdated(true);
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
  }, []);
  if (!updated) return null;
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
