/**
 * [Issue #2527 Slice 1] Teams aggregate — domain record and repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

/**
 * Team aggregate の domain shape。 物理 DDB キー (PK / SK / GSI1PK /
 * GSI1SK) は DynamoDB backend の実装詳細であり、 SQLite backend
 * (Turso / D1) は独自のキー / カラムを導出する。
 *
 * [Issue #2527 Slice 1 step 2] Source of truth: the physical row
 * (`handlers/event-handler/types.ts`'s `TeamItem`) derives from this record by
 * adding the physical keys and re-requiring `teamLoginKey` — team 属性を 1 つ
 * 追加するときはこの record に足せば handler 層へ流れる (逆方向はない)。
 */
export type TeamRecord = {
  eventId: string;
  teamId: string;
  tenantId: string;
  /** 競技者が portal `PATCH /portal/me` で設定する表示名。未設定時は internalSlug を使う。 */
  displayName?: string;
  /** operator 入力 (or 自動生成) の内部 slug。CFn StackName 由来になる、deploy 後 immutable。 */
  internalSlug: string;
  /**
   * 短命 bearer。team scope (1 key で event 内 N 問題にアクセス可)。
   * Stored in the Team aggregate for operator redistribution. Participant-facing
   * and viewer-facing HTTP contracts must omit it unless an authorized operator
   * explicitly requests the credential expansion.
   */
  readonly teamLoginKey?: string;
  /** #528: team の deploy 先 AWS Account ID (12 桁数字)。Bulk Deploy で problem.defaultRegion と
   *  組み合わせて使う。旧 Event は持たない (= bulk-deploy で problem.defaultAwsAccountId に fallback)。 */
  awsAccountId?: string;
  /** #2563: Non-AWS deploy credential teamSlug selected in EventCreate. */
  nonAwsCredentialTeamSlug?: string;
  /**
   * [Issue #3173] Where this team's stacks go, overriding the problem's
   * `defaultRegion`.
   *
   * Region used to be decided once per problem and applied to every team, so a
   * whole event landed in one account and one region and met that region's
   * service limits — VPCs, EIPs, Lambda concurrency — before it met anything
   * else. Spreading teams across regions is the ordinary answer, and the
   * deployment row already stores a region per deployment; only the plan had it
   * fixed. Absent means "use the problem's", which is every existing event.
   */
  region?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
};

/**
 * Internal participant credential handed from the Teams aggregate to deployment
 * planning. SQL exposes only the already-derived SHA-256 digest; DynamoDB exposes
 * the legacy plaintext value. This type never crosses an HTTP response boundary.
 */
export type TeamLoginCredential =
  | { readonly kind: "plaintext"; readonly value: string }
  | { readonly kind: "sha256"; readonly value: string };

/** Team metadata plus the credential material required to build deployment indexes. */
export type TeamDeploymentRecord = Omit<TeamRecord, "teamLoginKey"> & {
  readonly credential: TeamLoginCredential;
};

export interface TeamLoginKeyRotationInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly newLoginKey: string;
  /** Team version read before rotation; prevents two callers from both succeeding. */
  readonly expectedUpdatedAt: string;
  readonly updatedAt: string;
  readonly deployments: readonly {
    readonly jobId: string;
    readonly createdAt: string;
  }[];
}

export type TeamLoginKeyRotationOutcome = { readonly outcome: "updated" | "conflict" };

/**
 * Aggregate-scoped repository for the Teams aggregate — domain
 * methods, not a generic key-value shim (mirror of {@link EventsRepository}). Two
 * interchangeable backends implement it: {@link DynamoDbTeamsRepository} (status
 * quo, the default) and {@link SqlTeamsRepository} (one SQL layer, SQLite dialect
 * for Turso / D1). Selection happens at cold start via the `CONTROL_DATA_BACKEND`
 * flag through {@link createTeamsRepository}.
 *
 * すべてのメソッドは既存の実アクセスパターン (create.ts の team 書込み /
 * event-handler/list.ts の team 一覧 / bulk-deploy の credential 供給) に
 * 対応する — 投機的な API は 1 つも含まない。 [Issue #2674] participant の
 * teamLoginKey 認証は Deployments aggregate (`listByTeamLoginKey`) が正本であり、
 * Teams 側に login-key lookup は存在しない。
 */
export interface TeamsRepository {
  /**
   * Tenant-scoped point read. Returns `undefined` when the team is absent or
   * belongs to a different tenant (404-equivalent, never leaks another tenant's
   * row). Tenant / event / team の 3 段スコープで 1 行を引く。
   */
  getTeam(tenantId: string, eventId: string, teamId: string): Promise<TeamRecord | undefined>;
  /**
   * すべての team を 1 event 分だけ返す (DynamoDB では
   * `PK = EVENT#<eventId> AND begins_with(SK, "TEAM#")` の base-table query)。
   * teamId 昇順で並べ、 backend 間で決定的な順序を保証する。
   */
  listTeamsByEvent(eventId: string): Promise<readonly TeamRecord[]>;
  /**
   * Deployment-only view. Unlike {@link listTeamsByEvent}, this fails loudly if
   * a row has no participant credential and returns only the backend-neutral
   * credential plus non-secret team metadata.
   */
  listTeamsForDeployment(eventId: string): Promise<readonly TeamDeploymentRecord[]>;
  /** Atomically rotate the team row and every denormalized deployment login index. */
  rotateLoginKey(input: TeamLoginKeyRotationInput): Promise<TeamLoginKeyRotationOutcome>;
  /** Upsert one team row. */
  putTeam(record: TeamRecord): Promise<void>;
  /** Delete one team row by its event/team domain identifiers. */
  deleteTeam(eventId: string, teamId: string): Promise<void>;
  /**
   * TTL-equivalent sweep: delete teams whose `expiresAt` (epoch seconds, `> 0`)
   * is at or before `nowEpochSeconds`, and return the number deleted. DynamoDB has
   * native TTL; the SQLite backends have none and rely on this being
   * run on a schedule (mirror of {@link EventsRepository.pruneExpired}).
   */
  pruneExpired(nowEpochSeconds: number): Promise<number>;
}
