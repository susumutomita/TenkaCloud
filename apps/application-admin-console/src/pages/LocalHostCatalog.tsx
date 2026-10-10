import Alert from "@cloudscape-design/components/alert";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { useParams } from "react-router";
import { useApiClient } from "../api/client";
import type { AppConfig } from "../config";
import { useT } from "../i18n";
import { useHostCatalog } from "./event-create/LocalHostEventCreate";
import { ProblemDetailPage } from "./ProblemDetail";
import { ProblemsPage } from "./Problems";

/** Browse the same supported IDs that the event-creation picker can select. */
export function LocalHostCatalogPage({
  config,
  detail = false,
}: {
  config: AppConfig;
  detail?: boolean;
}) {
  const catalog = useHostCatalog(useApiClient(config));
  const { problemId } = useParams<{ problemId: string }>();
  const t = useT();
  if (catalog.loading) return <StatusIndicator type="loading">{t("app.loading")}</StatusIndicator>;
  if (catalog.error)
    return (
      <Alert type="error" header={t("local_host.catalog_error_header")}>
        {catalog.error}
      </Alert>
    );
  return detail ? (
    <ProblemDetailPage
      config={config}
      supportedProblemIds={catalog.supported}
      organizerContent={problemId ? catalog.content?.get(problemId) : undefined}
    />
  ) : (
    <ProblemsPage
      localHost
      supportedProblemIds={catalog.supported}
      organizerContent={catalog.content}
    />
  );
}
