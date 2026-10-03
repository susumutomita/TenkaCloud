import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MultiFlagEntryView } from "../api/portal-client";
import {
  getWorkbenchConfig,
  getWorkbenchStarter,
  inspectWorkbench,
  prepareWorkbench,
  testWorkbench,
  type WorkbenchConfig,
  type WorkbenchFiles,
} from "../api/portal-client";
import { useT } from "../i18n";
import { CodeTextarea } from "./CodeTextarea";
import { MultiFlagSubmissionPanel } from "./MultiFlagSubmissionPanel";
import { formatProblemPanelActionError } from "./ProblemPanel.helpers";
import {
  readWorkbenchDraft,
  saveWorkbenchDraft,
  type WorkbenchDraftIssue,
  workbenchDraftKey,
} from "./workbench-drafts";

interface LoadedWorkbench {
  readonly config: WorkbenchConfig;
  readonly starter: WorkbenchFiles;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "loaded"; readonly value: LoadedWorkbench };

function validateWorkbench(
  problemId: string,
  flags: readonly Pick<MultiFlagEntryView, "id" | "input">[],
  config: WorkbenchConfig,
  starter: WorkbenchFiles,
): LoadedWorkbench {
  const submittedFiles = new Set(config.submittedFiles);
  const starterFiles = new Set(Object.keys(starter));
  const configIds = new Set(config.checkpoints.map((checkpoint) => checkpoint.id));
  const flagIds = new Set(flags.map((flag) => flag.id));
  const filesMatch =
    submittedFiles.size === starterFiles.size &&
    [...submittedFiles].every((file) => starterFiles.has(file));
  const checkpointsMatch =
    configIds.size === config.checkpoints.length &&
    configIds.size === flagIds.size &&
    [...configIds].every((id) => flagIds.has(id));
  const kindsMatch = config.checkpoints.every((checkpoint) => {
    const flag = flags.find((candidate) => candidate.id === checkpoint.id);
    return flag !== undefined && (checkpoint.kind === "code") === (flag.input === "multiline");
  });
  if (config.id !== problemId || !filesMatch || !checkpointsMatch || !kindsMatch) {
    throw new Error("The container editor contract does not match this problem catalog.");
  }
  return { config, starter };
}

function fallbackSubmission(
  flagId: string,
  checkpoint: WorkbenchConfig["checkpoints"][number],
  values: Readonly<Record<string, string>>,
  files: WorkbenchFiles,
  submittedFiles: readonly string[],
): string {
  if (checkpoint.kind === "answer") {
    // MultiFlagSubmissionPanel calls prepareSubmission for direct answers only
    // after its non-empty input guard has passed.
    return (values[flagId] as string).trim();
  }
  if (submittedFiles.length === 1) return files[submittedFiles[0]] as string;
  return JSON.stringify(files);
}

interface ContainerWorkbenchPanelProps {
  readonly apiBaseUrl: string;
  readonly sessionToken: string;
  readonly problemId: string;
  readonly jobId?: string;
  readonly flags: readonly MultiFlagEntryView[];
  readonly onScored: () => Promise<void>;
  readonly revealOrder?: "flat" | "sequential";
}

/** A scope switch unmounts all editor/action state, without putting credentials in a key. */
export function ContainerWorkbenchPanel(props: ContainerWorkbenchPanelProps) {
  return (
    <WorkbenchSession
      key={JSON.stringify([props.apiBaseUrl, props.jobId, props.problemId])}
      {...props}
    />
  );
}

