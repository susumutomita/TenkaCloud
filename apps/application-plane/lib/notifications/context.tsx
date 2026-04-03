/**
 * Notification Context / Provider
 *
 * 通知の状態管理とlocalStorage永続化
 */

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type {
  Notification,
  NotificationSeverity,
  NotificationType,
} from './types';

const STORAGE_KEY = 'tenkacloud-notifications';

interface AddNotificationParams {
  type: NotificationType;
  title: string;
  message: string;
  severity: NotificationSeverity;
}

interface NotificationContextValue {
  notifications: Notification[];
  unreadCount: number;
  addNotification: (params: AddNotificationParams) => void;
  markAsRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

function loadFromStorage(): Notification[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Notification[];
  } catch {
    return [];
  }
}

function saveToStorage(notifications: Notification[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
  } catch {
    // storage full or unavailable
  }
}

interface NotificationProviderProps {
  children: ReactNode;
}

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    setNotifications(loadFromStorage());
    setInitialized(true);
  }, []);

  useEffect(() => {
    if (initialized) {
      saveToStorage(notifications);
    }
  }, [notifications, initialized]);

  const addNotification = useCallback((params: AddNotificationParams) => {
    const newNotification: Notification = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type: params.type,
      title: params.title,
      message: params.message,
      timestamp: new Date().toISOString(),
      read: false,
      severity: params.severity,
    };
    setNotifications((prev) => [newNotification, ...prev]);
  }, []);

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const value = useMemo<NotificationContextValue>(
    () => ({
      notifications,
      unreadCount,
      addNotification,
      markAsRead,
      markAllRead,
      clearAll,
    }),
    [
      notifications,
      unreadCount,
      addNotification,
      markAsRead,
      markAllRead,
      clearAll,
    ],
  );

  return (
    <NotificationContext value={value}>{children}</NotificationContext>
  );
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationProvider');
  }
  return ctx;
}
