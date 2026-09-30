import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterType,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import { isParameterNotFound } from "./ssm-parameter.js";

/**
 * [#1412 #1410] per-team の機密設定を SSM SecureString に保管する汎用ストア。
 *
 * Sakura API key / Azure client secret など、 provider 別の「per-team な JSON 機密を SecureString で
 * 保管し、 未登録 / 復号不能なら fail-safe に undefined を返し、 delete は idempotent」という共通形を
 * 1 箇所に集約する (= DRY / SRP)。 provider 固有なのは path 規約 (`buildName`) と JSON ⇔ 型の
 * parse / serialize だけなので、 それらを注入する factory にする。
 *
 * KMS は AWS managed (`alias/aws/ssm`、 コスト 0)。 `secrets-manager-forbidden` 準拠で Secrets Manager は
 * 使わない。 `Overwrite: true` で put は register + rotation 兼用。
 */

export interface SecureJsonStoreDeps {
  readonly ssm: Pick<SSMClient, "send">;
  readonly env: string;
}

export interface SecureJsonStore<T> {
  /** 未登録 / 復号不能形式なら undefined (= fail-closed)。 */
  get(deps: SecureJsonStoreDeps, tenantId: string, teamSlug: string): Promise<T | undefined>;
  /** register + rotation 兼用 (Overwrite: true)。 */
  put(deps: SecureJsonStoreDeps, tenantId: string, teamSlug: string, value: T): Promise<void>;
  /** 不在は no-op (= idempotent)。 */
  delete(deps: SecureJsonStoreDeps, tenantId: string, teamSlug: string): Promise<void>;
}

export interface SecureJsonStoreConfig<T> {
  /** `/{env}/tenants/{tenantId}/teams/{teamSlug}/...` 形の SSM path を組む。 */
  readonly buildName: (env: string, tenantId: string, teamSlug: string) => string;
  /** SSM から読んだ生文字列を型 T に narrow (= 自前保管形式の fail-safe parse)。 不正なら undefined。 */
  readonly parse: (raw: string | undefined) => T | undefined;
  /** 型 T を保管用 JSON 文字列に整形。 */
  readonly serialize: (value: T) => string;
}

export function createSecureJsonStore<T>(config: SecureJsonStoreConfig<T>): SecureJsonStore<T> {
  return {
    async get(deps, tenantId, teamSlug) {
      const name = config.buildName(deps.env, tenantId, teamSlug);
      try {
        const out = await deps.ssm.send(
          new GetParameterCommand({ Name: name, WithDecryption: true }),
        );
        return config.parse(out.Parameter?.Value);
      } catch (err) {
        if (isParameterNotFound(err)) return undefined;
        throw err;
      }
    },
    async put(deps, tenantId, teamSlug, value) {
      const name = config.buildName(deps.env, tenantId, teamSlug);
      await deps.ssm.send(
        new PutParameterCommand({
          Name: name,
          Value: config.serialize(value),
          Type: ParameterType.SECURE_STRING,
          Overwrite: true,
          // KMS は AWS managed (alias/aws/ssm)。 明示 KeyId を渡さないと SSM が自動採用 (= コスト 0)。
        }),
      );
    },
    async delete(deps, tenantId, teamSlug) {
      const name = config.buildName(deps.env, tenantId, teamSlug);
      try {
        await deps.ssm.send(new DeleteParameterCommand({ Name: name }));
      } catch (err) {
        if (isParameterNotFound(err)) return;
        throw err;
      }
    },
  };
}

/** 1 tenant の per-team 機密がすべて入る SSM path (`/{env}/tenants/{tenantId}/teams`)。 */
export function buildTenantTeamsPath(env: string, tenantId: string): string {
  return `/${env}/tenants/${tenantId}/teams`;
}

/**
 * IAM policy 用の {@link buildTenantTeamsPath} pattern。 `GetParametersByPath` は返す parameter ではなく
 * 要求した path に対して認可されるので、 resource はこの path 自体になる。
 */
export function buildTenantTeamsPathArnPattern(
  region: string,
  account: string,
  env: string,
): string {
  return `arn:aws:ssm:${region}:${account}:parameter/${env}/tenants/*/teams`;
}

/**
 * parameter が存在するか。 復号も parse もしないので、 壊れた値の parameter も「存在する」と答える。
 */
export async function secureParameterExists(
  deps: SecureJsonStoreDeps,
  name: string,
): Promise<boolean> {
  try {
    const out = await deps.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }));
    return out.Parameter !== undefined;
  } catch (err) {
    if (isParameterNotFound(err)) return false;
    throw err;
  }
}

/**
 * tenant の per-team 機密のうち、 名前が `nameSuffix` で終わるものを数える。 `stopAt` に達したら
 * それ以上 page を読まない (= 上限判定に要る分だけ SSM を呼ぶ)。 値は復号しない。
 */
export async function countTenantTeamParameters(
  deps: SecureJsonStoreDeps,
  tenantId: string,
  nameSuffix: string,
  stopAt: number,
): Promise<number> {
  let count = 0;
  let nextToken: string | undefined;
  do {
    const out = await deps.ssm.send(
      new GetParametersByPathCommand({
        Path: buildTenantTeamsPath(deps.env, tenantId),
        Recursive: true,
        WithDecryption: false,
        NextToken: nextToken,
      }),
    );
    count += (out.Parameters ?? []).filter((p) => p.Name?.endsWith(nameSuffix)).length;
    nextToken = out.NextToken;
  } while (nextToken !== undefined && count < stopAt);
  return count;
}
