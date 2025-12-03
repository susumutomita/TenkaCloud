/**
 * Challenges API Client
 *
 * 参加者向けチャレンジ（問題）API クライアント
 */

import { get, post } from "./client";
import type {
  AWSCredentials,
  ChallengeDetails,
  ChallengeHint,
  JamChallenge,
  JamClue,
  JamSubmission,
  Submission,
  SubmitAnswerInput,
} from "./types";

// =============================================================================
// Common Challenge API Functions
// =============================================================================

/**
 * チャレンジ詳細を取得
 */
export async function getChallengeDetails(
  eventId: string,
  challengeId: string,
): Promise<ChallengeDetails | null> {
  try {
    return await get<ChallengeDetails>(
      `/participant/events/${eventId}/challenges/${challengeId}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

/**
 * AWS クレデンシャルを取得
 */
export async function getAWSCredentials(
  eventId: string,
  challengeId: string,
): Promise<AWSCredentials | null> {
  try {
    return await get<AWSCredentials>(
      `/participant/events/${eventId}/challenges/${challengeId}/credentials`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

/**
 * ヒントを公開
 */
export async function revealHint(
  eventId: string,
  challengeId: string,
  hintId: string,
): Promise<ChallengeHint> {
  return post<ChallengeHint>(
    `/participant/events/${eventId}/challenges/${challengeId}/hints/${hintId}/reveal`,
  );
}

/**
 * 提出履歴を取得
 */
export async function getSubmissions(
  eventId: string,
  challengeId: string,
): Promise<{ submissions: Submission[] }> {
  return get<{ submissions: Submission[] }>(
    `/participant/events/${eventId}/challenges/${challengeId}/submissions`,
  );
}

/**
 * 最新の提出結果を取得
 */
export async function getLatestSubmission(
  eventId: string,
  challengeId: string,
): Promise<Submission | null> {
  try {
    return await get<Submission>(
      `/participant/events/${eventId}/challenges/${challengeId}/submissions/latest`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

// =============================================================================
// GameDay-specific API Functions
// =============================================================================

/**
 * GameDay: 採点をリクエスト（インフラ構築を検証）
 */
export async function requestGameDayScoring(
  eventId: string,
  challengeId: string,
): Promise<{ submissionId: string; message: string }> {
  return post<{ submissionId: string; message: string }>(
    `/participant/events/${eventId}/challenges/${challengeId}/score`,
  );
}

/**
 * GameDay: 採点結果をポーリング
 */
export async function getGameDayScoringStatus(
  eventId: string,
  challengeId: string,
  submissionId: string,
): Promise<Submission> {
  return get<Submission>(
    `/participant/events/${eventId}/challenges/${challengeId}/submissions/${submissionId}`,
  );
}

// =============================================================================
// JAM-specific API Functions
// =============================================================================

/**
 * JAM: チャレンジ詳細を取得（クルー付き）
 */
export async function getJamChallengeDetails(
  eventId: string,
  challengeId: string,
): Promise<JamChallenge | null> {
  try {
    return await get<JamChallenge>(
      `/participant/events/${eventId}/challenges/${challengeId}/jam`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

/**
 * JAM: クルーを公開
 */
export async function revealClue(
  eventId: string,
  challengeId: string,
  clueId: string,
): Promise<JamClue> {
  return post<JamClue>(
    `/participant/events/${eventId}/challenges/${challengeId}/clues/${clueId}/reveal`,
  );
}

/**
 * JAM: 回答を提出
 */
export async function submitJamAnswer(
  eventId: string,
  challengeId: string,
  input: SubmitAnswerInput,
): Promise<JamSubmission> {
  return post<JamSubmission>(
    `/participant/events/${eventId}/challenges/${challengeId}/submit`,
    input,
  );
}

/**
 * JAM: 提出履歴を取得
 */
export async function getJamSubmissions(
  eventId: string,
  challengeId: string,
): Promise<{ submissions: JamSubmission[] }> {
  return get<{ submissions: JamSubmission[] }>(
    `/participant/events/${eventId}/challenges/${challengeId}/jam/submissions`,
  );
}
