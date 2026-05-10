import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import { useEffect } from "react";
import type { NotificationView } from "../api/portal-client";
import { useTeamView } from "../auth/TeamViewProvider";
import type { AppConfig } from "../config";
import { describeAgo } from "../lib/format";
import { saveLastSeenAt } from "../lib/notifications-storage";

const SEVERITY_COLOR: Record<NotificationView["severity"], "blue" | "red"> = {
  info: "blue",
  warning: "red",
};
const SEVERITY_LABEL: Record<NotificationView["severity"], string> = {
  info: "Info",
  warning: "Warning",
};

/**
 * 運営 → 競技者 通知一覧 (sidebar 「Notifications」、ADR-006)。
 *
 * データ source は `TeamViewProvider.notifications` を共有 (= 同じ polling tick に
 * 乗っているので別 polling は立てない)。**page を開いた瞬間に最新 occurredAt を
 * localStorage に保存して TopNav の未読 badge を 0 化** する (D2)。
 *
 * Phase 1 以前の旧 deployment (eventId 無し) は backend が 404 を返すので、
 * `notificationsNoEvent` で告知して空白を出す。
 */
export function NotificationsPage({ config }: { config: AppConfig }) {
  const { notifications, notificationsError, notificationsNoEvent } = useTeamView();
  const isBackend = config.mode === "backend";
  const items = notifications?.items;

  // page を開いたら latest occurredAt を localStorage に書いて未読 badge を 0 化。
  // items が更新されるたびに走るが、saveLastSeenAt は巻き戻し防止 + 同値 skip なので no-op が連続しても害なし。
  useEffect(() => {
    if (items && items.length > 0) {
      saveLastSeenAt(items[0]?.occurredAt ?? "");
    }
  }, [items]);

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="運営からの通知 (新しい順、最大 100 件、polling 60 秒)">
        Notifications
      </Header>

      {!isBackend && (
        <Alert type="info">
          dev-mock モードで動作中です。実 backend と接続するには runtime-config の<code>mode</code>{" "}
          を <code>backend</code> に設定してください。
        </Alert>
      )}
      {notificationsError && (
        <Alert type="error" header="通知の取得に失敗しました">
          {notificationsError}
        </Alert>
      )}
      {notificationsNoEvent && (
        <Alert type="info" header="通知は配信されません">
          このチームは event に紐づいていない旧 deployment のため、運営からの通知配信対象外です。
        </Alert>
      )}
      {isBackend && !notifications && !notificationsError && !notificationsNoEvent && (
        <Box textAlign="center" padding="l">
          <Spinner /> 通知を取得中…
        </Box>
      )}

      {items && items.length === 0 && (
        <Container>
          <Box textAlign="center" padding="l">
            <Box variant="strong">まだ通知はありません</Box>
            <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
              運営者が application admin console から発信した通知をここに表示します。
            </Box>
          </Box>
        </Container>
      )}

      {items && items.length > 0 && (
        <SpaceBetween size="m">
          {items.map((n) => (
            <Container
              key={n.notificationId}
              header={
                <Header
                  variant="h3"
                  actions={
                    <Badge color={SEVERITY_COLOR[n.severity]}>{SEVERITY_LABEL[n.severity]}</Badge>
                  }
                >
                  {n.title}
                </Header>
              }
            >
              <SpaceBetween size="xs">
                <Box variant="p">
                  {/* 改行を尊重 (本文には URL も含まれうるので autoLink は意図的に避ける) */}
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: "pre-wrap",
                      fontFamily: "inherit",
                      fontSize: "inherit",
                    }}
                  >
                    {n.body}
                  </pre>
                </Box>
                <Box variant="small" color="text-status-inactive">
                  {n.occurredAt} ({describeAgo(n.occurredAt, Date.now())})
                </Box>
              </SpaceBetween>
            </Container>
          ))}
        </SpaceBetween>
      )}
    </SpaceBetween>
  );
}
