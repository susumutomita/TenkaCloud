import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Checkbox from "@cloudscape-design/components/checkbox";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { PendingOperation } from "@tenkacloud/web-kit";
import { useRef, useState } from "react";
import {
  type ParticipantProblemView,
  type SubmitFlagOutcome,
  submitFlag,
} from "../api/portal-client";
import { useT } from "../i18n";

/** Uses the host's existing authenticated receipt/scoring route; retries retain their nonce. */
interface Props {
  problemId: string;
  submission: ParticipantProblemView["submission"];
  apiBaseUrl: string;
  sessionToken: string;
  onScored: () => Promise<void>;
}
export function StudySubmissionPanel(props: Props) {
  return props.submission ? <SubmissionForm {...props} submission={props.submission} /> : null;
}
function SubmissionForm({
  problemId,
  submission,
  apiBaseUrl,
  sessionToken,
  onScored,
}: Props & { submission: NonNullable<Props["submission"]> }) {
  const t = useT();
  const [answer, setAnswer] = useState("");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome>();
  const [error, setError] = useState<string>();
  const operation = useRef(new PendingOperation());
  async function submit() {
    if (busy || submission.solved) return;
    const envelope =
      submission.kind === "answer"
        ? { edition: submission.edition, answer }
        : {
            edition: submission.edition,
            checks: Object.fromEntries(
              (submission.checks ?? []).map((name) => [name, checks[name] === true]),
            ),
          };
    const flag = JSON.stringify(envelope);
    const key = operation.current.keyFor(JSON.stringify([apiBaseUrl, sessionToken, problemId]), {
      flag,
    });
    setBusy(true);
    setError(undefined);
    try {
      const result = await submitFlag(
        apiBaseUrl,
        sessionToken,
        problemId,
        flag,
        undefined,
        undefined,
        key,
      );
      operation.current.acknowledge(key);
      setOutcome(result);
      await onScored();
    } catch {
      setError(t("study.error"));
    } finally {
      setBusy(false);
    }
  }
  const accepted =
    submission.solved || outcome?.kind === "ok" || outcome?.kind === "already_scored";
  return (
    <SpaceBetween size="s">
      <Alert type="info">
        {t(submission.kind === "self-report" ? "study.assurance" : "study.answer_assurance")}
      </Alert>
      <FormField label={t("study.edition")}>
        <code>{submission.edition}</code>
      </FormField>
      <a
        download={`${problemId}-${submission.edition}.json`}
        href={`data:application/json;charset=utf-8,${encodeURIComponent(submission.artifact)}`}
      >
        {t("study.artifact")}
      </a>
      {accepted ? (
        <Alert type="success">{t("study.accepted")}</Alert>
      ) : (
        <>
          {submission.kind === "answer" ? (
            <FormField label={t("study.answer")}>
              <Input
                value={answer}
                disabled={busy}
                onChange={({ detail }) => setAnswer(detail.value)}
              />
            </FormField>
          ) : (
            (submission.checks ?? []).map((name) => (
              <Checkbox
                key={name}
                checked={checks[name] === true}
                disabled={busy}
                onChange={({ detail }) => setChecks({ ...checks, [name]: detail.checked })}
              >
                {t("study.check", { name })}
              </Checkbox>
            ))
          )}
          <Button
            loading={busy}
            onClick={() => {
              void submit();
            }}
          >
            {t("study.submit")}
          </Button>
          {outcome?.kind === "wrong" && <Alert type="warning">{t("study.wrong")}</Alert>}
        </>
      )}
      {error && <Alert type="error">{error}</Alert>}
    </SpaceBetween>
  );
}
