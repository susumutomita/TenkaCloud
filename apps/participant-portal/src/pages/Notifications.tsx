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
import { useIsMock } from "../config-context";
import { useLang, useT } from "../i18n";
import { describeAgo } from "../lib/format";

const SEVERITY_COLOR: Record<NotificationView["severity"], "blue" | "red"> = {
  info: "blue",
  warning: "red",
};

/**
 * 運営 → 競技者 通知一覧 (sidebar 「Notifications」、notification API)。
 *
 * データ source は `TeamViewProvider.notifications` を共有 (= 同じ polling tick に
 * 乗っているので別 polling は立てない)。**page を開いた瞬間に最新 occurredAt を
 * localStorage に保存して TopNav の未読 badge を 0 化** する (D2)。
 *
 * Phase 1 以前の旧 deployment (eventId 無し) は backend が 404 を返すので、
 * `notificationsNoEvent` で告知して空白を出す。
 */
export function NotificationsPage() {
  const { notifications, notificationsError, notificationsNoEvent, markNotificationsSeen } =
    useTeamView();
  const t = useT();
  const lang = useLang();
  const isMock = useIsMock();
  const items = notifications?.items;

  // page を開いたら latest occurredAt を context+localStorage に書いて未読 badge を **即時** 0 化。
  // markNotificationsSeen は巻き戻し防止 + 同値 skip なので no-op が連続しても害なし。
  useEffect(() => {
    if (items && items.length > 0) {
      // length>0 を確認済なので items[0] は必ず存在する (= ?. / ?? "" は noUncheckedIndexedAccess
      // 用の防御で実行時には到達不能)。
      /* v8 ignore next */
      const latest = items[0]?.occurredAt ?? "";
      markNotificationsSeen(latest);
    }
  }, [items, markNotificationsSeen]);

  const severityLabel = (s: NotificationView["severity"]) =>
    s === "info" ? t("notifications.severity_info") : t("notifications.severity_warning");

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("notifications.header_description")}>
        {t("notifications.header")}
      </Header>

      {notificationsError && (
        <Alert type="error" header={t("notifications.fetch_failed")}>
          {notificationsError}
        </Alert>
      )}
      {notificationsNoEvent && (
        <Alert type="info" header={t("notifications.no_event_header")}>
          {t("notifications.no_event_body")}
        </Alert>
      )}
      {!isMock && !notifications && !notificationsError && !notificationsNoEvent && (
        <Box textAlign="center" padding="l">
          <Spinner /> {t("notifications.loading")}
        </Box>
      )}

      {items && items.length === 0 && (
        <Container>
          <Box textAlign="center" padding="l">
            <Box variant="strong">{t("notifications.empty_header")}</Box>
            <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
              {t("notifications.empty_hint")}
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
                    <Badge color={SEVERITY_COLOR[n.severity]}>{severityLabel(n.severity)}</Badge>
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
                  {n.occurredAt} ({describeAgo(n.occurredAt, Date.now(), lang)})
                </Box>
              </SpaceBetween>
            </Container>
          ))}
        </SpaceBetween>
      )}
    </SpaceBetween>
  );
}
