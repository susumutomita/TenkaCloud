import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import { useEffect, useRef, useState } from "react";
import { getPortalMe } from "../api/portal-client";
import { useT } from "../i18n";

function handoffUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.pathname === "/__join" &&
      url.searchParams.has("ticket")
    )
      return url;
  } catch {
    // Ordinary outputs keep their existing link rendering below.
  }
  return undefined;
}

function freshHandoff(view: Awaited<ReturnType<typeof getPortalMe>>, jobId: string, label: string) {
  const value = view.problems.find((problem) => problem.jobId === jobId)?.stackOutputs?.[label];
  const url = value ? handoffUrl(value) : undefined;
  if (!url) throw new Error("Challenge handoff unavailable");
  return url;
}

/** A displayed handoff may have expired or been consumed since the team view loaded. */
function HandoffAccessLink({
  label,
  jobId,
  apiBaseUrl,
  sessionToken,
}: {
  label: string;
  jobId: string;
  apiBaseUrl: string;
  sessionToken: string;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const opening = useRef<{ controller: AbortController; tab: Window } | undefined>(undefined);
  useEffect(
    () => () => {
      opening.current?.controller.abort();
      opening.current?.tab.close();
      opening.current = undefined;
    },
    [],
  );

  const open = async () => {
    if (opening.current) return;
    setFailed(false);
    // Open during the user gesture, before awaiting the authenticated request.
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setFailed(true);
      return;
    }
    tab.opener = null;
    const controller = new AbortController();
    const attempt = { controller, tab };
    opening.current = attempt;
    setPending(true);
    try {
      const view = await getPortalMe(apiBaseUrl, sessionToken, controller.signal);
      if (controller.signal.aborted || tab.closed) return;
      const url = freshHandoff(view, jobId, label);
      tab.location.replace(url.href);
    } catch {
      tab.close();
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (opening.current === attempt) {
        opening.current = undefined;
        setPending(false);
      }
    }
  };

  return (
    <>
      <Button onClick={() => void open()} loading={pending} disabled={pending}>
        {t("problem_panel.access_open")}
      </Button>
      {failed && <Alert type="error">{t("problem_panel.access_open_failed")}</Alert>}
    </>
  );
}

/** Fixed outputs keep ordinary navigation; only one-use handoffs need a fresh team view. */
export function ChallengeAccessLink(props: {
  value: string;
  label: string;
  jobId: string;
  apiBaseUrl: string;
  sessionToken: string;
}) {
  if (!handoffUrl(props.value))
    return (
      <a href={props.value} target="_blank" rel="noreferrer noopener">
        <code>{props.value}</code>
      </a>
    );
  // Remount cancels a pending handoff when its authenticated scope changes.
  const identity = JSON.stringify([props.apiBaseUrl, props.sessionToken, props.jobId, props.label]);
  return <HandoffAccessLink key={identity} {...props} />;
}
