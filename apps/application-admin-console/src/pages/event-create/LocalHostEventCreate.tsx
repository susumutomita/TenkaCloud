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

interface HostLimits {
  readonly maxTeams: number;
  readonly maxEventJobs: number;
}
const LEGACY_LIMITS: HostLimits = { maxTeams: 40, maxEventJobs: 40 };

interface HostCatalogResponse {
  readonly limits?: HostLimits;
  readonly items: readonly { readonly problemId: string; readonly runtime: string }[];
}

export interface HostCatalog {
  /** Problem IDs the host can run; empty until loaded (nothing is selectable meanwhile). */
  readonly supported: ReadonlySet<string>;
  readonly cloud: ReadonlySet<string>;
  readonly error: string | null;
  readonly limits: HostLimits;
}

const EMPTY: ReadonlySet<string> = new Set();

export function useHostCatalog(apiClient: ApiClient | null): HostCatalog {
  const [supported, setSupported] = useState<ReadonlySet<string>>(EMPTY);
  const [cloud, setCloud] = useState<ReadonlySet<string>>(EMPTY);
  const [limits, setLimits] = useState<HostLimits>(LEGACY_LIMITS);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!apiClient) return;
    let active = true;
    apiClient
      .get<HostCatalogResponse>("host/catalog")
      .then((response) => {
        if (!active) return;
        setLimits(response.limits ?? LEGACY_LIMITS);
        setSupported(new Set(response.items.map((item) => item.problemId)));
        setCloud(
          new Set(
            response.items
              .filter((item) => item.runtime === "cloudformation")
              .map((item) => item.problemId),
          ),
        );
        setError(null);
      })
      .catch((cause: unknown) => {
        if (active) setError(toErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [apiClient]);
  return { supported, cloud, error, limits };
}

export function LocalHostEventCreateNotice({
  catalog,
  jobCountInvalid,
}: {
  readonly catalog: HostCatalog;
  readonly jobCountInvalid: boolean;
}) {
  const t = useT();
  return (
    <>
      <Alert type="info" header={t("local_host.create_header")}>
        {t("local_host.create_body", { ...catalog.limits })}
      </Alert>
      {jobCountInvalid && (
        <Alert type="error">
          {t("local_host.job_count_invalid", { max: catalog.limits.maxEventJobs })}
        </Alert>
      )}
      {catalog.error && (
        <Alert type="error" header={t("local_host.catalog_error_header")}>
          {catalog.error}
        </Alert>
      )}
    </>
  );
}

/** One capacity decision feeds the form and its description. */
export function eventCapacity(
  local: boolean,
  catalog: HostCatalog,
  teams: number,
  problems: number,
  cloudMaxTeams: number,
) {
  const maxTeams = local ? catalog.limits.maxTeams : cloudMaxTeams;
  return {
    maxTeams,
    teamCountInvalid: teams < 1 || teams > maxTeams,
    jobCountInvalid: local && teams * problems > catalog.limits.maxEventJobs,
  };
}
