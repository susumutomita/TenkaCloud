/**
 * Notification Types
 *
 * 通知システムの型定義
 */

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export type NotificationType =
  | 'attack_received'
  | 'alliance_request'
  | 'game_started'
  | 'game_stopped'
  | 'score_weight_changed'
  | 'blackout_toggled'
  | 'general';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  severity: NotificationSeverity;
}
