import type { Attack, AttackType } from "../types";

export const DEFAULT_ATTACKS: Omit<Attack, "id">[] = [
	{
		name: "SQL Injection",
		slug: "sql-injection",
		attackType: "vulnerability" as AttackType,
		targetVulnerability: "sql-injection",
		description:
			"f-string SQLを悪用してデータベースに不正アクセスする。パラメータ化クエリで防御可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint:
			"SQLクエリでf-stringを使っている箇所をパラメータ化クエリに変更する",
		hintCost: 0,
	},
	{
		name: "Remote Code Execution",
		slug: "remote-code-execution",
		attackType: "vulnerability" as AttackType,
		targetVulnerability: "backdoor",
		description:
			"/backdoor ルートを悪用してリモートコードを実行する。ルートの削除で防御可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint: "/backdoor ルートを完全に削除する",
		hintCost: 0,
	},
	{
		name: "Password Rotation",
		slug: "password-rotation",
		attackType: "vulnerability" as AttackType,
		targetVulnerability: "hardcoded-password",
		description:
			"ハードコードされたDBパスワードを悪用する。Secrets Manager使用で防御可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint:
			"get_db_connection()内のハードコードパスワードをSecrets Managerに変更する",
		hintCost: 3000,
	},
	{
		name: "SSRF Attack",
		slug: "ssrf-attack",
		attackType: "vulnerability" as AttackType,
		targetVulnerability: "ssrf",
		description:
			"/api/v1/proxy の任意URLリクエストを悪用する。URL検証で防御可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint:
			"/api/v1/proxy にURLホワイトリスト検証を追加し内部IPをブロックする",
		hintCost: 3000,
	},
	{
		name: "Leaked Credentials",
		slug: "leaked-credentials",
		attackType: "vulnerability" as AttackType,
		targetVulnerability: "leaked-credentials",
		description:
			"ハードコードパスワードやSSRF経由で認証情報を窃取する。パスワード除去とSSRF修正で防御可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint: "ソースコードからハードコードパスワードを除去しSSRFを修正する",
		hintCost: 3000,
	},
	{
		name: "HA/Resilience Attack",
		slug: "ha-resilience",
		attackType: "chaos" as AttackType,
		targetVulnerability: null,
		description:
			"インフラ障害をシミュレートして可用性をテストする。Auto ScalingとMulti-AZ構成で緩和可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint:
			"Auto Scaling GroupとLaunch Templateを設定しMulti-AZ構成にする",
		hintCost: 3000,
	},
	{
		name: "Backdoor",
		slug: "backdoor",
		attackType: "vulnerability" as AttackType,
		targetVulnerability: "backdoor-route",
		description:
			"隠しエンドポイントを悪用してシステムに不正アクセスする。不要なルートの削除で防御可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint:
			"アプリケーションの隠しルート・デバッグエンドポイントを特定して削除する",
		hintCost: 3000,
	},
	{
		name: "Compromised Website",
		slug: "compromised-website",
		attackType: "vulnerability" as AttackType,
		targetVulnerability: "website-defacement",
		description:
			"Webサイトを改竄して不正なコンテンツを表示させる。WAFとコンテンツ整合性チェックで防御可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint: "CloudFront + WAFを設定しS3バケットポリシーを適切に制限する",
		hintCost: 3000,
	},
	{
		name: "Data Exfiltration",
		slug: "data-exfiltration",
		attackType: "vulnerability" as AttackType,
		targetVulnerability: "data-leak",
		description:
			"機密データを外部に持ち出す。VPCエンドポイント・S3バケットポリシー・CloudTrailで防御可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint:
			"S3バケットポリシーでVPC外アクセスを制限しCloudTrailでデータアクセスを監視する",
		hintCost: 3000,
	},
	{
		name: "EC2 System Status Check Failed",
		slug: "ec2-system-status-check-failed",
		attackType: "chaos" as AttackType,
		targetVulnerability: null,
		description:
			"EC2インスタンスのシステムステータスチェックを失敗させる。Auto RecoveryとMulti-AZ配置で緩和可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint:
			"EC2 Auto RecoveryまたはAuto Scaling Groupを設定しMulti-AZ配置にする",
		hintCost: 3000,
	},
	{
		name: "Hacked Bucket",
		slug: "hacked-bucket",
		attackType: "vulnerability" as AttackType,
		targetVulnerability: "open-s3-bucket",
		description:
			"公開設定のS3バケットに不正アクセスする。バケットポリシーとBlock Public Accessで防御可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint:
			"S3 Block Public Accessを有効にしバケットポリシーで最小権限を設定する",
		hintCost: 3000,
	},
	{
		name: "MHCS",
		slug: "mhcs",
		attackType: "chaos" as AttackType,
		targetVulnerability: null,
		description:
			"ヘルスチェック障害を注入してロードバランサーからインスタンスを切り離す。ヘルスチェック設定の最適化で緩和可能。",
		purchaseCost: 3000,
		damage: 1000,
		reward: 1000,
		cooldownSeconds: 300,
		defenseHint:
			"ALBヘルスチェックの閾値・間隔を適切に設定しMulti-AZ配置にする",
		hintCost: 3000,
	},
];
