import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Textarea from "@cloudscape-design/components/textarea";
import { useEffect, useMemo, useState } from "react";
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
import { MultiFlagSubmissionPanel } from "./MultiFlagSubmissionPanel";
import { formatProblemPanelActionError } from "./ProblemPanel.helpers";

interface LoadedWorkbench {
  readonly config: WorkbenchConfig;
  readonly starter: WorkbenchFiles;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error"; readonly message: string }
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

/**
 * Generic local container editor. Capability discovery is a 404-safe probe, so
 * ordinary container problems retain the existing multi-checkpoint form unchanged.
 */
export function ContainerWorkbenchPanel({
  apiBaseUrl,
  sessionToken,
  problemId,
  flags,
  onScored,
  revealOrder,
  writeupAvailable,
}: {
  readonly apiBaseUrl: string;
  readonly sessionToken: string;
  readonly problemId: string;
  readonly flags: readonly MultiFlagEntryView[];
  readonly onScored: () => Promise<void>;
  readonly revealOrder?: "flat" | "sequential";
  /** [#2908] writeup 公開済みのとき全問クリア表示から解説へ誘導する (透過渡し)。 */
  readonly writeupAvailable?: boolean;
}) {
  const t = useT();
  const flagContract = JSON.stringify(
    flags.map((flag) => ({ id: flag.id, input: flag.input ?? "text" })),
  );
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [files, setFiles] = useState<WorkbenchFiles>({});
  const [inspectOutput, setInspectOutput] = useState<string>();
  const [testResult, setTestResult] = useState<{ passed: boolean; output: string }>();
  const [actionError, setActionError] = useState<string>();
  const [inspecting, setInspecting] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    setInspectOutput(undefined);
    setTestResult(undefined);
    setActionError(undefined);
    void getWorkbenchConfig(apiBaseUrl, sessionToken, problemId, controller.signal)
      .then(async (config) => {
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
        const expectedFlags = JSON.parse(flagContract) as Pick<
          MultiFlagEntryView,
          "id" | "input"
        >[];
        const loaded = validateWorkbench(problemId, expectedFlags, config, starter);
        setFiles(loaded.starter);
        setLoad({ kind: "loaded", value: loaded });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoad({
          kind: "error",
          message: formatProblemPanelActionError(t, error, "problem_panel.validation_error"),
        });
      });
    return () => controller.abort();
  }, [apiBaseUrl, flagContract, problemId, sessionToken, t]);

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
        writeupAvailable={writeupAvailable}
      />
    );
  }
  if (load.kind === "error") {
    return (
      <Alert type="error" header={t("workbench.unavailable_header")}>
        {load.message}
      </Alert>
    );
  }

  const runInspect = async () => {
    setInspecting(true);
    setActionError(undefined);
    try {
      setInspectOutput((await inspectWorkbench(apiBaseUrl, sessionToken, problemId)).output);
    } catch (error) {
      setActionError(formatProblemPanelActionError(t, error, "problem_panel.validation_error"));
    } finally {
      setInspecting(false);
    }
  };

  const runTests = async () => {
    setTesting(true);
    setActionError(undefined);
    try {
      setTestResult(await testWorkbench(apiBaseUrl, sessionToken, problemId, files));
    } catch (error) {
      setActionError(formatProblemPanelActionError(t, error, "problem_panel.validation_error"));
    } finally {
      setTesting(false);
    }
  };

  const prepareSubmission = async (
    flagId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<string> => {
    const manual = Object.fromEntries(
      load.value.config.checkpoints
        .filter((checkpoint) => checkpoint.kind === "answer")
        .map((checkpoint) => [checkpoint.id, values[checkpoint.id] ?? ""]),
    );
    const prepared = await prepareWorkbench(apiBaseUrl, sessionToken, problemId, files, manual);
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
          {load.value.config.submittedFiles.map((file) => (
            <FormField key={file} label={<code>{file}</code>}>
              <Textarea
                value={files[file] as string}
                onChange={(event) =>
                  setFiles((current) => ({ ...current, [file]: event.detail.value }))
                }
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
                setFiles(load.value.starter);
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
        writeupAvailable={writeupAvailable}
      />
    </SpaceBetween>
  );
}
