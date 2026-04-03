/**
 * Notification Panel
 *
 * Cloudscape Flashbar による通知表示、ベルアイコン + ドロップダウンパネル
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Flashbar from '@cloudscape-design/components/flashbar';
import type { FlashbarProps } from '@cloudscape-design/components/flashbar';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNotifications } from '@/lib/notifications';
import type { Notification, NotificationSeverity } from '@/lib/notifications';

function mapSeverityToFlashType(
  severity: NotificationSeverity,
): FlashbarProps.Type {
  switch (severity) {
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function NotificationPanel() {
  const { notifications, unreadCount, markAsRead, markAllRead, clearAll } =
    useNotifications();

  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const flashItems: FlashbarProps.MessageDefinition[] = useMemo(
    () =>
      notifications.slice(0, 20).map((notification: Notification) => ({
        type: mapSeverityToFlashType(notification.severity),
        dismissible: true,
        dismissLabel: '閉じる',
        onDismiss: () => markAsRead(notification.id),
        content: (
          <SpaceBetween size="xxs">
            <Box variant="small" color="text-body-secondary">
              {formatTimestamp(notification.timestamp)}
            </Box>
            <Box>{notification.message}</Box>
          </SpaceBetween>
        ),
        header: notification.title,
        id: notification.id,
      })),
    [notifications, markAsRead],
  );

  return (
    <div
      ref={panelRef}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <button
        type="button"
        onClick={handleToggle}
        aria-label={`通知 ${unreadCount > 0 ? `(${unreadCount}件の未読)` : ''}`}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '4px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          color: 'inherit',
        }}
        data-testid="notification-bell"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && <Badge color="red">{`${unreadCount}`}</Badge>}
      </button>

      {isOpen && (
        <div
          data-testid="notification-dropdown"
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            width: '420px',
            maxHeight: '500px',
            overflowY: 'auto',
            zIndex: 1000,
            background: 'var(--color-background-container-content, #0f1b2d)',
            border: '1px solid var(--color-border-divider-default, #414d5c)',
            borderRadius: '8px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          }}
        >
          <div
            style={{
              padding: '12px 16px',
              borderBottom:
                '1px solid var(--color-border-divider-default, #414d5c)',
            }}
          >
            <Header
              variant="h3"
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    variant="link"
                    onClick={markAllRead}
                    disabled={unreadCount === 0}
                  >
                    すべて既読
                  </Button>
                  <Button
                    variant="link"
                    onClick={clearAll}
                    disabled={notifications.length === 0}
                  >
                    すべて削除
                  </Button>
                </SpaceBetween>
              }
            >
              通知
            </Header>
          </div>
          <div style={{ padding: '8px' }}>
            {notifications.length === 0 ? (
              <Box textAlign="center" padding="l" color="text-body-secondary">
                通知はありません
              </Box>
            ) : (
              <Flashbar items={flashItems} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
