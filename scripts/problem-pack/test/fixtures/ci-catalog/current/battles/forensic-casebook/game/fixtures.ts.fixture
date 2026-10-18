/** SERVER ONLY: evidence construction and answer predicates. Never import this from portal/. */
import { endpointCase } from "./endpoint.ts";
import { createHash, createHmac } from "node:crypto";
import type { Case, Evidence, Localized, State } from "./types.ts";
export const L = (ja: string, en: string): Localized => ({ ja, en });
export interface PrivateQuestion {
	id: string;
	prompt: Localized;
	format: Localized;
	points: number;
	hints: Localized[];
	explanation: Localized;
	expected: string;
	citations: string[];
	unordered?: boolean;
}
export interface PrivateCase {
	id: string;
	title: Localized;
	intro: Localized;
	evidence: Evidence[];
	questions: PrivateQuestion[];
}
export const evidence = (
	id: string,
	name: string,
	description: Localized,
	body: unknown,
): Evidence => {
	const content =
		JSON.stringify({ synthetic: true, ...(body as object) }, null, 2) + "\n";
	return {
		id,
		name,
		description,
		content,
		sha256: createHash("sha256").update(content, "utf8").digest("hex"),
	};
};
export const q = (
	id: string,
	points: number,
	prompt: Localized,
	format: Localized,
	expected: string,
	citations: string[],
	hints: Localized[],
	explanation: Localized,
	unordered = false,
): PrivateQuestion => ({
	id,
	points,
	prompt,
	format,
	expected,
	citations,
	hints,
	explanation,
	unordered,
});
const scopeFormat = L(
	"半角で confirmed=確認済み一覧;unresolved=不明一覧 と入力。各一覧は対象名をカンマで区切り、順不同。",
	"Enter confirmed=confirmed-list;unresolved=unresolved-list using exact object names, comma-separated within each list. List order does not matter.",
);

