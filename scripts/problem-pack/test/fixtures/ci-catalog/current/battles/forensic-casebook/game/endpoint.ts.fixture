/** Server-only, data-only endpoint simulation. No OS, process or network actions. */
import { evidence, L, q, type PrivateCase } from "./fixtures.ts";
import type { State } from "./types.ts";

export function endpointCase(state: Partial<Pick<State, "teams">>, teamId: string, tag: string): PrivateCase {
  const suspect = `task-${tag}-cache`;
  const normal = `task-${tag}-vendor`;
  const unknown = `helper-${tag}`;
  const solved = (id: string) => !!state.teams?.[teamId]?.progress[`endpoint/${id}`]?.solved;
  const inventory = evidence("E-INVENTORY", "endpoint-inventory.json", L("端末の合成一覧。task は決まった時にプログラムを動かす設定。", "Synthetic inventory. A task is a setting that runs a program at a scheduled time."), {
    glossary: { ja: "target=動かす対象、publisher=発行元、hash=内容の指紋、trigger=動くきっかけ。永続化は再起動後も動く仕組み。", en: "target names the program; publisher identifies its issuer; hash is a content fingerprint; trigger is when it runs. Persistence means it can run again after restart." },
    tasks: [
      { id: normal, target: "vendor-update", path: "vendor/Updater", publisher: "Aster Tools", hash: `approved-${tag}`, trigger: "daily", enabled: true },
      { id: suspect, target: "cache-update", path: "user/cache/Updater", publisher: "unknown", hash: `unlisted-${tag}`, trigger: "login", enabled: true },
    ],
    unresolved_object: unknown,
  });
  const approval = evidence("E-APPROVAL", "endpoint-approval.json", L("承認された更新と調査範囲。名前だけで判定しない。", "Approved updates and collection limits. Names alone are insufficient."), {
    approved: { task: normal, path: "vendor/Updater", publisher: "Aster Tools", hash: `approved-${tag}`, destination: "updates.aster.example" },
    unapproved_hashes: [`unlisted-${tag}`],
    limits: { ja: `${unknown} は内容と実行記録を未収集。無害とも不審とも断定できない。実端末の感染除去は未確認。`, en: `${unknown} has no collected content or execution records. Neither safe nor suspicious is established. Real endpoint eradication is untested.` },
  });
  const history = evidence("E-HISTORY", "endpoint-history.json", L("同じ対象を結ぶ削除・再起動・書き直しの記録。", "Deletion, restart and rewrite records linked by target."), {
    events: [
      { sequence: 1, action: "delete-file", target: "cache-update" },
      { sequence: 2, action: "simulated-reboot" },
      { sequence: 3, action: "recreate-file", task: suspect, target: "cache-update", hash: `unlisted-${tag}` },
      { sequence: 4, action: "update-success", task: normal, target: "vendor-update", destination: "updates.aster.example" },
    ],
  });
  const plan = evidence("E-PLAN", "simulation-policy.json", L("模擬対処の入力規則。現実のOSや通信は操作しません。", "Input rules for simulated response. No real OS or network is operated."), {
    scope: "data-only simulation; no malware, credentials, external traffic or real persistence settings",
    preservation: { ja: "snapshot は一覧・承認・履歴の元内容とSHA-256を変更前に模擬保管する。実ファイル保存は証拠ダウンロードで行える。", en: "snapshot retains original inventory, approval and history content with SHA-256 in simulated custody before changes. Use evidence downloads for actual local copies." },
    commands: ["snapshot", "disable=TASK;quarantine=TARGET;block=TARGET", "restore=TARGET;keep=TASK", "reboot"],
    rules: { ja: "設問順に解く。封じ込めは再実行設定を止め、対象ファイルを隔離（使えない別置きにする）、その対象の通信だけを止める。復旧は承認済みの更新対象を確認し維持する。正常対象の削除・全通信停止・ファイル削除だけの対処は不合格。最後に模擬再起動して新しい観測を読む。", en: "Complete questions in order. Containment disables the recurring task, quarantines its file (moves it out of use), and blocks only that target's traffic. Recovery verifies and retains the approved updater. Removing normal objects, blocking all traffic, or only deleting the file fails. Finally simulate restart and read fresh observations." },
  });
  const preserved = [inventory, approval, history];
  const observation = evidence("E-OBSERVATION", "simulation-observation.json", L("模擬状態と保全受付。実端末の修復完了表示ではありません。", "Simulated state and custody receipt. This is not a real endpoint repair report."), {
    scope: "simulation-only",
    custody: solved("preserve") ? preserved.map((file) => ({ id: file.id, sha256: file.sha256, original_content: file.content, before_change: true })) : [],
    task_enabled: { [suspect]: !solved("contain"), [normal]: true },
    quarantined_targets: solved("contain") ? ["cache-update"] : [],
    blocked_targets: solved("contain") ? ["cache-update"] : [],
    restored_approved_hash: solved("restore") ? `approved-${tag}` : null,
    reboot_count: solved("reboot") ? 1 : 0,
    post_reboot: solved("reboot") ? { recreated: [], suspect_execution_count: 0, normal_update: "success", destination: "updates.aster.example", window: "one simulated login and scheduled update; longer-term and real OS behavior unobserved" } : null,
  });
  const hintGuide: Record<string, [ReturnType<typeof L>, ReturnType<typeof L>, ReturnType<typeof L>]> = {
    diagnose: [L("永続化は、消したファイルを別の設定が再び動かす仕組みです。承認された更新とは対象と内容で区別します。", "Persistence can let another setting recreate a deleted program. Distinguish approved updates by target and content."), L("例：設定Aが消したBを書き直し、Bの指紋が承認一覧にない。一方Cは承認と一致する。この場合、名前が同じでもAとCを分けます。", "Example: task A recreates deleted B, whose fingerprint is unapproved; C matches approval. Separate A from C even if names resemble each other."), L(`E-HISTORY の recreate-file を E-INVENTORY の task と結び、E-APPROVAL の unapproved_hashes を確認。不明対象は limits と unresolved_object を読む。suspect=${suspect};unknown=${unknown} と3記録を送る。`, `Join recreate-file in E-HISTORY to the task in E-INVENTORY; check unapproved_hashes in E-APPROVAL. Read limits and unresolved_object. Submit suspect=${suspect};unknown=${unknown} with those three records.`)],
    preserve: [L("証拠保全は、変更前の記録を後から比較できる形で残すことです。指紋だけでなく元内容も必要です。", "Preservation retains pre-change records for later comparison. Keep original content as well as fingerprints."), L("例：元記録Aをコピーし指紋Hを添える。変更後Bと違ってもAを再確認できます。", "Example: copy original A with fingerprint H. Even after changes produce B, A remains available for comparison."), L("E-PLAN の preservation を読む。snapshot と、E-INVENTORY・E-APPROVAL・E-HISTORY・E-PLAN を送る。受付は E-OBSERVATION に出ます。", "Read preservation in E-PLAN. Submit snapshot with E-INVENTORY, E-APPROVAL, E-HISTORY and E-PLAN. Find the receipt in E-OBSERVATION.")],
    contain: [L("封じ込めは不審な動作を止めることです。再実行設定・対象ファイル・対象の通信を結んで絞ります。", "Containment stops suspicious activity. Link and target its recurring task, file and traffic."), L("例：AがBを戻すならAを止め、Bを隔離しBだけ通信停止。正常Cは維持します。", "Example: if A recreates B, disable A, quarantine B and block only B. Retain normal C."), L(`一覧・承認・履歴・規則を確認し、disable=${suspect};quarantine=cache-update;block=cache-update と E-INVENTORY・E-APPROVAL・E-HISTORY・E-PLAN を送る。`, `Check inventory, approval, history and policy. Submit disable=${suspect};quarantine=cache-update;block=cache-update with E-INVENTORY, E-APPROVAL, E-HISTORY and E-PLAN.`)],
    restore: [L("復旧は必要な正常機能を使える状態にすること。更新の対象と承認された設定を一致させます。", "Recovery restores needed normal function. Match the updater target to its approved task."), L("例：承認記録に対象C・設定Dなら、Cを戻しDを維持します。不審Bは戻しません。", "Example: if approval identifies target C and task D, restore C and retain D. Do not restore suspicious B."), L(`E-INVENTORY と E-APPROVAL の一致を確認。restore=vendor-update;keep=${normal} と E-INVENTORY・E-APPROVAL・E-PLAN を送る。`, `Match E-INVENTORY to E-APPROVAL. Submit restore=vendor-update;keep=${normal} with E-INVENTORY, E-APPROVAL and E-PLAN.`)],
    reboot: [L("再起動後の確認で、対処後も再実行設定が働くか観測します。この演習ではデータだけの再起動です。", "Post-restart checks observe whether recurrence survives response. Here restart operates only on data."), L("例：対処前は1回の再起動でBが戻った。対処後も同じきっかけで試してから比較します。", "Example: B returned after one restart before response. Test the same trigger after response before comparing."), L("E-OBSERVATION の状態と E-PLAN の規則を確認し、reboot と両記録を送る。新しい post_reboot を開く。", "Read state in E-OBSERVATION and rules in E-PLAN. Submit reboot with both records. Open the new post_reboot observation.")],
    assessment: [L("成功の判断には、不審な再発がないことと正常機能が動くことの両方が必要です。観測した範囲を超えないでください。", "Success requires both absent suspicious recurrence and working normal function. Stay within the observed scope."), L("例：1回の試験でBなし、C成功なら、その試験範囲の成功です。実機や翌日の安全までは言えません。", "Example: no B and successful C in one test establishes that test's outcome, not real-device or next-day safety."), L("E-OBSERVATION の recreated と normal_update を読み、正常対象を E-APPROVAL と照合。recurrence=no;normal=yes;scope=simulation と両記録を送る。", "Read recreated and normal_update in E-OBSERVATION; compare normal activity with E-APPROVAL. Submit recurrence=no;normal=yes;scope=simulation with both records.")],
  };
  const question = (id: string, points: number, prompt: ReturnType<typeof L>, format: ReturnType<typeof L>, expected: string, citations: string[], reason: ReturnType<typeof L>) => q(id, points, prompt, format, expected, citations, hintGuide[id]!, reason);
  return {
    id: "endpoint", title: L("04 消した更新ツールが戻ってくる", "04 The deleted updater returns"),
    intro: L("あなたは架空の端末の調査担当です。消した更新ツールが次のログインで戻りました。最初に endpoint-inventory.json を開き、どの設定が何を動かすか確認してください。承認と履歴を結び、正常な更新を残して対処します。回答と根拠がそろうと模擬状態が進み、simulation-observation.json が変わります。設問順に診断→証拠保全→封じ込め→復旧→模擬再起動→観測の評価を進めます。根拠不足や順序違いは点数も状態も進みません。これは合成データだけの練習で、実端末の修復ではありません。チームの得点は個人の認定ではありません。", "You investigate a fictional endpoint. A deleted updater returned at the next login. First open endpoint-inventory.json and check which task runs which target. Join approval and history, retaining normal updates. Correct answers with evidence advance simulated state and change simulation-observation.json. Work in order: diagnose, preserve, contain, recover, simulate restart, assess observations. Insufficient evidence or out-of-order answers advance neither score nor state. This is synthetic practice, not real endpoint repair. Team points are not individual certification."),
    evidence: [inventory, approval, history, plan, observation],
    questions: [
      question("diagnose",20,L("再発を起こす不審な設定と、判断できない対象を区別してください。", "Identify the suspicious recurring task and the object whose status remains unknown."),L("suspect=TASK;unknown=OBJECT（TASKとOBJECTは記録のID）", "suspect=TASK;unknown=OBJECT (use record IDs)"),`suspect=${suspect};unknown=${unknown}`,["E-INVENTORY","E-APPROVAL","E-HISTORY"],L("未承認の内容と実行の連鎖が判断の根拠です。観測のないhelperを断定しません。", "Unapproved content and the execution chain support the finding. Do not classify an unobserved helper.")),
      question("preserve",10,L("変更前の証拠を模擬保管してください。", "Retain evidence in simulated custody before changes."),L("snapshot と入力。保管対象の3記録と規則を引用。", "Enter snapshot. Cite the three retained records and policy."),"snapshot",["E-INVENTORY","E-APPROVAL","E-HISTORY","E-PLAN"],L("元内容と指紋を受付に残しました。指紋は内容比較用で、真正性の保証ではありません。", "Original content and fingerprints are retained in the receipt. Fingerprints compare content; they do not establish authenticity.")),
      question("contain",20,L("再発元と対象に絞って模擬封じ込めしてください。", "Simulate containment of the recurring task and its target only."),L("disable=TASK;quarantine=TARGET;block=TARGET", "disable=TASK;quarantine=TARGET;block=TARGET"),`disable=${suspect};quarantine=cache-update;block=cache-update`,["E-INVENTORY","E-APPROVAL","E-HISTORY","E-PLAN"],L("再実行設定と対象だけを止めました。正常な更新や全通信を止める対処では業務を守れません。", "Only the recurring task and its target are contained. Removing normal updates or stopping all traffic fails to preserve business function.")),
      question("restore",20,L("承認済み更新を模擬復旧し、残す設定を指定してください。", "Simulate recovery of the approved updater and identify the task to retain."),L("restore=TARGET;keep=TASK", "restore=TARGET;keep=TASK"),`restore=vendor-update;keep=${normal}`,["E-INVENTORY","E-APPROVAL","E-PLAN"],L("承認記録と一致する更新対象を維持しました。再起動後の観測はまだありません。", "The updater matching approval is retained. Post-restart observation is still pending.")),
      question("reboot",0,L("模擬再起動し、新しい観測を生成してください。", "Simulate restart to generate fresh observations."),L("reboot と入力。模擬状態と規則を引用。", "Enter reboot. Cite simulated state and policy."),"reboot",["E-OBSERVATION","E-PLAN"],L("模擬再起動を1回実行しました。新しい観測を読み、結論を確かめてください。", "One simulated restart ran. Read the fresh observations before concluding.")),
      question("assessment",30,L("再発と正常な更新を確認した範囲を報告してください。", "Report the observed recurrence and normal-update status, within the observation limits."),L("recurrence=yes/no;normal=yes/no;scope=simulation（yes=観測あり、no=観測なし）", "recurrence=yes/no;normal=yes/no;scope=simulation (yes=observed, no=not observed)"),"recurrence=no;normal=yes;scope=simulation",["E-OBSERVATION","E-APPROVAL"],L("1回の模擬再起動では再発なし、正常更新は成功。長期・実OSの感染除去は証明していません。チーム結果から個人能力は認定しません。", "No recurrence and successful approved update in one simulated restart. Longer-term or real OS eradication is not demonstrated. Team results do not certify individual ability.")),
    ],
  };
}
