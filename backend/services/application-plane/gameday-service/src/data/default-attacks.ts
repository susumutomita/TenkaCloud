import type { Attack, AttackType } from '../types';

export const DEFAULT_ATTACKS: Omit<Attack, 'id'>[] = [
  {
    name: 'SQL Injection',
    slug: 'sql-injection',
    attackType: 'vulnerability' as AttackType,
    targetVulnerability: 'sql-injection',
    description:
      'f-string SQLを悪用してデータベースに不正アクセスする。パラメータ化クエリで防御可能。',
    purchaseCost: 3000,
    damage: 1000,
    reward: 1000,
    cooldownSeconds: 300,
    defenseHint:
      'SQLクエリでf-stringを使っている箇所をパラメータ化クエリに変更する',
    hintCost: 0,
  },
  {
    name: 'Remote Code Execution',
    slug: 'remote-code-execution',
    attackType: 'vulnerability' as AttackType,
    targetVulnerability: 'backdoor',
    description:
      '/backdoor ルートを悪用してリモートコードを実行する。ルートの削除で防御可能。',
    purchaseCost: 3000,
    damage: 1000,
    reward: 1000,
    cooldownSeconds: 300,
    defenseHint: '/backdoor ルートを完全に削除する',
    hintCost: 0,
  },
  {
    name: 'Password Rotation',
    slug: 'password-rotation',
    attackType: 'vulnerability' as AttackType,
    targetVulnerability: 'hardcoded-password',
    description:
      'ハードコードされたDBパスワードを悪用する。Secrets Manager使用で防御可能。',
    purchaseCost: 3000,
    damage: 1000,
    reward: 1000,
    cooldownSeconds: 300,
    defenseHint:
      'get_db_connection()内のハードコードパスワードをSecrets Managerに変更する',
    hintCost: 3000,
  },
  {
    name: 'SSRF Attack',
    slug: 'ssrf-attack',
    attackType: 'vulnerability' as AttackType,
    targetVulnerability: 'ssrf',
    description:
      '/api/v1/proxy の任意URLリクエストを悪用する。URL検証で防御可能。',
    purchaseCost: 3000,
    damage: 1000,
    reward: 1000,
    cooldownSeconds: 300,
    defenseHint:
      '/api/v1/proxy にURLホワイトリスト検証を追加し内部IPをブロックする',
    hintCost: 3000,
  },
  {
    name: 'Leaked Credentials',
    slug: 'leaked-credentials',
    attackType: 'vulnerability' as AttackType,
    targetVulnerability: 'leaked-credentials',
    description:
      'ハードコードパスワードやSSRF経由で認証情報を窃取する。パスワード除去とSSRF修正で防御可能。',
    purchaseCost: 3000,
    damage: 1000,
    reward: 1000,
    cooldownSeconds: 300,
    defenseHint: 'ソースコードからハードコードパスワードを除去しSSRFを修正する',
    hintCost: 3000,
  },
  {
    name: 'HA/Resilience Attack',
    slug: 'ha-resilience',
    attackType: 'chaos' as AttackType,
    targetVulnerability: null,
    description:
      'インフラ障害をシミュレートして可用性をテストする。Auto ScalingとMulti-AZ構成で緩和可能。',
    purchaseCost: 3000,
    damage: 1000,
    reward: 1000,
    cooldownSeconds: 300,
    defenseHint:
      'Auto Scaling GroupとLaunch Templateを設定しMulti-AZ構成にする',
    hintCost: 3000,
  },
];
