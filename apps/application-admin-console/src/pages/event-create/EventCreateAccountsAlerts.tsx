import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useNavigate } from "react-router";
import { useT } from "../../i18n";

/**
 * Teams section の上に並ぶ 3 種の Alert: load error / loading / 0-verified hint。
 *
 * - load error: red Alert + reload button
 * - loading: info Alert
 * - 0-verified: warning Alert + reload button + Competitor Accounts ページへの link
 *
 * Parent は state の派生 boolean を渡すだけで済むよう、 表示判定はこの component が握る。
 */
export interface EventCreateAccountsAlertsProps {
  accountsLoadError: string | null;
  accountsLoading: boolean;
  showLoadingHint: boolean;
  showNoVerifiedAccountsHint: boolean;
  onReload: () => void;
}

export function EventCreateAccountsAlerts({
  accountsLoadError,
  accountsLoading,
  showLoadingHint,
  showNoVerifiedAccountsHint,
  onReload,
}: EventCreateAccountsAlertsProps) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <>
      {accountsLoadError && (
        <Alert
          type="error"
          header={t("event_create.accounts_load_error_header")}
          action={
            <Button iconName="refresh" onClick={onReload} loading={accountsLoading}>
              {t("event_create.accounts_reload")}
            </Button>
          }
        >
          {accountsLoadError}
        </Alert>
      )}
      {showLoadingHint && (
        <Alert type="info" header={t("event_create.accounts_loading_header")}>
          {t("event_create.accounts_loading_body")}
        </Alert>
      )}
      {showNoVerifiedAccountsHint && (
        <Alert
          type="warning"
          header={t("event_create.no_verified_header")}
          action={
            <SpaceBetween direction="horizontal" size="xs">
              <Button iconName="refresh" onClick={onReload} loading={accountsLoading}>
                {t("event_create.accounts_reload")}
              </Button>
              <Link
                href="/competitor-accounts"
                external={false}
                onFollow={(e) => {
                  e.preventDefault();
                  navigate("/competitor-accounts");
                }}
              >
                {t("event_create.go_to_competitor_accounts")}
              </Link>
            </SpaceBetween>
          }
        >
          {t("event_create.no_verified_body")}
        </Alert>
      )}
    </>
  );
}
