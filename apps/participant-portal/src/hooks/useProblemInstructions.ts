import { useEffect, useState } from "react";
import { loadProblemInstructions, type ProblemInstructions } from "../data/problems";

interface InstructionsState {
  readonly problemId: string;
  readonly attempt: number;
  readonly value?: ProblemInstructions;
  readonly error?: string;
}

/** Ignore an older route's response, and never request content while its detail view is locked. */
export function useProblemInstructions(problemId: string | undefined, enabled: boolean) {
  const [state, setState] = useState<InstructionsState>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !problemId) return;
    let current = true;
    setState(undefined);
    loadProblemInstructions(problemId).then(
      (value) => {
        if (current) setState({ problemId, attempt, value });
      },
      (error: unknown) => {
        if (current) setState({ problemId, attempt, error: String(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [problemId, enabled, attempt]);
  const active =
    enabled && state?.problemId === problemId && state?.attempt === attempt ? state : undefined;
  return {
    value: active?.value,
    error: active?.error,
    loading: enabled && !!problemId && !active,
    retry: () => setAttempt((previous) => previous + 1),
  };
}