export function buildCases(
	state: Pick<State, "eventId" | "matchSecret" | "generation"> & Partial<Pick<State, "teams">>,
	teamId: string,
): PrivateCase[] {
	// Domain-separated, length-unambiguous server secret derivation. No public-seed fallback.
	const digest = (label: string) =>
		createHmac("sha256", state.matchSecret)
			.update(
				JSON.stringify([
					"forensic-casebook-v1",
					state.eventId,
					teamId,
					state.generation,
					label,
				]),
			)
			.digest("hex");
	const n = (label: string, min: number, range: number) =>
		min + (parseInt(digest(label).slice(0, 8), 16) % range);
	const tag = digest("label").slice(0, 8);
	const account = `analyst-${tag}@aster.example`;
	const session = `sess-${digest("session").slice(0, 10)}`;
	const role = `ops-admin-${tag}`;
	const incident = `case-${tag}`;
	const base = Date.UTC(2026, 4, 18, 3, n("minute", 10, 20), 0);
	const iso = (minutes: number) =>
		new Date(base + minutes * 60000).toISOString().replace(".000Z", "Z");
	const jst = (minutes: number) =>
		new Date(base + (minutes + 540) * 60000)
			.toISOString()
			.replace(".000Z", "+09:00");
	const ids = {
		sign: `E-${digest("sign").slice(0, 6)}`,
		policy: `E-${digest("policy").slice(0, 6)}`,
		get: `E-${digest("get").slice(0, 6)}`,
		send: `E-${digest("send").slice(0, 6)}`,
	};
	const objects = [
		`reports/${tag}-orders.csv`,
		`reports/${tag}-customers.csv`,
		`reports/${tag}-payroll.csv`,
	];
	const bytes1 = n("bytes1", 2, 7) * 1024;
	const bytes2 = n("bytes2", 3, 8) * 1024;
	const chunk1 = bytes1 / 2;
	const r1 = `req-${digest("r1").slice(0, 8)}`,
		r2 = `req-${digest("r2").slice(0, 8)}`,
		r3 = `req-${digest("r3").slice(0, 8)}`;
	const hash = (value: string) =>
		createHash("sha256").update(value).digest("hex");
	const d1 = hash(`synthetic-orders-${digest("body1")}`),
		d2 = hash(`synthetic-customers-${digest("body2")}`),
		d3 = hash(`synthetic-payroll-${digest("body3")}`);
	const copyNew = `copy-${digest("new").slice(0, 6)}`,
		copySafe = `copy-${digest("safe").slice(0, 6)}`,
		copyBad = `copy-${digest("bad").slice(0, 6)}`;
	const loss = n("loss", 11, 19);
	const manifest = hash(`clean-backup-${digest("manifest")}`);
	const idp = evidence(
		"I-IDP",
		"identity.json",
		L(
			"認証の記録。認証は、ログイン用の証明をサービスが受け入れたこと。",
			"Authentication log: the service accepted proof for a login.",
		),
		{
			incident,
			glossary: {
				ja: "account=アカウント名、session=ログイン後の操作を結ぶ番号、result=結果。accepted は認証成功。MFA は複数の方法での認証。",
				en: "account names the login identity; session links later actions; accepted means authentication succeeded. MFA means more than one authentication method.",
			},
			events: [
				{
					event_id: ids.sign,
					time: iso(0),
					account,
					session,
					result: "accepted",
					methods: ["password", "MFA"],
					source_ip: "192.0.2.41",
				},
				{
					event_id: "E-routine",
					time: iso(-15),
					account: `monitor-${tag}@aster.example`,
					session: "routine-session",
					result: "accepted",
					methods: ["service-key"],
					source_ip: "192.0.2.60",
				},
			],
		},
	);
	const cloud = evidence(
		"I-CLOUD",
		"control-plane.json",
		L(
			"管理操作の記録。API はソフトウェア同士が操作を頼む入口。",
			"Administrative action log. An API is an interface where software requests an action.",
		),
		{
			incident,
			glossary: {
				ja: "session=認証記録と共通の番号、assumed_role=使用した権限の組、operation=操作、success=システムが処理した。human_approval はこのログにはない。",
				en: "session joins to identity.json; assumed_role is the permissions used; success means the system executed the request, not that a human approved it.",
			},
			events: [
				{
					event_id: ids.policy,
					time: iso(2),
					session,
					assumed_role: role,
					operation: "EnableExternalExport",
					resource: `reports-${tag}`,
					result: "success",
					request_id: `control-${tag}`,
				},
			],
		},
	);
	const approvals = evidence(
		"I-APPROVAL",
		"change-approval.json",
		L(
			"業務として何が許可されていたかを示す記録。システム上できることとは区別する。",
			"Approved business change, separate from what technical permissions allow.",
		),
		{
			incident,
			owner: "Aster change board / 変更の承認担当",
			approved_account: account,
			window_utc: [iso(-5), iso(25)],
			approved_actions: ["ReadHealthStatus"],
			explicitly_prohibited_actions: ["EnableExternalExport", "DeleteBackup"],
			emergency_exception: "none",
			export_request: "rejected",
			scope_note: {
				ja: "この演習では、この承認記録が操作時点の完全な業務承認記録。",
				en: "For this exercise, this is the complete business-approval record at the time of the action.",
			},
		},
	);
	const limits = evidence(
		"I-LIMITS",
		"collection-notes.json",
		L(
			"記録を集めた範囲と限界。欠けた観測を確認する。",
			"Collection coverage and limitations. Check what was not observed.",
		),
		{
			incident,
			collected: [
				"identity provider",
				"control-plane audit",
				"change approvals",
			],
			not_collected: [
				"endpoint recording",
				"physical observer",
				"session-token custody history",
			],
			limitations: {
				ja: "共通 session は同じログイン後の証明が使われたことを結ぶ。アカウントの持ち主本人が端末を操作したか、盗まれた証明を別人が使ったかは、この資料だけでは区別できない。MFA の成功も、その後の操作担当者を特定しない。",
				en: "The shared session identifies the login proof used. These records cannot distinguish the account owner operating the device from another person using copied session proof. Successful MFA does not identify the person behind every later action.",
			},
		},
	);
	const identity: PrivateCase = {
		id: "identity",
		title: L(
			"01 認証は通った。変更は許可されていた？",
			"01 A valid login. An approved change?",
		),
		intro: L(
			"あなたは架空の Aster の調査担当です。外部への書き出し設定が変わりました。最初に identity.json を開き、account と session を探してください。次に同じ session を control-plane.json で結びます。ログは起きた操作を残した記録です。認証は『証明を受け入れた』、認可は『その操作を許す』こと。このケースではシステム上の権限と業務上の承認も分けます。証拠 ID はファイルを指す番号です。回答と、それを支える最小限のファイルの ID を一緒に送ると判定されます。余計なファイルの選択も不正解になります。全データは合成で、実在の事件や人物の記録ではありません。",
			"You investigate for fictional Aster. Its external-export setting changed. First open identity.json and find account and session. Then connect that session to control-plane.json. A log records observed actions. Authentication means accepting proof of identity; authorization means allowing an action. Here, distinguish technical permissions from business approval too. Evidence IDs identify files. Submit an answer with the smallest sufficient set of supporting file IDs; irrelevant extra citations also fail. All records are synthetic, not claims about real incidents or people.",
		),
		evidence: [idp, cloud, approvals, limits],
		questions: [
			q(
				"account",
				20,
				L(
					"外部書き出しの変更に使われた session は、どの account の認証で発行されましたか？ 認証記録と操作記録を両方引用してください。",
					"Which account's authentication issued the session used for the external-export change? Cite both the authentication and action records.",
				),
				L(
					"account の値をそのまま入力。例: analyst-demo@aster.example",
					"Enter the account value exactly, e.g. analyst-demo@aster.example.",
				),
				account,
				["I-IDP", "I-CLOUD"],
				[
					L(
						"session は、ログイン後の操作を結び付ける番号です。名前が似ているだけでは同じ操作担当とは言えません。",
						"A session identifier links a login to subsequent actions. Similar account names alone do not establish that link.",
					),
					L(
						"小さな例: 認証記録が account=A, session=S、操作記録が session=S なら、その操作では A に発行された証明が使われています。",
						"Small example: a login says account=A, session=S and an action says session=S. The action used the proof issued to A.",
					),
					L(
						"control-plane.json の EnableExternalExport 行の session を読む → identity.json の同じ session の行を探す → account を入力し、I-IDP と I-CLOUD を選んで送信する。正解で20点。",
						"Read the session on EnableExternalExport in control-plane.json → find the same session in identity.json → enter its account and cite I-IDP and I-CLOUD. Correct earns 20 points.",
					),
				],
				L(
					"同じ session で2種類の記録を結びました。これは利用されたアカウントの特定であり、操作した人の断定ではありません。",
					"The common session links two independent kinds of record. This identifies the account used, not necessarily the person operating it.",
				),
			),
			q(
				"authority",
				30,
				L(
					"設定変更は、変更時点の業務上の承認を得ていましたか？ 技術上の成功だけで判断せず、実際の操作と承認範囲を照合してください。",
					"Was the setting change approved as a business action at the time? Compare the actual action with the approved scope, rather than relying on technical success.",
				),
				L(
					"approved（承認済み）または unauthorized（承認なし）を入力。",
					"Enter approved or unauthorized.",
				),
				"unauthorized",
				["I-CLOUD", "I-APPROVAL"],
				[
					L(
						"技術上の権限は『実行できる』こと。業務承認は『してよいと決められた』こと。成功した操作も承認外になりえます。",
						"Technical permission means an operation can run. Business approval means it was agreed to be allowed. A successful operation can still be outside approval.",
					),
					L(
						"例: 『状態の閲覧』だけ承認されているのに『設定の変更』をした場合、成功していても業務の承認外です。",
						"Example: permission to view status does not approve a settings change, even when the system executes it successfully.",
					),
					L(
						"I-CLOUD の operation を I-APPROVAL の approved_actions と explicitly_prohibited_actions に照合する。例外の有無も確認し、指定語とこの2つの証拠を送信する。",
						"Compare operation in I-CLOUD with approved_actions and explicitly_prohibited_actions in I-APPROVAL. Check exceptions, then submit the chosen word and these two records.",
					),
				],
				L(
					"認証成功や広い管理権限は、個々の業務操作への承認を意味しません。この資料では設定変更は承認外でした。",
					"Successful authentication and broad administrative permissions do not approve every business action. This change was outside the approval record.",
				),
			),
			q(
				"attribution",
				50,
				L(
					"操作した人について、記録から守れる結論はどこまでですか？ 身元の証明が使われたことと、本人が操作したことを区別してください。",
					"What is the strongest defensible attribution to a person? Distinguish use of identity proof from proof that its owner operated it.",
				),
				L(
					"owner-proven（本人と断定）または session-used;human-unknown（session は特定、人は不明）を入力。認証・操作・収集範囲を引用。",
					"Enter owner-proven or session-used;human-unknown. Cite authentication, actions, and collection coverage.",
				),
				"session-used;human-unknown",
				["I-IDP", "I-CLOUD", "I-LIMITS"],
				[
					L(
						"帰属とは『誰の行為と言えるか』です。証明の利用を観測することと、現実の人を見ることは違います。",
						"Attribution asks whose action the evidence supports. Observing the use of login proof is different from observing a real person.",
					),
					L(
						"例: 鍵で扉が開いた記録は『その鍵が使われた』と示します。貸した鍵や盗まれた鍵なら、鍵の持ち主が開けたとは限りません。",
						"Example: a door log proves a key was used. A borrowed or copied key means its owner need not have opened the door.",
					),
					L(
						"I-IDP と I-CLOUD の共通 session を確認。I-LIMITS の not_collected と limitations を読み、本人を区別できる観測があるか判断。この3ファイルと、言い過ぎない結論を送る。",
						"Confirm the shared session in I-IDP and I-CLOUD. Read not_collected and limitations in I-LIMITS; decide whether a person can be distinguished. Cite all three and submit the defensible conclusion.",
					),
				],
				L(
					"session の使用は確認できても、端末や証明の管理状況を観測していないため、操作した人は断定できません。不明と言うことも調査成果です。",
					"Session use is established, but endpoint and proof-custody observations are missing. The human operator remains unknown. Recording that uncertainty is a finding, too.",
				),
			),
		],
	};
	const audit = evidence(
		"T-AUDIT",
		"timeline-audit.json",
		L(
			"認証と管理変更の時刻。末尾の Z はUTC、+09:00 はUTCより9時間進んだ時計。",
			"Login and administrative timestamps. Z is UTC; +09:00 is a clock nine hours ahead of UTC.",
		),
		{
			incident,
			time_guide: {
				ja: "同じ瞬間の例: 12:00+09:00 は 03:00Z。+09:00 の時刻から9時間を引く。全ての時計は照合済みで誤差1秒未満。",
				en: "Example: 12:00+09:00 is 03:00Z; subtract nine hours from a +09:00 clock. All clocks were checked and differ by less than one second.",
			},
			events: [
				{
					event_id: ids.policy,
					time: jst(2),
					action: "EnableExternalExport",
					session,
					result: "success",
				},
				{
					event_id: ids.sign,
					time: iso(0),
					action: "LoginAccepted",
					session,
					result: "success",
				},
			],
		},
	);
	const objectLog = evidence(
		"T-OBJECT",
		"object-access.json",
		L(
			"ファイルを読んだ記録。読むことと外部に送ることは別の操作。",
			"Object reads. Reading a file and sending it outside are separate actions.",
		),
		{
			incident,
			glossary: {
				ja: "object=保存ファイル名、request_id=操作を結ぶ番号、bytes=データ量の単位、sha256=内容を比較する印。status=200 は読取成功、403 は拒否。",
				en: "object is a stored file name; request_id links an operation; bytes measures data size; sha256 is a content-comparison fingerprint; status 200 is a successful read and 403 is denied.",
			},
			events: [
				{
					event_id: `E-denied-${tag}`,
					time: iso(7),
					session,
					request_id: `denied-${tag}`,
					object: `reports/${tag}-secrets.csv`,
					status: 403,
					body_bytes: 0,
				},
				{
					event_id: ids.get,
					time: jst(4),
					session,
					request_id: r1,
					object: objects[0],
					status: 200,
					body_bytes: bytes1,
					sha256: d1,
				},
				{
					event_id: `E-read2-${tag}`,
					time: iso(5),
					session,
					request_id: r2,
					object: objects[1],
					status: 200,
					body_bytes: bytes2,
					sha256: d2,
				},
				{
					event_id: `E-read3-${tag}`,
					time: iso(8),
					session,
					request_id: r3,
					object: objects[2],
					status: 200,
					body_bytes: 9216,
					sha256: d3,
				},
			],
		},
	);
	const receipt1 = {
		receipt_id: `receipt-${tag}-1`,
		event_id: ids.send,
		time: iso(5),
		request_id: r1,
		object_sha256: d1,
		range_start: 0,
		range_end_exclusive: chunk1,
		acknowledged_body_bytes: chunk1,
		destination: "receiver.example",
		status: "received",
	};
	const network = evidence(
		"T-NET",
		"outbound-receipts.json",
		L(
			"外部受信側が受け取った範囲の記録。重複行や接続全体の大きさに注意。",
			"Records of byte ranges received outside. Watch for duplicated rows and whole-connection sizes.",
		),
		{
			incident,
			provenance: {
				ja: "演習の外部受信側から保全した合成記録。object_sha256 は受信側が再構成した全内容から計算した指紋で、送信側の申告ではない。time は各範囲の受領時刻。request_id と object_sha256 の両方で読取と内容を結ぶ。範囲 [start,end) の量は end−start。例 [0,3) は3バイト。",
				en: "Synthetic records preserved from the exercise's outside receiver. The receiver computed object_sha256 from reassembled complete content; it is not a sender-supplied claim. time records each range's arrival. Both request_id and object_sha256 link the read and content. A [start,end) range contains end−start bytes: [0,3) contains three bytes.",
			},
			glossary: {
				ja: "receipt_id=受領記録番号。同じ番号の再掲載は1回だけ数える。acknowledged_body_bytes=相手が受け取った本体の量。connection_total_bytes は制御通信も含み、本体だけの量ではない。",
				en: "receipt_id identifies a receipt; duplicated listings count once. acknowledged_body_bytes is body data acknowledged by the receiver. connection_total_bytes also includes control traffic, not just file content.",
			},
			connection_total_bytes: bytes1 + bytes2 + 1024 + 9216 + 897,
			receipts: [
				{
					receipt_id: `receipt-${tag}-3`,
					event_id: `E-send3-${tag}`,
					time: iso(6),
					request_id: r2,
					object_sha256: d2,
					range_start: 0,
					range_end_exclusive: bytes2,
					acknowledged_body_bytes: bytes2,
					destination: "receiver.example",
					status: "received",
				},
				receipt1,
				{
					receipt_id: `receipt-${tag}-2`,
					event_id: `E-send2-${tag}`,
					time: iso(6),
					request_id: r1,
					object_sha256: d1,
					range_start: chunk1,
					range_end_exclusive: bytes1,
					acknowledged_body_bytes: chunk1,
					destination: "receiver.example",
					status: "received",
				},
				{
					receipt_id: `receipt-${tag}-overlap`,
					event_id: `E-overlap-${tag}`,
					time: iso(6),
					request_id: r1,
					object_sha256: d1,
					range_start: chunk1 - 512,
					range_end_exclusive: chunk1 + 512,
					acknowledged_body_bytes: 1024,
					destination: "receiver.example",
					status: "received",
				},
				{
					receipt_id: `receipt-${tag}-mismatch`,
					event_id: `E-other-${tag}`,
					time: iso(9),
					request_id: r3,
					object_sha256: hash(`different-content-${tag}`),
					range_start: 0,
					range_end_exclusive: 9216,
					acknowledged_body_bytes: 9216,
					destination: "receiver.example",
					status: "received",
					collection_note:
						"Partial buffer recovered during collector outage. / 収集停止中の一部記録だけを後から回収。",
				},
				{
					...receipt1,
					collection_note:
						"Duplicate collector delivery; same receipt, not additional content. / 収集側の重複配送。追加データではない。",
				},
			],
		},
	);
	const coverage = evidence(
		"T-COVERAGE",
		"telemetry-coverage.json",
		L(
			"観測できた時間と穴。記録がない理由が重要です。",
			"Observation coverage and gaps. Why a record is missing matters.",
		),
		{
			incident,
			object_access_complete_utc: [iso(0), iso(15)],
			outbound_receipts_complete_utc: [iso(0), iso(7)],
			outbound_gap_utc: [iso(7), iso(12)],
			gap_reason:
				"Receiver collector interrupted; only partial buffers recovered / 受信記録の収集停止、一部の記録だけ後から回収",
			host_capture: "not collected / 未収集",
			interpretation: {
				ja: "この演習では一致する受領記録は外部到達の証拠。読取だけでは外部到達とは言えない。収集停止中に記録がないことは、送信がなかった証明にはならない。",
				en: "In this exercise, matching receiver receipts demonstrate outside delivery. A read alone does not. Missing records during the collection outage do not prove that no transfer occurred.",
			},
		},
	);
	const timeline: PrivateCase = {
		id: "timeline",
		title: L(
			"02 何が、いつ、どこまで出た？",
			"02 What left, when, and how much?",
		),
		intro: L(
			"同じ session の後続操作を調べます。最初に timeline-audit.json の時刻と末尾の時差表記を見ます。UTC は世界共通の基準時刻。+09:00 はUTCより9時間進むので、UTCに直すには9時間引きます。例: 12:00+09:00 = 03:00Z。次に request_id（操作番号）と sha256（内容の指紋）で読取と外部受領を結びます。request_id と sha256 の両方が一致した記録だけを結びます。範囲 [0,3) は0から3の直前まで、3バイト。重なる部分は1回だけ数えます。例: [0,3) と [2,5) は全体で [0,5)、5バイト。データ流出は『外に届いた』こと。『読めた』『接続した』『記録がない』を同じ意味にしないでください。引用は結論を支える最小限のファイルを選びます。",
			"Investigate the same session's later actions. Start with the timestamps and time-zone suffixes in timeline-audit.json. UTC is the shared reference clock. +09:00 is nine hours ahead, so subtract nine hours: 12:00+09:00 = 03:00Z. Use request_id (operation identifier) and sha256 (content fingerprint) to join reads to outside receipts. Both request_id AND sha256 must match. Range [0,3) contains three bytes. Count overlapping parts only once: [0,3) and [2,5) together cover [0,5), five bytes. Exfiltration means data reached outside. Reading, connecting, and having no record do not mean the same thing. Cite the smallest sufficient file set.",
		),
		evidence: [audit, objectLog, network, coverage],
		questions: [
			q(
				"order",
				20,
				L(
					"最初のログイン、外部書き出し設定変更、最初の成功したファイル読取、最初の外部受領の event_id を、実際の時間が早い順に並べてください。3種類のログを引用。",
					"Order the event IDs for the initial login, export-setting change, first successful object read, and first outside receipt by actual time. Cite the three log sources.",
				),
				L(
					"event_id を半角カンマで区切る。例: E-a,E-b,E-c,E-d。ファイル内の表示順ではありません。",
					"Enter event IDs separated by commas, e.g. E-a,E-b,E-c,E-d. File display order is not event order.",
				),
				[ids.sign, ids.policy, ids.get, ids.send].join(","),
				["T-AUDIT", "T-OBJECT", "T-NET"],
				[
					L(
						"タイムラインは、別の場所の記録を共通の時計で並べたもの。時差付きの見かけの時刻だけで並べると前後を誤ります。",
						"A timeline orders records from different places using a common clock. Sorting the displayed local clock alone can reverse events.",
					),
					L(
						"例: 12:02+09:00 は03:02Z。03:04Zより2分早い。行が後に載っていても、時刻で並べます。",
						"Example: 12:02+09:00 is 03:02Z, two minutes before 03:04Z. Sort by time even if the row is listed later.",
					),
					L(
						"T-AUDIT の2件をUTCへ、T-OBJECT の status=200 で最も早い行をUTCへ、T-NET の最も早い受領をUTCへ直す。4件を並べ event_id を転記。この3つの証拠で送る。",
						"Convert the two T-AUDIT events, the earliest status=200 T-OBJECT read, and the earliest T-NET receipt to UTC. Sort the four event IDs and cite these three files.",
					),
				],
				L(
					"時差をそろえると、ログイン→設定変更→読取→外部受領です。収集された行の並びや、表示上の時刻だけに頼らず復元しました。",
					"After normalizing time zones: login → setting change → read → outside receipt. This reconstructs event order independently of file row order or local clock display.",
				),
			),
			q(
				"bytes",
				30,
				L(
					"外部に届いたと確認できる、重複しないファイル本体の合計は何バイトですか？ 操作番号と内容指紋の両方を照合し、同じ受領番号や重なる範囲は重ねて数えないでください。",
					"How many unique file-content bytes are demonstrably delivered outside? Match both operation IDs and content fingerprints, and count duplicated receipts or overlapping ranges only once.",
				),
				L(
					"単位やカンマを付けず整数のみ。例: 7。読取ログと受領ログを引用。",
					"Enter an integer without units or separators, e.g. 7. Cite the read log and receiver log.",
				),
				String(bytes1 + bytes2),
				["T-OBJECT", "T-NET"],
				[
					L(
						"送ったファイルの本体と、接続を維持する通信は別です。同じデータの記録が2回届いても、新しい内容が2回流出したとは数えません。",
						"File content differs from connection-control traffic. A duplicated observation does not count the same content as newly exposed twice.",
					),
					L(
						"例: [0,3) と [2,5) は1バイト重なるので3+3−1=5バイト。同じ行の再掲載も数えない。操作番号が同じでも内容指紋が違えば、そのファイルの受領と結べません。",
						"Example: [0,3) and [2,5) overlap by one byte, so 3+3−1=5. Do not count duplicated rows again. A matching operation ID with a different content fingerprint cannot establish delivery of that file.",
					),
					L(
						"T-NET の receipt_id を重複除外 → request_id と object_sha256 を T-OBJECT に一致させる → 同じファイルの範囲を start 順に並べ、重なる部分を1回にまとめる → 残った範囲の end−start を足す。connection_total_bytes は使わず、2ファイルを引用。",
						"Deduplicate T-NET receipt_id values → match request_id and object_sha256 to T-OBJECT → sort each file’s ranges by start, merge overlapping parts, then sum end−start of the remaining ranges. Do not use connection_total_bytes. Cite the two files.",
					),
				],
				L(
					"一致する受領範囲の本体だけを合算しました。重複記録・通信の制御部分・読めたが到達未確認のファイルは含めません。",
					"Only matching, unique received content ranges count. Duplicated records, protocol overhead, and objects read without proven outside delivery are excluded.",
				),
			),
			q(
				"scope",
				50,
				L(
					"全体の外部到達が確認できたファイルと、読取は成功したが外部到達を判断できないファイルを分けてください。記録の穴も考慮して、読取・受領・収集範囲を引用。",
					"Separate objects whose complete outside delivery is confirmed from successfully read objects whose delivery remains unresolved. Account for the logging gap; cite reads, receipts, and coverage.",
				),
				scopeFormat,
				`confirmed=${objects[0]},${objects[1]};unresolved=${objects[2]}`,
				["T-OBJECT", "T-NET", "T-COVERAGE"],
				[
					L(
						"調査の範囲は『確認済み』と『判断不能』を分けます。証拠のない断定は被害を小さくも大きくも見誤らせます。",
						"Scope separates confirmed observations from unresolved questions. Unsupported certainty can both understate and overstate harm.",
					),
					L(
						"例: Aは読取と完全な受領あり、Bは読取だけでその時間の受領ログが欠落。Aは確認済み、Bは不明。Bを『送っていない』とは言えません。",
						"Example: A has a read and complete receipt; B has a read during a receiver-log gap. A is confirmed; B is unresolved, not proven untransferred.",
					),
					L(
						"T-OBJECT で200の各 object を列挙 → T-NET で操作番号と内容指紋の両方が一致する範囲が全体を覆うか確認 → T-COVERAGE で残る読取時刻が穴に入るか調べる。指定形式で3ファイルを引用し送信。",
						"List status=200 objects in T-OBJECT → check whether T-NET ranges matching BOTH operation ID and content fingerprint cover each complete object → compare the remaining read time with T-COVERAGE's gap. Submit the requested format with all three files.",
					),
				],
				L(
					"2ファイルの全体は受領証拠で確認。別の成功読取は観測の穴と重なり、外部到達は不明です。403の拒否も『全て安全』の証拠にはなりません。",
					"Two complete objects are supported by receiver evidence. Another successful read overlaps the collection gap, so its outside delivery is unresolved. A denied request elsewhere does not prove everything remained safe.",
				),
			),
		],
	};
	const access = evidence(
		"B-ACCESS",
		"administrative-trust.json",
		L(
			"誰の権限で本番とバックアップを変えられるか。保存場所だけでなく管理の境界を見る。",
			"Who can change production and backups? Examine administrative boundaries, not location alone.",
		),
		{
			incident,
			glossary: {
				ja: "role=権限の組。principal=その権限を使う主体。delete=削除。isolated=同じ管理権限では操作できない分離。",
				en: "A role is a set of permissions; a principal uses them; delete removes data. Isolated means the same administrative authority cannot operate the copy.",
			},
			grants: [
				{
					role,
					resource: `production-${tag}`,
					actions: ["write", "delete", "change-permissions"],
				},
				{
					role,
					resource: `primary-backup-${tag}`,
					actions: ["delete", "disable-retention", "change-permissions"],
				},
				{
					role: `recovery-custodian-${tag}`,
					resource: `isolated-vault-${tag}`,
					actions: ["restore-with-separate-key"],
				},
			],
			separation: {
				vault: `isolated-vault-${tag}`,
				accepts_roles: [`recovery-custodian-${tag}`],
				explicitly_denies: [role],
				key_administrator: `offline-custodian-${tag}`,
				admin_export_complete: true,
			},
			note: {
				ja: "retention は消去を制限する保存期間。この一覧は事故時点の有効な権限を全て含む。この模型ではネットワークの距離だけでは分離にならない。",
				en: "Retention limits deletion during a holding period. This list contains all effective grants at incident time. Network distance alone is not administrative separation in this model.",
			},
		},
	);
	const backupAudit = evidence(
		"B-AUDIT",
		"damage-and-backup-audit.json",
		L(
			"最初の破壊とバックアップ削除を記録したログ。",
			"Audit of the first destructive write and backup deletion.",
		),
		{
			incident,
			events: [
				{
					time: iso(12),
					kind: "first_destructive_write",
					resource: `production-${tag}`,
					role,
					session,
					result: "success",
				},
				{
					time: iso(13),
					kind: "delete_backup",
					resource: `primary-backup-${tag}`,
					copy_id: copyNew,
					role,
					session,
					result: "success",
				},
				{
					time: iso(14),
					kind: "delete_backup",
					resource: `isolated-vault-${tag}`,
					copy_id: copySafe,
					role,
					session,
					result: "denied",
				},
			],
			scope: {
				ja: "この演習では本番の書込ログはこの時点まで完全で、first_destructive_write が最初の破壊的な書込。以降は変更を止めた。",
				en: "For this exercise, production-write logging is complete through this point; first_destructive_write is the first destructive write, after which ordinary writes were stopped.",
			},
		},
	);
	const catalog = evidence(
		"B-CATALOG",
		"backup-catalog.json",
		L(
			"復旧用コピーの時刻・場所・状態。新しさだけでは選ばない。",
			"Recovery copy times, locations, and status. Recency alone does not select a usable copy.",
		),
		{
			incident,
			glossary: {
				ja: "checkpoint_utc=コピーに含まれる最後の時点、available=保存物あり、manifest_sha256=内容の照合用指紋。",
				en: "checkpoint_utc is the last point included in a copy; available means stored data exists; manifest_sha256 is its comparison fingerprint.",
			},
			copies: [
				{
					copy_id: copyNew,
					checkpoint_utc: iso(10),
					location: `primary-backup-${tag}`,
					status: "deleted",
					manifest_sha256: hash("latest-" + tag),
				},
				{
					copy_id: copyBad,
					checkpoint_utc: iso(12 - loss + 3),
					location: `isolated-vault-${tag}`,
					status: "available",
					manifest_sha256: hash("locked-" + tag),
				},
				{
					copy_id: copySafe,
					checkpoint_utc: iso(12 - loss),
					location: `isolated-vault-${tag}`,
					status: "available",
					manifest_sha256: manifest,
				},
			],
			preservation: {
				ja: "調査開始時に読取専用で採取した一覧。残りの演習でコピーの内容は変化しない。",
				en: "Read-only inventory collected at investigation start. Copy contents do not change during the remaining exercise.",
			},
		},
	);
	const restore = evidence(
		"B-RESTORE",
		"isolated-restore-test.json",
		L(
			"分離した試験環境で実際に復元した結果。本番の切替結果とは区別。",
			"Actual restore results in an isolated test environment, distinct from production cutover.",
		),
		{
			incident,
			environment: `isolated-test-${tag}`,
			credentials: `recovery-custodian-${tag}`,
			glossary: {
				ja: "mounted=復元したコピーを読める保存場所として開けたこと。暗号化は内容を鍵なしでは読めない形にすること、復号鍵はそれを読める形に戻す鍵。cutover=利用者や業務の接続先を復旧したシステムへ切り替えること。database_check=保存データの構造確認。sample_record_check=一部の記録を使った内容確認。malware_indicator_scan=既知の悪い処理の痕跡を探す検査。",
				en: "mounted means the restored copy was opened as usable storage. Encryption encodes contents so they cannot be read without a key; a decryption key unlocks them. Cutover switches users or operations to the recovered system. database_check checks stored-data structure; sample_record_check checks a sample of records; malware_indicator_scan looks for known signs of malicious behavior.",
			},
			provenance: {
				ja: "既知の正常時に別の管理者が保全した内容指紋と照合した合成記録。",
				en: "Synthetic validation against content fingerprints preserved by an independent custodian at a known-clean point.",
			},
			tests: [
				{
					copy_id: copyBad,
					result: "failed",
					reason: "decryption key unavailable / 復号に必要な鍵がない",
					mounted: false,
				},
				{
					copy_id: copyNew,
					result: "failed",
					reason: "source deleted / 元のコピーは削除済み",
					mounted: false,
				},
				{
					copy_id: copySafe,
					result: "passed",
					mounted: true,
					restored_manifest_sha256: manifest,
					known_clean_manifest_sha256: manifest,
					database_check: "passed",
					sample_record_check: "passed",
					malware_indicator_scan: "no-known-indicator-found",
					decrypt_key_test: "passed",
				},
			],
			unperformed: [
				"production cutover / 本番への切替",
				"all business workflows / 全業務手順",
				"all user access / 全利用者のアクセス",
			],
			constraints: {
				ja: "試験の合格は列挙した確認だけ。未知の悪い処理が絶対ないとは保証しない。checkpoint後の書込を再現する記録は未入手。業務再開の責任者は本番確認後に判断する。",
				en: "A pass covers only the listed checks; it does not guarantee absence of unknown malicious behavior. Write-replay records after the checkpoint are not available. Business resumption requires the responsible owner's production validation.",
			},
		},
	);
	const recovery: PrivateCase = {
		id: "recovery",
		title: L(
			"03 バックアップがある。戻せる証拠は？",
			"03 A backup exists. What proves recovery?",
		),
		intro: L(
			"同じ session は本番データとバックアップにも触れました。最初に administrative-trust.json を開き、同じ role（権限の組）がどこまで操作できるか確かめます。バックアップは復元用の複製。場所が別でも同じ管理権限で消せれば、独立した安全策にはなりません。復旧は保存物があるだけでなく、読めて、正常だった内容と一致し、必要な業務が動くかの確認が必要です。checkpoint はコピーが含む最後の時点。復旧可能な最後の時点と破壊開始との差は、失う可能性のある更新の時間幅です。例: 03:01のコピー、03:04の破壊なら4−1=3分。これは実際の消失件数とは違います。",
			"The same session also reached production data and backups. Start with administrative-trust.json and check what each role (permission set) can control. A backup is a recovery copy. A different location is not an independent safeguard when the same administrator can delete both. Recovery needs evidence that a copy is readable, matches known-clean content, and supports the required business operations. A checkpoint is the last point included. The gap to the first destructive write is the window of potentially lost updates: a 03:01 copy and 03:04 damage give 4−1=3 minutes. That does not determine the actual number of lost records.",
		),
		evidence: [access, backupAudit, catalog, restore],
		questions: [
			q(
				"trust",
				20,
				L(
					"本番と主要バックアップの両方に破壊的操作ができ、実際にも使われた共通の role は何ですか？ 権限一覧と操作ログを引用。",
					"Which shared role could perform destructive actions on both production and the primary backup and was actually used? Cite grants and the action audit.",
				),
				L("role の値をそのまま入力。", "Enter the role value exactly."),
				role,
				["B-ACCESS", "B-AUDIT"],
				[
					L(
						"共通の管理権限が失われると、本番と複製が一緒に失われることがあります。コピーの数ではなく、誰が消せるかを調べます。",
						"Losing control of a shared administrator can compromise both live data and copies. Investigate who can delete them, not just how many copies exist.",
					),
					L(
						"例: 鍵Aが部屋1と予備品の部屋2を両方開けられるなら、鍵Aの紛失は両方に影響します。別の鍵Bだけの保管庫は違う境界です。",
						"Example: key A opens both room 1 and the spare-stock room 2. Losing A affects both. A vault opened only by independent key B has another boundary.",
					),
					L(
						"B-ACCESS の production と primary-backup の grants を比較し、write/delete を持つ共通 role を探す。B-AUDIT の成功した2操作に同じ role があるか確かめて、この2ファイルを引用。",
						"Compare production and primary-backup grants in B-ACCESS for the common write/delete role. Verify it on the two successful actions in B-AUDIT, then cite both.",
					),
				],
				L(
					"本番と主要バックアップは同じ管理権限を信頼していました。保管場所や『バックアップあり』という表示だけでは、この共通の弱点は消えません。",
					"Production and the primary backup relied on the same administrative authority. Storage location and an 'available backup' label do not remove that shared weakness.",
				),
			),
			q(
				"copy",
				30,
				L(
					"現在ある証拠で、独立した管理境界に残り、分離環境で既知の正常内容への復元まで確認できた copy_id はどれですか？ 権限・一覧・復元試験を引用。",
					"Which copy_id remains across an independent administrative boundary and has demonstrated restoration of known-clean content in isolation? Cite administrative grants, inventory, and restore tests.",
				),
				L(
					"copy_id をそのまま入力。新しさだけでは判定しません。",
					"Enter copy_id exactly. Recency alone is insufficient.",
				),
				copySafe,
				["B-ACCESS", "B-CATALOG", "B-RESTORE"],
				[
					L(
						"保存されていることと、復元できることは別です。暗号化された保存物は、読むための鍵がなければ使えません。独立した権限と試験結果も必要です。",
						"Stored data need not be restorable. Encrypted data is unusable without a working decryption key. Independent permissions and a restoration test also matter.",
					),
					L(
						"例: 新しいAは削除済み、Bは鍵がなく読めない、古いCは分離保管・鍵の確認・正常な内容との一致がある。この条件で使える候補は試験を通ったものです。",
						"Example: newer A is deleted, B lacks its key, and older C is separately administered with a working key and known-clean match. The evidence-supported candidate passes those checks.",
					),
					L(
						"B-CATALOG で available の候補を選ぶ → B-ACCESS でその場所が侵害された role を拒否するか確認 → B-RESTORE で mounted=true、鍵の試験、2つの指紋の一致を確かめる。3ファイルと copy_id を送る。",
						"Find available copies in B-CATALOG → confirm their location denies the compromised role in B-ACCESS → check mounted=true, key-test success, and matching fingerprints in B-RESTORE. Submit copy_id and all three files.",
					),
				],
				L(
					"より古くても、管理が分離され、鍵が使え、既知の正常内容との一致を実際に試せたコピーが復旧候補です。最新の表示やファイルの存在だけでは足りません。",
					"An older copy is the supported candidate when independently administered, decryptable, and actually restored against known-clean content. A recent timestamp or mere existence is insufficient.",
				),
			),
			q(
				"assurance",
				50,
				L(
					"この復旧候補の checkpoint から最初の破壊的書込まで、更新を失う可能性がある時間幅は何分ですか？ また、現在の試験だけで本番の業務再開が確認済みと言えますか？ 破壊ログ・コピー一覧・試験を引用。",
					"How many minutes separate the selected recovery checkpoint from the first destructive write, representing the potential update-loss window? Do existing tests establish that production business operations are ready? Cite damage audit, copy inventory, and tests.",
				),
				L(
					"loss_window_minutes=整数;production_ready=yes または loss_window_minutes=整数;production_ready=no。yes=本番確認済み、no=未確認。差は破壊時刻−checkpoint。",
					"Enter loss_window_minutes=integer;production_ready=yes or loss_window_minutes=integer;production_ready=no. yes means production validated; no means not validated. Subtract checkpoint time from damage time.",
				),
				`loss_window_minutes=${loss};production_ready=no`,
				["B-AUDIT", "B-CATALOG", "B-RESTORE"],
				[
					L(
						"復旧の根拠には『どの時点まで戻せるか』と『どこで何を試したか』の両方が必要です。試験用の環境で動いても、本番の切替や全ての業務は未確認かもしれません。",
						"Recovery assurance needs both the point recoverable and exactly where and what was tested. A working test environment does not by itself validate production cutover or every business workflow.",
					),
					L(
						"例: checkpoint が03:01、最初の破壊が03:04なら3分。この3分の更新が失われる可能性がある。試験が別環境の読取だけなら、本番再開は確認済みにはなりません。",
						"Example: a 03:01 checkpoint and 03:04 first damage leave a three-minute window of potentially lost updates. A read test in a separate environment alone does not establish production resumption.",
					),
					L(
						"B-RESTORE で合格した copy_id を B-CATALOG に結び checkpoint_utc を読む。B-AUDIT の first_destructive_write から引いて分にする。B-RESTORE の unperformed を見て本番確認の有無を判断。3ファイルと指定形式で送る。",
						"Join the passing B-RESTORE copy_id to B-CATALOG's checkpoint_utc. Subtract it from first_destructive_write in B-AUDIT and convert to minutes. Read unperformed in B-RESTORE to judge production validation. Submit the format and three citations.",
					),
				],
				L(
					"時間差は失う可能性がある更新の幅で、実際に失った件数ではありません。分離環境での復元は証明されても、本番切替・全業務・利用者アクセスは未試験です。正常なファイルがあることと業務復旧の完了を分けました。",
					"The time gap bounds potentially lost updates, not a confirmed record-loss count. Isolated restoration is demonstrated, while production cutover, full workflows, and user access remain untested. A clean file is not the same as completed business recovery.",
				),
			),
		],
	};
	return [identity, timeline, recovery, endpointCase(state, teamId, tag)];
}

/** Normalization accepts harmless spacing/case, not additional claims or substrings. */
export function canonicalAnswer(input: string): string {
	return input.trim().toLowerCase().replace(/\s+/g, "");
}
export function answerMatches(
	question: PrivateQuestion,
	input: string,
): boolean {
	const normalized = canonicalAnswer(input);
	if (question.id !== "scope")
		return normalized === canonicalAnswer(question.expected);
	const parseScope = (text: string) => {
		const match = /^confirmed=([^;]+);unresolved=([^;]+)$/.exec(text);
		if (!match) return "";
		const confirmed = match[1]!.split(",");
		if (confirmed.length < 1 || new Set(confirmed).size !== confirmed.length)
			return "";
		return `confirmed=${confirmed.sort().join(",")};unresolved=${match[2]}`;
	};
	return (
		parseScope(normalized) !== "" &&
		parseScope(normalized) === parseScope(canonicalAnswer(question.expected))
	);
}
