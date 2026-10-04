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
import type { EventLimits } from "../../config";
import type { ProblemDetail } from "../../data/problems";
import { useT } from "../../i18n";

interface HostLimits {
  readonly maxTeams: number;
  readonly maxEventJobs: number;
}
const LEGACY_LIMITS: HostLimits = { maxTeams: 40, maxEventJobs: 40 };

interface HostCatalogResponse {
  readonly limits?: HostLimits;
  readonly items: readonly {
    readonly problemId: string;
    readonly runtime: string;
    readonly content?: Pick<ProblemDetail, "description" | "learningGoals" | "i18n">;
  }[];
}

export interface HostCatalog {
  /** Problem IDs the host can run; empty until loaded (nothing is selectable meanwhile). */
  readonly supported: ReadonlySet<string>;
  readonly cloud: ReadonlySet<string>;
  readonly error: string | null;
  readonly loading: boolean;
  readonly limits: HostLimits;
  readonly content?: ReadonlyMap<
    string,
    Pick<ProblemDetail, "description" | "learningGoals" | "i18n">
  >;
}

const EMPTY: ReadonlySet<string> = new Set();

export function useHostCatalog(apiClient: ApiClient | null): HostCatalog {
  const [supported, setSupported] = useState<ReadonlySet<string>>(EMPTY);
  const [cloud, setCloud] = useState<ReadonlySet<string>>(EMPTY);
  const [limits, setLimits] = useState<HostLimits>(LEGACY_LIMITS);
  const [content, setContent] = useState<HostCatalog["content"]>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!apiClient) return;
    let active = true;
    setLoading(true);
    apiClient
      .get<HostCatalogResponse>("host/catalog")
      .then((response) => {
        if (!active) return;
        setLimits(response.limits ?? LEGACY_LIMITS);
        setContent(
          new Map(
            response.items.flatMap((item) =>
              item.content ? [[item.problemId, item.content]] : [],
            ),
          ),
        );
        setSupported(new Set(response.items.map((item) => item.problemId)));
        setCloud(
          new Set(
            response.items
              .filter((item) => item.runtime === "cloudformation")
              .map((item) => item.problemId),
          ),
        );
        setError(null);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(toErrorMessage(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [apiClient]);
  return { supported, cloud, content, error, limits, loading };
}

function LocalHostEventCreateNotice({
  catalog,
  jobCountInvalid,
}: {
  readonly catalog: HostCatalog;
  readonly jobCountInvalid: boolean;
}) {
  const t = useT();
  return (
    <>
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
  cloudLimits: EventLimits | undefined,
) {
  const maxTeams = local
    ? Math.min(
        catalog.limits.maxTeams,
        Math.floor(catalog.limits.maxEventJobs / Math.max(1, problems)),
      )
    : (cloudLimits?.maxTeams ?? 0);
  const maxProblems = local
    ? Math.min(catalog.supported.size, Math.floor(catalog.limits.maxEventJobs / Math.max(1, teams)))
    : (cloudLimits?.maxProblems ?? 0);
  return {
    maxTeams,
    maxProblems,
    available: local || cloudLimits !== undefined,
    problemCountInvalid: problems > maxProblems,
    teamCountInvalid: teams < 1 || teams > maxTeams,
    jobCountInvalid: local && teams * problems > catalog.limits.maxEventJobs,
  };
}

export function EventCreateCapacityNotice({
  local,
  catalog,
  capacity,
}: {
  readonly local: boolean;
  readonly catalog: HostCatalog;
  readonly capacity: ReturnType<typeof eventCapacity>;
}) {
  const t = useT();
  return (
    <>
      {local && (
        <LocalHostEventCreateNotice catalog={catalog} jobCountInvalid={capacity.jobCountInvalid} />
      )}
      {!capacity.available && <Alert type="error">{t("event_create.limits_unavailable")}</Alert>}
      {capacity.available && capacity.problemCountInvalid && (
        <Alert type="error">
          {t("event_create.problem_count_invalid", { max: capacity.maxProblems })}
        </Alert>
      )}
    </>
  );
}
