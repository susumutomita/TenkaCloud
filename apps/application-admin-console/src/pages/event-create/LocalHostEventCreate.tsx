/**
 * Issue #3226: the local competition host's additions to the normal event-creation page.
 *
 * The host serves `GET /host/catalog`: the problems it can run for competitors on this
 * computer. The page keeps its normal catalog, search and team table; only these problems
 * are selectable, and the organizer is told why others are not.
 */
import Alert from "@cloudscape-design/components/alert";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client";
import { useT } from "../../i18n";

interface HostCatalogResponse {
  readonly items: readonly { readonly problemId: string }[];
}

export interface HostCatalog {
  /** Problem IDs the host can run; empty until loaded (nothing is selectable meanwhile). */
  readonly supported: ReadonlySet<string>;
  readonly error: string | null;
}

const EMPTY: ReadonlySet<string> = new Set();

export function useHostCatalog(apiClient: ApiClient | null): HostCatalog {
  const [supported, setSupported] = useState<ReadonlySet<string>>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!apiClient) return;
    let active = true;
    apiClient
      .get<HostCatalogResponse>("host/catalog")
      .then((response) => {
        if (!active) return;
        setSupported(new Set(response.items.map((item) => item.problemId)));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (active) setError(toErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [apiClient]);
  return { supported, error };
}

export function LocalHostEventCreateNotice({ catalog }: { readonly catalog: HostCatalog }) {
  const t = useT();
  return (
    <>
      <Alert type="info" header={t("local_host.create_header")}>
        {t("local_host.create_body")}
      </Alert>
      {catalog.error && (
        <Alert type="error" header={t("local_host.catalog_error_header")}>
          {catalog.error}
        </Alert>
      )}
    </>
  );
}
