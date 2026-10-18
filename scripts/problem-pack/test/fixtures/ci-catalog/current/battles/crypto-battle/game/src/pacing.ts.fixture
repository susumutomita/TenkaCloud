/** Operator settings, bundled with this problem. Applied only to new matches. */
export const MATCH_PACING = {
  answerSeconds: 180,
  arrivalSeconds: 30,
  arrivalJitterSeconds: 10,
} as const;

export function pacingConfig(settings: { answerSeconds: number; arrivalSeconds: number; arrivalJitterSeconds: number }) {
  const { answerSeconds, arrivalSeconds, arrivalJitterSeconds } = settings;
  if (!Number.isInteger(answerSeconds) || answerSeconds < 30 || answerSeconds > 900)
    throw new Error("answerSeconds must be an integer from 30 to 900");
  if (!Number.isInteger(arrivalSeconds) || arrivalSeconds < 10 || arrivalSeconds > 300)
    throw new Error("arrivalSeconds must be an integer from 10 to 300");
  if (!Number.isInteger(arrivalJitterSeconds) || arrivalJitterSeconds < 0 || arrivalJitterSeconds >= arrivalSeconds)
    throw new Error("arrivalJitterSeconds must be an integer from 0 up to arrivalSeconds-1");
  return { contractTtlMs: answerSeconds * 1000, rushContractTtlMs: answerSeconds * 1000,
    contractIntervalMs: arrivalSeconds * 1000, onboardingFollowUpMs: arrivalSeconds * 1000,
    orderArrivalJitterMs: arrivalJitterSeconds * 1000 };
}
