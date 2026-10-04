import type { StartedContainer } from "./container-runner";
import type { ContainerProblem } from "./manifest";
import { createNativeCompatibilityGate } from "./native-compatibility";
import { ProblemLifecycle } from "./problem-lifecycle";
import { type ContainerState, createProblemRuntimes, type VerifyFn } from "./state";
import type { SimulatedProgressRuntime, SnapshotState } from "./state-store";

/** A request's view of organizer-owned containers; lifecycle callbacks never create resources. */
export function createContainerState(
  problems: readonly ContainerProblem[],
  options: {
    readonly teamName: string;
    readonly verify: VerifyFn;
    readonly startContainer: (problem: ContainerProblem) => Promise<StartedContainer>;
  },
): ContainerState & SnapshotState & { readonly lifecycle: ProblemLifecycle } {
  const runtimes = createProblemRuntimes(problems);
  const catalog = new Map(problems.map((problem) => [problem.problemId, problem]));
  const lifecycle = new ProblemLifecycle(
    [...catalog.keys()],
    {
      startContainer: async (problemId) => {
        const runtime = runtimes.get(problemId);
        const problem = catalog.get(problemId);
        if (!runtime || !problem) throw new Error(`unknown problem: ${problemId}`);
        runtime.problem = (await options.startContainer(problem)).problem;
      },
      stopContainer: async () => {
        throw new Error("Participant state may not stop host-owned environments.");
      },
      now: Date.now,
      nativeCompatibility: createNativeCompatibilityGate(
        (problemId) => catalog.get(problemId)?.compatibility,
      ),
    },
    { maxRunning: Math.max(1, problems.length) },
  );
  return {
    runtimes,
    simulatedRuntimes: new Map<string, SimulatedProgressRuntime>(),
    scoreEvents: [],
    teamName: options.teamName,
    verify: options.verify,
    browserText: (text) => text,
    lifecycle,
  };
}
