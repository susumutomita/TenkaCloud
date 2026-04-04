import { z } from 'zod';

// --- Leaderboard Entry ---

export const leaderboardEntrySchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  score: z.number(),
  rank: z.number(),
});

export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

// --- Realtime Events (server -> client) ---

export const scoreUpdateEventSchema = z.object({
  type: z.literal('score_update'),
  teamId: z.string(),
  score: z.number(),
  rank: z.number(),
});

export const attackExecutedEventSchema = z.object({
  type: z.literal('attack_executed'),
  attackerTeamId: z.string(),
  defenderTeamId: z.string(),
  attackSlug: z.string(),
});

export const gameStateChangedEventSchema = z.object({
  type: z.literal('game_state_changed'),
  isRunning: z.boolean(),
  scoreWeight: z.string(),
  blackout: z.boolean(),
});

export const leaderboardUpdateEventSchema = z.object({
  type: z.literal('leaderboard_update'),
  entries: z.array(leaderboardEntrySchema),
});

export const realtimeEventSchema = z.discriminatedUnion('type', [
  scoreUpdateEventSchema,
  attackExecutedEventSchema,
  gameStateChangedEventSchema,
  leaderboardUpdateEventSchema,
]);

export type ScoreUpdateEvent = z.infer<typeof scoreUpdateEventSchema>;
export type AttackExecutedEvent = z.infer<typeof attackExecutedEventSchema>;
export type GameStateChangedEvent = z.infer<typeof gameStateChangedEventSchema>;
export type LeaderboardUpdateEvent = z.infer<typeof leaderboardUpdateEventSchema>;
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

// --- Client Messages (client -> server) ---

export const clientJoinRoomSchema = z.object({
  action: z.literal('join'),
  eventId: z.string(),
});

export const clientLeaveRoomSchema = z.object({
  action: z.literal('leave'),
  eventId: z.string(),
});

export const clientPingSchema = z.object({
  action: z.literal('ping'),
});

export const clientMessageSchema = z.discriminatedUnion('action', [
  clientJoinRoomSchema,
  clientLeaveRoomSchema,
  clientPingSchema,
]);

export type ClientJoinRoom = z.infer<typeof clientJoinRoomSchema>;
export type ClientLeaveRoom = z.infer<typeof clientLeaveRoomSchema>;
export type ClientPing = z.infer<typeof clientPingSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// --- Server Responses ---

export const serverPongSchema = z.object({
  type: z.literal('pong'),
});

export const serverErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const serverJoinedSchema = z.object({
  type: z.literal('joined'),
  eventId: z.string(),
});

export const serverLeftSchema = z.object({
  type: z.literal('left'),
  eventId: z.string(),
});

export type ServerPong = z.infer<typeof serverPongSchema>;
export type ServerError = z.infer<typeof serverErrorSchema>;
export type ServerJoined = z.infer<typeof serverJoinedSchema>;
export type ServerLeft = z.infer<typeof serverLeftSchema>;

export type ServerMessage = ServerPong | ServerError | ServerJoined | ServerLeft | RealtimeEvent;
