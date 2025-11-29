/**
 * JAM モジュール
 *
 * minoru1 (RestApp) の機能を TypeScript で再実装
 */

// チャレンジ管理
export {
  startChallenge,
  getChallengesForTeam,
  getChallengeDetail,
} from './challenge';

// 採点・クルーペナルティ
export { calculatePointsEarned, openClue, validateAnswer } from './scoring';

// Pessimistic Locking
export {
  acquireLock,
  releaseLock,
  withLock,
  withSerializableTransaction,
} from './locking';

// ダッシュボード・リーダーボード
export {
  getLeaderboard,
  getTeamDashboard,
  getChallengeStatistics,
  getEventDashboard,
  saveLeaderboardSnapshot,
} from './dashboard';

// イベントログ
export {
  addEventLog,
  getEventLogs,
  getRecentLogs,
  logChallengeStart,
  logChallengeComplete,
  logTaskComplete,
  logClueUsed,
  logAnswerCorrect,
  logAnswerIncorrect,
  logScoreUpdate,
  logContestStart,
  logContestEnd,
  EventLogType,
} from './eventlog';

// コンテスト管理
export {
  createContest,
  startContest,
  stopContest,
  pauseContest,
  resumeContest,
  addChallengeToContest,
  removeChallengeFromContest,
  registerTeamToContest,
  getContestTeams,
  ContestStatus,
} from './contest';
