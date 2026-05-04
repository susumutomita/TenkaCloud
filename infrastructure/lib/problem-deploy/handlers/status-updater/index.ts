import { buildUpdaterShared, runStatusUpdate } from "./updater.js";

const shared = buildUpdaterShared();

export const handler = async (): Promise<void> => {
  await runStatusUpdate(shared);
};