/** Capability discovery is a 404-safe probe for ordinary container problems. */
function WorkbenchSession({
  apiBaseUrl,
  sessionToken,
  problemId,
  jobId,
  flags,
  onScored,
  revealOrder,
}: ContainerWorkbenchPanelProps) {
  const t = useT();
  const flagContract = JSON.stringify(
    flags.map((flag) => ({ id: flag.id, input: flag.input ?? "text" })),
  );
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [files, setFiles] = useState<WorkbenchFiles>({});
  const [draftIssue, setDraftIssue] = useState<WorkbenchDraftIssue>();
  const draftKey = workbenchDraftKey(apiBaseUrl, jobId, problemId);
  const blockDraftOverwrite = useRef(false);
  const activeRequest = useRef<AbortSignal | undefined>(undefined);
  const [inspectOutput, setInspectOutput] = useState<string>();
  const [testResult, setTestResult] = useState<{ passed: boolean; output: string }>();
  const [actionError, setActionError] = useState<string>();
  const [inspecting, setInspecting] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    activeRequest.current = controller.signal;
    setLoad({ kind: "loading" });
    setInspectOutput(undefined);
    setTestResult(undefined);
    setActionError(undefined);
    setInspecting(false);
    setTesting(false);
    void getWorkbenchConfig(apiBaseUrl, sessionToken, problemId, controller.signal)
      .then(async (config) => {
        if (controller.signal.aborted) return;
        if (!config) {
          setLoad({ kind: "unsupported" });
          return;
        }
        const starter = await getWorkbenchStarter(
          apiBaseUrl,
          sessionToken,
          problemId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const expectedFlags = JSON.parse(flagContract) as Pick<
          MultiFlagEntryView,
          "id" | "input"
        >[];
        const loaded = validateWorkbench(problemId, expectedFlags, config, starter);
        const draft = readWorkbenchDraft(draftKey, loaded.starter);
        blockDraftOverwrite.current = draft.issue === "restore_failed";
        setDraftIssue(draft.issue);
        setFiles(draft.files);
        setLoad({ kind: "loaded", value: loaded });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: "error", error });
      });
    return () => controller.abort();
  }, [apiBaseUrl, draftKey, flagContract, problemId, sessionToken]);

  const checkpointById = useMemo(
    () =>
      new Map(
        load.kind === "loaded"
          ? load.value.config.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint])
          : [],
      ),
    [load],
  );

  if (load.kind === "loading") {
    return (
      <Box textAlign="center">
        <Spinner /> {t("workbench.loading")}
      </Box>
    );
  }
  if (load.kind === "unsupported") {
    return (
      <MultiFlagSubmissionPanel
        apiBaseUrl={apiBaseUrl}
        sessionToken={sessionToken}
        problemId={problemId}
        flags={flags}
        onScored={onScored}
        revealOrder={revealOrder}
      />
    );
  }
  if (load.kind === "error") {
    return (
      <Alert type="error" header={t("workbench.unavailable_header")}>
        {formatProblemPanelActionError(t, load.error, "problem_panel.validation_error")}
      </Alert>
    );
  }

  const updateFiles = (next: WorkbenchFiles, replaceUnreadable = false) => {
    setFiles(next);
    // Preserve unreadable data until the participant explicitly restores the starter.
    if (blockDraftOverwrite.current && !replaceUnreadable) return;
    blockDraftOverwrite.current = false;
    setDraftIssue(saveWorkbenchDraft(draftKey, next));
  };

  const runInspect = async () => {
    const signal = activeRequest.current;
    setInspecting(true);
    setActionError(undefined);
    try {
      const result = await inspectWorkbench(apiBaseUrl, sessionToken, problemId);
      if (!signal?.aborted) setInspectOutput(result.output);
    } catch (error) {
      if (signal?.aborted) return;
      setActionError(formatProblemPanelActionError(t, error, "problem_panel.validation_error"));
    } finally {
      if (!signal?.aborted) setInspecting(false);
    }
  };

  const runTests = async () => {
    const signal = activeRequest.current;
    setTesting(true);
    setActionError(undefined);
    try {
      const result = await testWorkbench(apiBaseUrl, sessionToken, problemId, files);
      if (!signal?.aborted) setTestResult(result);
    } catch (error) {
      if (signal?.aborted) return;
      setActionError(formatProblemPanelActionError(t, error, "problem_panel.validation_error"));
    } finally {
      if (!signal?.aborted) setTesting(false);
    }
  };

  const prepareSubmission = async (
    flagId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<string> => {
    const signal = activeRequest.current;
    signal?.throwIfAborted();
    const manual = Object.fromEntries(
      load.value.config.checkpoints
        .filter((checkpoint) => checkpoint.kind === "answer")
        .map((checkpoint) => [checkpoint.id, values[checkpoint.id] ?? ""]),
    );
    const prepared = await prepareWorkbench(apiBaseUrl, sessionToken, problemId, files, manual);
    signal?.throwIfAborted();
    if (!prepared.ok) throw new Error(prepared.output);
    const supplied = prepared.submissions[flagId];
    if (supplied !== undefined && supplied.length > 0) return supplied;

    // The four legacy course problems intentionally omit paper-derived answers
    // from `/api/prepare`; preserve those direct values. Their code checkpoints
    // retain the historic raw-source format.
    return fallbackSubmission(
      flagId,
      checkpointById.get(flagId) as WorkbenchConfig["checkpoints"][number],
      values,
      files,
      load.value.config.submittedFiles,
    );
  };

  return (
    <SpaceBetween size="m">
      <Container
        header={
          <Header variant="h3" description={load.value.config.description}>
            {t("workbench.heading")}
          </Header>
        }
      >
        <SpaceBetween size="m">
          {draftIssue ? (
            <Alert type="warning" header={t("workbench.draft_warning")}>
              {t(`workbench.draft_${draftIssue}`)}
            </Alert>
          ) : (
            <Box color="text-body-secondary">{t("workbench.draft_local")}</Box>
          )}
          {load.value.config.submittedFiles.map((file) => (
            <FormField
              key={file}
              label={<code>{file}</code>}
              description={t("workbench.editor_keys")}
            >
              <CodeTextarea
                value={files[file] as string}
                onChange={(value) => updateFiles({ ...files, [file]: value })}
                rows={16}
                disabled={testing}
              />
            </FormField>
          ))}
          <SpaceBetween size="xs" direction="horizontal">
            <Button onClick={() => void runInspect()} loading={inspecting}>
              {t("workbench.inspect_button")}
            </Button>
            <Button onClick={() => void runTests()} loading={testing} variant="primary">
              {t("workbench.test_button")}
            </Button>
            <Button
              onClick={() => {
                updateFiles(load.value.starter, true);
                setTestResult(undefined);
                setActionError(undefined);
              }}
            >
              {t("workbench.reset_button")}
            </Button>
          </SpaceBetween>
          {inspectOutput !== undefined && (
            <Alert type="info" header={t("workbench.inspect_heading")}>
              <pre style={{ whiteSpace: "pre-wrap" }}>{inspectOutput}</pre>
            </Alert>
          )}
          {testResult !== undefined && (
            <Alert
              type={testResult.passed ? "success" : "warning"}
              header={testResult.passed ? t("workbench.test_passed") : t("workbench.test_failed")}
            >
              <pre style={{ whiteSpace: "pre-wrap" }}>{testResult.output}</pre>
            </Alert>
          )}
          {actionError && (
            <Alert type="error" header={t("workbench.action_failed")}>
              {actionError}
            </Alert>
          )}
        </SpaceBetween>
      </Container>
      <MultiFlagSubmissionPanel
        apiBaseUrl={apiBaseUrl}
        sessionToken={sessionToken}
        problemId={problemId}
        flags={flags}
        onScored={onScored}
        revealOrder={revealOrder}
        prepareSubmission={prepareSubmission}
      />
    </SpaceBetween>
  );
}
